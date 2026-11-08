import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import ts from 'typescript';

// Load the browser TypeScript modules without introducing a test bundler dependency.
const modules = new Map();
function moduleUrl(file) {
  file = resolve(file);
  if (modules.has(file)) return modules.get(file);
  let code = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  code = code.replace(/from ['"](.\/.+?)['"]/g, (_, path) =>
    `from '${moduleUrl(resolve(dirname(file), `${path}.ts`))}'`);
  const url = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  modules.set(file, url);
  return url;
}
const { CanvasTerminalRenderer } = await import(moduleUrl('src/renderer.ts'));
const { WebGpuTerminalRenderer } = await import(moduleUrl('src/webgpu-renderer.ts'));

function canvas() {
  const fills = [];
  const ctx = {
    setTransform() {}, scale() {}, save() {}, restore() {}, clearRect() {}, fillText() {},
    fillRect(...rect) { fills.push(rect); },
  };
  return { width: 960, height: 576, style: {}, fills, ctx,
    getContext: () => ctx,
    getBoundingClientRect() {
      return { left: 17, top: 29, width: parseFloat(this.style.width), height: parseFloat(this.style.height) };
    },
  };
}

function gpu() {
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2, VERTEX: 4 };
  globalThis.GPUTextureUsage = { TEXTURE_BINDING: 1, COPY_DST: 2, RENDER_ATTACHMENT: 4 };
  globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };
  globalThis.document = { createElement: canvas };
  const textures = [];
  const device = {
    limits: { maxTextureDimension2D: 8192 },
    createTexture(desc) {
      assert.ok(desc.size[0] <= 8192 && desc.size[1] <= 8192);
      const texture = { desc, destroy() {}, createView() { return {}; } };
      textures.push(texture);
      return texture;
    },
    queue: { copyExternalImageToTexture(_source, dest, size) {
      assert.ok(dest.origin[0] + size[0] <= dest.texture.desc.size[0]);
      assert.ok(dest.origin[1] + size[1] <= dest.texture.desc.size[1]);
    } },
  };
  for (const method of ['createShaderModule', 'createBuffer', 'createSampler',
    'createBindGroupLayout', 'createPipelineLayout', 'createRenderPipeline', 'createBindGroup']) {
    device[method] = () => ({});
  }
  const surface = canvas();
  const renderer = new WebGpuTerminalRenderer(surface, device, { configure() {} }, 'bgra8unorm');
  return { renderer, surface, textures };
}

test('both renderers map displayed coordinates across scale and DPR changes', () => {
  globalThis.window = { devicePixelRatio: 1 };
  const surface = canvas();
  const renderers = [{ renderer: new CanvasTerminalRenderer(surface), surface }, gpu()];
  for (const { renderer, surface } of renderers) {
    for (const dpr of [1, 1.25, 2]) {
      window.devicePixelRatio = dpr;
      for (const scale of [0.35, 0.417, 1, 1.75, 3.8]) {
        renderer.resize(scale);
        assert.equal(surface.width, Math.round(960 * scale * dpr));
        assert.equal(surface.height, Math.round(576 * scale * dpr));
        for (const [col, row] of [[0, 0], [39, 11], [79, 23]]) {
          assert.deepEqual(renderer.clientPointToCell(
            17 + (col + 0.5) * 12 * scale, 29 + (row + 0.5) * 24 * scale), { col, row });
        }
        assert.deepEqual(renderer.clientPointToCell(-100, -100), { col: 0, row: 0 });
        assert.deepEqual(renderer.clientPointToCell(1e6, 1e6), { col: 79, row: 23 });
      }
    }
  }
});

test('Canvas2D initializes baseline and snaps neighboring blocks to shared physical edges', () => {
  window.devicePixelRatio = 1;
  const surface = canvas();
  const renderer = new CanvasTerminalRenderer(surface);
  assert.equal(surface.ctx.textBaseline, 'middle');
  renderer.resize(0.417);
  renderer.fillRect(0, 0, 12, 24);
  renderer.fillRect(12, 0, 12, 24);
  const [a, b] = surface.fills;
  assert.equal(a[0] + a[2], b[0]);
  assert.ok(Math.abs(b[0] * surface.width / 960 - Math.round(b[0] * surface.width / 960)) < 1e-9);
});

test('WebGPU reuses unchanged targets and preserves layout scale when DPR changes', () => {
  window.devicePixelRatio = 1;
  const { renderer, surface, textures } = gpu();
  renderer.resize(2.5);
  const count = textures.length;
  renderer.resize();
  assert.equal(textures.length, count);
  window.devicePixelRatio = 2;
  renderer.resize();
  assert.equal(surface.style.width, '2400px');
  assert.equal(surface.width, 4800);
  assert.equal(renderer.deviceDpr, 2);
  renderer.resize(100);
  assert.ok(surface.width <= 8192);
});

test('WebGPU packs full frames and evicts before emitting UVs, including at 4K/DPR 2', () => {
  window.devicePixelRatio = 2;
  const { renderer } = gpu();
  for (const scale of [0.4, 1, 3.9]) {
    renderer.resize(scale);
    assert.equal(renderer.canvas.width, Math.round(960 * scale * 2));
    for (let page = 0; page < 5; page++) {
      const glyphs = Array.from({ length: page % 2 ? 960 : 1920 }, (_, i) => ({
        text: String.fromCodePoint(0x4e00 + page * 1920 + i), flags: 0, w: page % 2 ? 24 : 12,
      }));
      renderer.prepareAtlas({ glyphs });
      let clearCount = 0;
      const clear = renderer.clearAtlas.bind(renderer);
      renderer.clearAtlas = () => { clearCount++; clear(); };
      for (const item of glyphs) renderer.getOrRasterizeGlyph(item.text, item.flags, item.w);
      assert.equal(clearCount, 0, 'atlas must not evict UVs during frame construction');
      renderer.clearAtlas = clear;
    }
  }
});
