import { clientPointToCell, LOGICAL_W, LOGICAL_H } from './terminal-layout';
import {
  CELL_H,
  CELL_W,
  COLS,
  FONT_FAMILY,
  FONT_SIZE,
  ROWS,
  STYLE_FLAG_BOLD,
  STYLE_FLAG_ITALIC,
  STYLE_FLAG_STRIKETHROUGH,
  STYLE_UNDERLINE_MASK,
  STYLE_UNDERLINE_SHIFT,
  type RgbTuple,
} from './constants';
import type { TerminalFrameSnapshot } from './ghostty-wasm';
import type { RenderMetrics, TerminalRenderer } from './renderer';

const ATLAS_SIZE = 2048;
const MAX_INSTANCES = 8192;
const FLOATS_PER_INSTANCE = 16; // 64 bytes per instance (16-byte aligned)

const enum QuadKind {
  Solid = 0,
  AtlasGlyph = 1,
  CustomBlock = 2,
}

interface AtlasEntry {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  pw: number;
  ph: number;
}

const WGSL_SHADER = /* wgsl */ `
struct Globals {
  screenSize: vec2<f32>,
  crtEnabled: f32,
  time: f32,
};

@group(0) @binding(0) var<uniform> globals: Globals;
@group(0) @binding(1) var glyphAtlas: texture_2d<f32>;
@group(0) @binding(2) var glyphSampler: sampler;

struct InstanceInput {
  @location(0) rect: vec4<f32>,     // x, y, w, h in physical pixels
  @location(1) uvRect: vec4<f32>,   // u0, v0, u1, v1 in [0..1]
  @location(2) color: vec4<f32>,    // r, g, b, a in [0..1]
  @location(3) kind: f32,           // 0 = Solid, 1 = AtlasGlyph, 2 = CustomBlock
  @location(4) codepoint: f32,      // Unicode codepoint for CustomBlock
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) localPos: vec2<f32>, // normalized [0..1] within the quad
  @location(2) color: vec4<f32>,
  @location(3) @interpolate(flat) kind: u32,
  @location(4) @interpolate(flat) codepoint: u32,
};

@vertex
fn vs_main(
  @builtin(vertex_index) vertexIndex: u32,
  inst: InstanceInput
) -> VertexOutput {
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0),
    vec2<f32>(1.0, 0.0),
    vec2<f32>(0.0, 1.0),
    vec2<f32>(0.0, 1.0),
    vec2<f32>(1.0, 0.0),
    vec2<f32>(1.0, 1.0)
  );

  let corner = corners[vertexIndex];
  let pixelPos = inst.rect.xy + corner * inst.rect.zw;

  // Convert physical pixel coordinates (top-left origin) to NDC [-1..1]
  let ndc = vec2<f32>(
    (pixelPos.x / globals.screenSize.x) * 2.0 - 1.0,
    1.0 - (pixelPos.y / globals.screenSize.y) * 2.0
  );

  var out: VertexOutput;
  out.position = vec4<f32>(ndc, 0.0, 1.0);
  out.uv = mix(inst.uvRect.xy, inst.uvRect.zw, corner);
  out.localPos = corner;
  out.color = inst.color;
  out.kind = u32(inst.kind + 0.5);
  out.codepoint = u32(inst.codepoint + 0.5);
  return out;
}

fn evalCustomBlock(cp: u32, p: vec2<f32>) -> f32 {
  // Lower 1/8 .. 8/8 blocks: U+2581 (▁) .. U+2588 (█)
  if (cp >= 0x2581u && cp <= 0x2588u) {
    let eighths = f32(cp - 0x2580u) / 8.0;
    return select(0.0, 1.0, p.y >= (1.0 - eighths));
  }

  // Left 7/8 .. 1/8 blocks: U+2589 (▉) .. U+258F (▏)
  if (cp >= 0x2589u && cp <= 0x258Fu) {
    let eighths = f32(8u - (cp - 0x2588u)) / 8.0;
    return select(0.0, 1.0, p.x <= eighths);
  }

  // Right half block: U+2590 (▐)
  if (cp == 0x2590u) {
    return select(0.0, 1.0, p.x >= 0.5);
  }

  // Upper 1/8 block: U+2594 (▔)
  if (cp == 0x2594u) {
    return select(0.0, 1.0, p.y <= 0.125);
  }

  // Right 1/8 block: U+2595 (▕)
  if (cp == 0x2595u) {
    return select(0.0, 1.0, p.x >= 0.875);
  }

  // Corner triangles with smooth 1px edge anti-aliasing:
  // U+25E2 (◢), U+25E3 (◣), U+25E4 (◤), U+25E5 (◥)
  let aa = 0.025;
  if (cp == 0x25E2u) {
    // ◢ Lower-right: x + y >= 1.0
    return smoothstep(1.0 - aa, 1.0 + aa, p.x + p.y);
  }
  if (cp == 0x25E3u) {
    // ◣ Lower-left: y >= x
    return smoothstep(-aa, aa, p.y - p.x);
  }
  if (cp == 0x25E4u) {
    // ◤ Upper-left: x + y <= 1.0
    return 1.0 - smoothstep(1.0 - aa, 1.0 + aa, p.x + p.y);
  }
  if (cp == 0x25E5u) {
    // ◥ Upper-right: x >= y
    return smoothstep(-aa, aa, p.x - p.y);
  }

  return 0.0;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let sample = textureSample(glyphAtlas, glyphSampler, in.uv);

  if (in.kind == 0u) {
    return in.color;
  }

  if (in.kind == 1u) {
    if (sample.a <= 0.01) {
      discard;
    }
    // Gamma-corrected alpha (stem darkening compensation for transparent-canvas glyph masks on dark backgrounds)
    let crispAlpha = pow(sample.a, 0.72) * in.color.a;
    return vec4<f32>(in.color.rgb, crispAlpha);
  }

  // kind == 2u: Analytical block / triangle glyph
  let coverage = evalCustomBlock(in.codepoint, in.localPos);
  let alpha = coverage * in.color.a;
  if (alpha <= 0.01) {
    discard;
  }
  return vec4<f32>(in.color.rgb, alpha);
}

// Pass 2: Fullscreen CRT Post-Process
struct PostVertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_post(@builtin(vertex_index) vertexIndex: u32) -> PostVertexOutput {
  var pos = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>( 1.0,  1.0)
  );
  let p = pos[vertexIndex];
  var out: PostVertexOutput;
  out.position = vec4<f32>(p, 0.0, 1.0);
  out.uv = vec2<f32>((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
  return out;
}

@group(0) @binding(0) var<uniform> postGlobals: Globals;
@group(0) @binding(1) var frameTex: texture_2d<f32>;
@group(0) @binding(2) var frameSampler: sampler;

fn warpCrtUv(uv: vec2<f32>) -> vec2<f32> {
  let centered = uv * 2.0 - 1.0;
  let offset = centered.yx / vec2<f32>(6.5, 5.5);
  let warped = centered + centered * offset * offset;
  return warped * 0.5 + 0.5;
}

@fragment
fn fs_post(in: PostVertexOutput) -> @location(0) vec4<f32> {
  let uv = warpCrtUv(in.uv);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    return vec4<f32>(0.02, 0.02, 0.03, 1.0);
  }

  // Subtle RGB chromatic aberration + phosphor bloom sample
  let shift = vec2<f32>(0.0007, 0.0);
  let r = textureSampleLevel(frameTex, frameSampler, uv + shift, 0.0).r;
  let g = textureSampleLevel(frameTex, frameSampler, uv, 0.0).g;
  let b = textureSampleLevel(frameTex, frameSampler, uv - shift, 0.0).b;
  var col = vec3<f32>(r, g, b);

  // Neighbor glow (phosphor halation)
  let texel = 1.0 / postGlobals.screenSize;
  let glow = (
    textureSampleLevel(frameTex, frameSampler, uv + vec2<f32>(texel.x, 0.0), 0.0).rgb +
    textureSampleLevel(frameTex, frameSampler, uv - vec2<f32>(texel.x, 0.0), 0.0).rgb +
    textureSampleLevel(frameTex, frameSampler, uv + vec2<f32>(0.0, texel.y), 0.0).rgb +
    textureSampleLevel(frameTex, frameSampler, uv - vec2<f32>(0.0, texel.y), 0.0).rgb
  ) * 0.25;
  col = col + glow * 0.22;

  // Horizontal scanlines
  let scanline = sin(uv.y * 576.0 * 3.14159265);
  let scanFactor = 0.90 + 0.10 * (scanline * scanline);
  col = col * scanFactor;

  // Corner vignette
  let vigUv = uv * (1.0 - uv.yx);
  let vig = clamp(pow(vigUv.x * vigUv.y * 16.0, 0.18), 0.0, 1.0);
  col = col * vig;

  return vec4<f32>(col, 1.0);
}
`;

