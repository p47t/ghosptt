import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import ts from 'typescript';

// Load the browser TypeScript module
const modules = new Map();
function moduleUrl(file) {
  file = resolve(file);
  if (modules.has(file)) return modules.get(file);
  let code = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText;
  code = code.replace(
    /from ['"](.\/.+?)['"]/g,
    (_, path) => `from '${moduleUrl(resolve(dirname(file), `${path}.ts`))}'`
  );
  const url = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  modules.set(file, url);
  return url;
}

const {
  initBig5Uao,
  isBig5UaoInitialized,
  PttBig5StreamDecoder,
  encodeStringToBig5,
} = await import(moduleUrl('src/big5.ts'));

// Instantiate libghostty-vt wasm for real codepoint width checks
const wasmBuf = readFileSync('public/ghostty-vt.wasm');
const wasmInstance = (
  await WebAssembly.instantiate(wasmBuf, {
    env: {
      ghostty_host_time_epoch_s: () => 0,
      ghostty_host_time_monotonic_ms: () => 0,
      ghostty_host_random_u64: () => 0n,
    },
  })
).instance;
const codepointWidth = (cp) => wasmInstance.exports.ghostty_unicode_codepoint_width(cp);

test('Big5-UAO 2.50 decodes and encodes simplified Chinese characters (e.g. 国)', async () => {
  const uaoBuf = readFileSync('public/uao250.bin');
  await initBig5Uao(uaoBuf);
  assert.equal(isBig5UaoInitialized(), true);

  const decoder = new PttBig5StreamDecoder(codepointWidth);

  // Test decoding raw bytes of "裝在美国" (裝=0xb8cb, 在=0xa662, 美=0xacfc, 国=0x83f6)
  const pushBytes = new Uint8Array([
    0xb8, 0xcb, // 裝
    0xa6, 0x62, // 在
    0xac, 0xfc, // 美
    0x83, 0xf6, // 国
  ]);

  const decoded = decoder.decode(pushBytes);
  assert.equal(decoded, '裝在美国');

  // Test encoding "裝在美国" back to Big5 bytes
  const encoded = encodeStringToBig5('裝在美国');
  assert.deepEqual(encoded, pushBytes);
});

test('Big5-UAO decodes Japanese Kana and symbols with correct ambiguous width padding', async () => {
  const decoder = new PttBig5StreamDecoder(codepointWidth);

  // 0xc6e7 is "ぁ" in Big5-UAO (width 2 in Ghostty)
  const kanaBytes = new Uint8Array([0xc6, 0xe7]);
  const kanaDecoded = decoder.decode(kanaBytes);
  assert.equal(kanaDecoded, 'ぁ');

  // 0x9dde is "♥" in Big5-UAO (width 1 in Unicode, so requires BIG5_WIDE_PAD \u0903)
  const symbolBytes = new Uint8Array([0x9d, 0xde]);
  const symbolDecoded = decoder.decode(symbolBytes);
  assert.equal(symbolDecoded, '♥\u0903');
});

test('Exact user reported line decodes "国" properly instead of spaces', async () => {
  const decoder = new PttBig5StreamDecoder(codepointWidth);

  // Construct byte sequence:
  // "→ CHENXOX: 蛤？ 間諜炸彈裝在美" + [0x83, 0xf6] + "  喊著個能影響什  223.136.109.228 11/09 05:47"
  const prefix = encodeStringToBig5('→ CHENXOX: 蛤？ 間諜炸彈裝在美');
  const guo = new Uint8Array([0x83, 0xf6]);
  const suffix = encodeStringToBig5('  喊著個能影響什  223.136.109.228 11/09 05:47');

  const fullLine = new Uint8Array(prefix.length + guo.length + suffix.length);
  fullLine.set(prefix, 0);
  fullLine.set(guo, prefix.length);
  fullLine.set(suffix, prefix.length + guo.length);

  const result = decoder.decode(fullLine);
  // Verify '裝在美国  喊著個能影響什' is in the decoded output
  assert.match(result, /裝在美国  喊著個能影響什/);
  assert.doesNotMatch(result, /裝在美  喊/);
});