function isCustomBlockCodepoint(cp: number): boolean {
  return (
    (cp >= 0x2581 && cp <= 0x2590) ||
    cp === 0x2594 ||
    cp === 0x2595 ||
    (cp >= 0x25e2 && cp <= 0x25e5)
  );
}

/**
 * Ghostty-style Native WebGPU Instanced Terminal Renderer.
 *
 * Architecture:
 * - Physical-pixel snapped coordinates (`Math.round(pos * dpr)`) with 1:1 nearest-neighbor
 *   glyph atlas texel mapping so CJK and ASCII text is razor-sharp with zero bilinear blur.
 * - Direct single-pass swapchain rendering when CRT mode is off; 2-pass offscreen + CRT
 *   post-processing shader when CRT mode is enabled.
 */
export class WebGpuTerminalRenderer implements TerminalRenderer {
  public readonly backendName = 'WebGPU';
  private readonly canvas: HTMLCanvasElement;
  private readonly device: GPUDevice;
  private readonly context: GPUCanvasContext;
  private readonly format: GPUTextureFormat;
  private readonly bindGroupLayout: GPUBindGroupLayout;

  private readonly cellPipeline: GPURenderPipeline;
  private readonly postPipeline: GPURenderPipeline;
  private readonly globalsBuffer: GPUBuffer;
  private readonly instanceBuffer: GPUBuffer;
  private readonly instanceData = new Float32Array(
    MAX_INSTANCES * FLOATS_PER_INSTANCE
  );
  private instanceCount = 0;

  private atlasTexture: GPUTexture;
  private readonly nearestSampler: GPUSampler;
  private readonly linearSampler: GPUSampler;
  private cellBindGroup: GPUBindGroup;

  private offscreenTexture: GPUTexture | null = null;
  private offscreenView: GPUTextureView | null = null;
  private postBindGroup: GPUBindGroup | null = null;

  // Dynamic CJK Glyph Rasterizer
  private readonly glyphCanvas: HTMLCanvasElement;
  private readonly glyphCtx: CanvasRenderingContext2D;
  private readonly atlasCache = new Map<string, AtlasEntry>();
  private atlasCursorX = 0;
  private atlasCursorY = 0;
  private atlasRowHeight = 0;
  // dpr is the effective number of physical pixels per logical pixel.
  private dpr = 1;
  private deviceDpr = 1;
  private scale = 1;
  private atlasSize = ATLAS_SIZE;
  private physW = LOGICAL_W;
  private physH = LOGICAL_H;
  private crtEnabled = false;
  private readonly startTime = performance.now();

  private lastFrameTimeMs = 0;
  private avgFrameTimeMs = 0;
  private frameCount = 0;
  private lastFpsTimestamp = performance.now();
  private currentFps = 0;
  private lastRenderTimestamp = 0;

  public static async create(
    canvas: HTMLCanvasElement
  ): Promise<WebGpuTerminalRenderer | null> {
    if (typeof navigator === 'undefined' || !navigator.gpu) {
      return null;
    }

    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        return null;
      }

      const device = await adapter.requestDevice();
      const context = canvas.getContext('webgpu');
      if (!context) {
        return null;
      }

      const format = navigator.gpu.getPreferredCanvasFormat();
      return new WebGpuTerminalRenderer(canvas, device, context, format);
    } catch (err) {
      console.warn('WebGPU initialization failed, falling back to Canvas 2D:', err);
      return null;
    }
  }

  private constructor(
    canvas: HTMLCanvasElement,
    device: GPUDevice,
    context: GPUCanvasContext,
    format: GPUTextureFormat
  ) {
    this.canvas = canvas;
    this.device = device;
    this.context = context;
    this.format = format;

    this.glyphCanvas = document.createElement('canvas');
    const gCtx = this.glyphCanvas.getContext('2d', { willReadFrequently: false });
    if (!gCtx) {
      throw new Error('Failed to create offscreen 2D context for glyph rasterization');
    }
    this.glyphCtx = gCtx;

    const shaderModule = device.createShaderModule({
      label: 'GhosPTT WebGPU Shader',
      code: WGSL_SHADER,
    });

    this.globalsBuffer = device.createBuffer({
      label: 'Globals Uniform Buffer',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.instanceBuffer = device.createBuffer({
      label: 'Cell Instance Buffer',
      size: this.instanceData.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    this.atlasTexture = device.createTexture({
      label: 'Dynamic CJK Glyph Atlas',
      size: [ATLAS_SIZE, ATLAS_SIZE, 1],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });

    // Nearest sampler for 1:1 physical-pixel glyph atlas lookups (eliminates bilinear blur)
    this.nearestSampler = device.createSampler({
      magFilter: 'nearest',
      minFilter: 'nearest',
    });

    // Linear sampler for CRT curvature post-processing
    this.linearSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });

    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'filtering' },
        },
      ],
    });

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });

    this.cellPipeline = device.createRenderPipeline({
      label: 'Instanced Cell Pipeline',
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: FLOATS_PER_INSTANCE * 4,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x4' }, // rect
              { shaderLocation: 1, offset: 16, format: 'float32x4' }, // uvRect
              { shaderLocation: 2, offset: 32, format: 'float32x4' }, // color
              { shaderLocation: 3, offset: 48, format: 'float32' }, // kind
              { shaderLocation: 4, offset: 52, format: 'float32' }, // codepoint
            ],
          },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [
          {
            format: this.format,
            blend: {
              color: {
                srcFactor: 'src-alpha',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add',
              },
              alpha: {
                srcFactor: 'one',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add',
              },
            },
          },
        ],
      },
      primitive: {
        topology: 'triangle-list',
      },
    });

    this.postPipeline = device.createRenderPipeline({
      label: 'CRT Post-Process Pipeline',
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_post',
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_post',
        targets: [{ format: this.format }],
      },
      primitive: {
        topology: 'triangle-list',
      },
    });

    this.cellBindGroup = device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.globalsBuffer } },
        { binding: 1, resource: this.atlasTexture.createView() },
        { binding: 2, resource: this.nearestSampler },
      ],
    });

    this.resize();
  }

  public isCrtEnabled(): boolean {
    return this.crtEnabled;
  }

  public setCrtEnabled(enabled: boolean): void {
    this.crtEnabled = enabled;
  }

  public resize(scale = this.scale): void {
    this.scale = scale;
    this.deviceDpr = window.devicePixelRatio || 1;
    // A full screen has at most 1920 narrow or 960 wide glyphs. Reserve
    // 32 rows of 64 narrow slots, including padding and shelf-packing waste.
    const slots = Math.ceil(Math.sqrt(COLS * ROWS / 2)) + 1;
    const limit = this.device.limits.maxTextureDimension2D;
    const nextDpr = Math.min(this.deviceDpr * scale,
      (Math.floor(limit / (slots * 2)) - 2) / CELL_W,
      limit / LOGICAL_W, limit / LOGICAL_H);
    const atlasSize = Math.max(ATLAS_SIZE,
      Math.min(limit, Math.ceil(slots * 2 * (Math.ceil(CELL_W * nextDpr) + 2) / 256) * 256));
    if (atlasSize !== this.atlasSize) {
      this.atlasTexture.destroy();
      this.atlasSize = atlasSize;
      this.atlasTexture = this.device.createTexture({
        label: 'Dynamic CJK Glyph Atlas',
        size: [atlasSize, atlasSize, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this.cellBindGroup = this.device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.globalsBuffer } },
          { binding: 1, resource: this.atlasTexture.createView() },
          { binding: 2, resource: this.nearestSampler },
        ],
      });
      this.clearAtlas();
    }
    if (nextDpr !== this.dpr) {
      this.dpr = nextDpr;
      this.clearAtlas();
    }

    this.canvas.style.width = `${LOGICAL_W * scale}px`;
    this.canvas.style.height = `${LOGICAL_H * scale}px`;
    const width = Math.max(1, Math.round(LOGICAL_W * this.dpr));
    const height = Math.max(1, Math.round(LOGICAL_H * this.dpr));
    if (width === this.physW && height === this.physH && this.offscreenView) return;
    this.physW = width;
    this.physH = height;

    this.canvas.width = this.physW;
    this.canvas.height = this.physH;

    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: 'opaque',
    });

    this.offscreenTexture?.destroy();
    this.offscreenTexture = this.device.createTexture({
      label: 'Terminal Offscreen Render Target',
      size: [this.physW, this.physH, 1],
      format: this.format,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.offscreenView = this.offscreenTexture.createView();

    this.postBindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.globalsBuffer } },
        { binding: 1, resource: this.offscreenView },
        { binding: 2, resource: this.linearSampler },
      ],
    });
  }

  public clientPointToCell(clientX: number, clientY: number) {
    return clientPointToCell(this.canvas, clientX, clientY);
  }

  /** Evict between frames so UVs already emitted in a frame remain valid. */
  private prepareAtlas(frame: TerminalFrameSnapshot): void {
    let x = this.atlasCursorX;
    let y = this.atlasCursorY;
    let rowHeight = this.atlasRowHeight;
    const missing = new Set<string>();
    for (const item of frame.glyphs) {
      if (isCustomBlockCodepoint(item.text.codePointAt(0) ?? 0)) continue;
      const pw = Math.max(1, Math.round(item.w * this.dpr));
      const ph = Math.max(1, Math.round(CELL_H * this.dpr));
      const key = `${item.text}:${item.flags & (STYLE_FLAG_BOLD | STYLE_FLAG_ITALIC)}:${pw}x${ph}`;
      if (this.atlasCache.has(key) || missing.has(key)) continue;
      missing.add(key);
      if (x + pw + 2 > this.atlasSize) {
        x = 0;
        y += rowHeight + 2;
        rowHeight = 0;
      }
      if (y + ph + 2 > this.atlasSize) {
        this.clearAtlas();
        return;
      }
      x += pw + 2;
      rowHeight = Math.max(rowHeight, ph);
    }
  }

  private clearAtlas(): void {
    this.atlasCache.clear();
    this.atlasCursorX = 0;
    this.atlasCursorY = 0;
    this.atlasRowHeight = 0;
  }

  private getOrRasterizeGlyph(
    text: string,
    flags: number,
    logicalWidth: number
  ): AtlasEntry {
    const pw = Math.max(1, Math.round(logicalWidth * this.dpr));
    const ph = Math.max(1, Math.round(CELL_H * this.dpr));
    const styleBits = flags & (STYLE_FLAG_BOLD | STYLE_FLAG_ITALIC);
    const key = `${text}:${styleBits}:${pw}x${ph}`;
    const existing = this.atlasCache.get(key);
    if (existing) {
      return existing;
    }

    const pad = 2;

    if (this.atlasCursorX + pw + pad > this.atlasSize) {
      this.atlasCursorX = 0;
      this.atlasCursorY += this.atlasRowHeight + pad;
      this.atlasRowHeight = 0;
    }

    if (this.atlasCursorY + ph + pad > this.atlasSize) {
      throw new Error('Glyph atlas capacity exceeded');
    }

    if (this.glyphCanvas.width !== pw || this.glyphCanvas.height !== ph) {
      this.glyphCanvas.width = pw;
      this.glyphCanvas.height = ph;
    } else {
      this.glyphCtx.clearRect(0, 0, pw, ph);
    }

    const bold = flags & STYLE_FLAG_BOLD ? 'bold ' : '';
    const italic = flags & STYLE_FLAG_ITALIC ? 'italic ' : '';

    this.glyphCtx.save();
    this.glyphCtx.scale(this.dpr, this.dpr);
    this.glyphCtx.font = `${italic}${bold}${FONT_SIZE}px ${FONT_FAMILY}`;
    this.glyphCtx.textBaseline = 'middle';
    this.glyphCtx.fillStyle = '#ffffff';
    // Snap vertical baseline to physical pixel grid for crisp horizontal CJK strokes
    const snappedMidY = Math.round((CELL_H / 2 - 1) * this.dpr) / this.dpr;
    this.glyphCtx.fillText(text, 0, snappedMidY);
    this.glyphCtx.restore();

    this.device.queue.copyExternalImageToTexture(
      { source: this.glyphCanvas },
      {
        texture: this.atlasTexture,
        origin: [this.atlasCursorX, this.atlasCursorY, 0],
      },
      [pw, ph]
    );

    const entry: AtlasEntry = {
      u0: this.atlasCursorX / this.atlasSize,
      v0: this.atlasCursorY / this.atlasSize,
      u1: (this.atlasCursorX + pw) / this.atlasSize,
      v1: (this.atlasCursorY + ph) / this.atlasSize,
      pw,
      ph,
    };

    this.atlasCache.set(key, entry);
    this.atlasCursorX += pw + pad;
    if (ph > this.atlasRowHeight) {
      this.atlasRowHeight = ph;
    }

    return entry;
  }

  private snapRectToPhysical(
    x: number,
    y: number,
    w: number,
    h: number
  ): [number, number, number, number] {
    const x0 = Math.round(x * this.dpr);
    const y0 = Math.round(y * this.dpr);
    const x1 = Math.round((x + w) * this.dpr);
    const y1 = Math.round((y + h) * this.dpr);
    return [x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)];
  }

  private pushInstance(
    px: number,
    py: number,
    pw: number,
    ph: number,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    r: number,
    g: number,
    b: number,
    a: number,
    kind: QuadKind,
    codepoint: number
  ): void {
    if (this.instanceCount >= MAX_INSTANCES) {
      return;
    }
    const base = this.instanceCount * FLOATS_PER_INSTANCE;
    const data = this.instanceData;
    data[base + 0] = px;
    data[base + 1] = py;
    data[base + 2] = pw;
    data[base + 3] = ph;
    data[base + 4] = u0;
    data[base + 5] = v0;
    data[base + 6] = u1;
    data[base + 7] = v1;
    data[base + 8] = r;
    data[base + 9] = g;
    data[base + 10] = b;
    data[base + 11] = a;
    data[base + 12] = kind;
    data[base + 13] = codepoint;
    data[base + 14] = 0;
    data[base + 15] = 0;
    this.instanceCount++;
  }

  private pushSolidQuad(
    x: number,
    y: number,
    w: number,
    h: number,
    rgb: RgbTuple,
    alpha = 1.0
  ): void {
    const [px, py, pw, ph] = this.snapRectToPhysical(x, y, w, h);
    this.pushInstance(
      px,
      py,
      pw,
      ph,
      0,
      0,
      0,
      0,
      rgb[0] / 255,
      rgb[1] / 255,
      rgb[2] / 255,
      alpha,
      QuadKind.Solid,
      0
    );
  }

  public render(frame: TerminalFrameSnapshot): void {
    if (!this.offscreenView || !this.postBindGroup) {
      return;
    }

    const t0 = performance.now();

    // Check if devicePixelRatio changed (e.g. browser zoom or moving across monitors)
    const currentDpr = window.devicePixelRatio || 1;
    if (currentDpr !== this.deviceDpr) {
      this.resize();
    }

    this.prepareAtlas(frame);
    this.instanceCount = 0;

    // 1. Non-default cell background quads
    for (let i = 0; i < frame.backgroundRects.length; i++) {
      const rect = frame.backgroundRects[i];
      this.pushSolidQuad(rect.x, rect.y, rect.w, rect.h, rect.color, 1.0);
    }

    // 2. Glyphs (analytical WGSL block/triangle or dynamic CJK atlas glyph) + decorations
    for (let i = 0; i < frame.glyphs.length; i++) {
      const item = frame.glyphs[i];
      const cp = item.text.codePointAt(0) ?? 0;
      const r = item.fg[0] / 255;
      const g = item.fg[1] / 255;
      const b = item.fg[2] / 255;

      if (isCustomBlockCodepoint(cp)) {
        const [px, py, pw, ph] = this.snapRectToPhysical(
          item.x,
          item.y,
          item.w,
          CELL_H
        );
        this.pushInstance(
          px,
          py,
          pw,
          ph,
          0,
          0,
          1,
          1,
          r,
          g,
          b,
          1.0,
          QuadKind.CustomBlock,
          cp
        );
      } else {
        const uv = this.getOrRasterizeGlyph(item.text, item.flags, item.w);
        const px = Math.round(item.x * this.dpr);
        const py = Math.round(item.y * this.dpr);
        // Exact 1:1 physical pixel dimensions matching the rasterized atlas entry
        this.pushInstance(
          px,
          py,
          uv.pw,
          uv.ph,
          uv.u0,
          uv.v0,
          uv.u1,
          uv.v1,
          r,
          g,
          b,
          1.0,
          QuadKind.AtlasGlyph,
          0
        );
      }

      const underline =
        (item.flags & STYLE_UNDERLINE_MASK) >> STYLE_UNDERLINE_SHIFT;
      if (underline !== 0) {
        this.pushSolidQuad(
          item.x,
          item.y + CELL_H - 2,
          item.w,
          1,
          item.fg,
          1.0
        );
      }
      if (item.flags & STYLE_FLAG_STRIKETHROUGH) {
        this.pushSolidQuad(
          item.x,
          item.y + Math.floor(CELL_H / 2),
          item.w,
          1,
          item.fg,
          1.0
        );
      }
    }

    // 3. URL underlines and highlights
    if (frame.urlUnderlines) {
      for (let i = 0; i < frame.urlUnderlines.length; i++) {
        const u = frame.urlUnderlines[i];
        if (u.isHovered) {
          // Hover background glow
          this.pushSolidQuad(u.x, u.y, u.w, CELL_H, [78, 168, 222], 0.15);
          // Bright accent 2px underline
          this.pushSolidQuad(u.x, u.y + CELL_H - 2, u.w, 2, [78, 168, 222], 1.0);
        } else {
          // Subtle link underline
          this.pushSolidQuad(u.x, u.y + CELL_H - 2, u.w, 1, [78, 168, 222], 0.55);
        }
      }
    }

    // 4. Selection highlight overlay
    for (let i = 0; i < frame.selectionRects.length; i++) {
      const sel = frame.selectionRects[i];
      this.pushSolidQuad(sel.x, sel.y, sel.w, sel.h, [78, 168, 222], 0.35);
    }

    // 4. Cursor
    if (frame.cursor.visible) {
      this.pushSolidQuad(
        frame.cursor.x * CELL_W,
        frame.cursor.y * CELL_H + CELL_H - 3,
        CELL_W,
        3,
        [0, 220, 130],
        0.75
      );
    }

    // Upload uniforms with physical pixel screen dimensions
    const elapsedSec = (performance.now() - this.startTime) / 1000;
    const globals = new Float32Array([
      this.physW,
      this.physH,
      this.crtEnabled ? 1.0 : 0.0,
      elapsedSec,
    ]);
    this.device.queue.writeBuffer(this.globalsBuffer, 0, globals);

    // Upload instance data
    if (this.instanceCount > 0) {
      this.device.queue.writeBuffer(
        this.instanceBuffer,
        0,
        this.instanceData.buffer,
        0,
        this.instanceCount * FLOATS_PER_INSTANCE * 4
      );
    }

    const encoder = this.device.createCommandEncoder({
      label: 'GhosPTT Render Command Encoder',
    });

    const swapchainView = this.context.getCurrentTexture().createView();

    if (!this.crtEnabled) {
      // Single-pass direct rendering into swapchain (no intermediate blit filter)
      const pass = encoder.beginRenderPass({
        label: 'Direct Terminal Grid Pass',
        colorAttachments: [
          {
            view: swapchainView,
            clearValue: {
              r: frame.defaultBg[0] / 255,
              g: frame.defaultBg[1] / 255,
              b: frame.defaultBg[2] / 255,
              a: 1.0,
            },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      if (this.instanceCount > 0) {
        pass.setPipeline(this.cellPipeline);
        pass.setBindGroup(0, this.cellBindGroup);
        pass.setVertexBuffer(0, this.instanceBuffer);
        pass.draw(6, this.instanceCount, 0, 0);
      }
      pass.end();
    } else {
      // Pass 1: Render terminal grid into offscreen texture
      const pass1 = encoder.beginRenderPass({
        label: 'Pass 1: Offscreen Terminal Grid',
        colorAttachments: [
          {
            view: this.offscreenView,
            clearValue: {
              r: frame.defaultBg[0] / 255,
              g: frame.defaultBg[1] / 255,
              b: frame.defaultBg[2] / 255,
              a: 1.0,
            },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      if (this.instanceCount > 0) {
        pass1.setPipeline(this.cellPipeline);
        pass1.setBindGroup(0, this.cellBindGroup);
        pass1.setVertexBuffer(0, this.instanceBuffer);
        pass1.draw(6, this.instanceCount, 0, 0);
      }
      pass1.end();

      // Pass 2: Present to swapchain with CRT shader
      const pass2 = encoder.beginRenderPass({
        label: 'Pass 2: CRT Post-Process',
        colorAttachments: [
          {
            view: swapchainView,
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      pass2.setPipeline(this.postPipeline);
      pass2.setBindGroup(0, this.postBindGroup);
      pass2.draw(6, 1, 0, 0);
      pass2.end();
    }

    this.device.queue.submit([encoder.finish()]);

    const t1 = performance.now();
    const duration = t1 - t0;
    this.lastFrameTimeMs = duration;
    this.avgFrameTimeMs =
      this.avgFrameTimeMs === 0
        ? duration
        : this.avgFrameTimeMs * 0.85 + duration * 0.15;
    this.lastRenderTimestamp = t1;
    this.frameCount++;

    if (t1 - this.lastFpsTimestamp >= 1000) {
      this.currentFps = Math.round(
        (this.frameCount * 1000) / (t1 - this.lastFpsTimestamp)
      );
      this.frameCount = 0;
      this.lastFpsTimestamp = t1;
    }
  }

  public getMetrics(): RenderMetrics {
    const atlasBytes = this.atlasSize * this.atlasSize * 4;
    const offscreenBytes = this.physW * this.physH * 4;
    const vertexBufferBytes = this.instanceData.byteLength;
    const totalGpuMemoryBytes = atlasBytes + offscreenBytes + vertexBufferBytes;

    const usedHeight = Math.min(
      this.atlasSize,
      this.atlasCursorY + this.atlasRowHeight
    );
    const usagePct = (usedHeight / this.atlasSize) * 100;
    const isIdle = performance.now() - this.lastRenderTimestamp > 1200;

    return {
      backendName: this.crtEnabled ? 'WebGPU (CRT)' : 'WebGPU',
      lastFrameTimeMs: this.lastFrameTimeMs,
      avgFrameTimeMs: this.avgFrameTimeMs,
      fps: isIdle ? 0 : this.currentFps,
      drawCallCount: this.crtEnabled ? 2 : 1,
      renderPassCount: this.crtEnabled ? 2 : 1,
      instanceCount: this.instanceCount,
      glyphCacheEntries: this.atlasCache.size,
      textureAtlasDim: `${this.atlasSize}×${this.atlasSize}`,
      textureAtlasMemoryBytes: atlasBytes,
      textureAtlasUsagePct: Math.round(usagePct * 10) / 10,
      totalGpuMemoryBytes,
    };
  }

  public destroy(): void {
    this.offscreenTexture?.destroy();
    this.atlasTexture.destroy();
    this.instanceBuffer.destroy();
    this.globalsBuffer.destroy();
  }
}
