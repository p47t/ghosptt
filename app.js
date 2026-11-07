// GhosPTT — Minimal PTT client powered by libghostty-vt in WebAssembly

const COLS = 80;
const ROWS = 24;
const CELL_W = 12;
const CELL_H = 24;
const FONT_SIZE = 20;
const FONT_FAMILY =
  '"Sarasa Mono TC", "Noto Sans Mono CJK TC", "Microsoft JhengHei", "PingFang TC", "Heiti TC", "Courier New", monospace';

const PTT_DIRECT_WS_URL = 'wss://ws.ptt.cc/bbs';
const PTT_PROXY_WS_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/bbs`;

// Classic BBS / VGA 16-color palette (index 0..15)
const BBS_PALETTE_16 = [
  [0x00, 0x00, 0x00], // 0: Black
  [0x80, 0x00, 0x00], // 1: Red
  [0x00, 0x80, 0x00], // 2: Green
  [0x80, 0x80, 0x00], // 3: Yellow / Brown
  [0x00, 0x00, 0x80], // 4: Blue
  [0x80, 0x00, 0x80], // 5: Magenta
  [0x00, 0x80, 0x80], // 6: Cyan
  [0xc0, 0xc0, 0xc0], // 7: White (Light Gray)
  [0x80, 0x80, 0x80], // 8: Bright Black (Dark Gray)
  [0xff, 0x00, 0x00], // 9: Bright Red
  [0x00, 0xff, 0x00], // 10: Bright Green
  [0xff, 0xff, 0x00], // 11: Bright Yellow
  [0x00, 0x00, 0xff], // 12: Bright Blue
  [0xff, 0x00, 0xff], // 13: Bright Magenta
  [0x00, 0xff, 0xff], // 14: Bright Cyan
  [0xff, 0xff, 0xff], // 15: Bright White
];

// Telnet protocol constants
const IAC = 0xff;
const DONT = 0xfe;
const DO = 0xfd;
const WONT = 0xfc;
const WILL = 0xfb;
const SB = 0xfa;
const SE = 0xf0;
const OPT_NAWS = 0x1f;

// NAWS response for 80x24: IAC SB NAWS 0x00 0x50 0x00 0x18 IAC SE
const NAWS_80X24 = new Uint8Array([
  0xff, 0xfa, 0x1f, 0x00, 0x50, 0x00, 0x18, 0xff, 0xf0,
]);

// Style flags from ghostty/vt/style.h
const STYLE_FLAG_BOLD = 1 << 0;
const STYLE_FLAG_ITALIC = 1 << 1;
const STYLE_FLAG_FAINT = 1 << 2;
const STYLE_FLAG_BLINK = 1 << 3;
const STYLE_FLAG_INVERSE = 1 << 4;
const STYLE_FLAG_INVISIBLE = 1 << 5;
const STYLE_FLAG_STRIKETHROUGH = 1 << 6;
const STYLE_UNDERLINE_SHIFT = 8;
const STYLE_UNDERLINE_MASK = 0x7 << STYLE_UNDERLINE_SHIFT;

// State
let wasmExports = null;
let wasmMemory = null;
let typeLayout = null;

// Persistent libghostty handles and scratch buffers
let termPtr = 0;
let renderStatePtr = 0;
let rowIterPtr = 0;
let rowCellsPtr = 0;
let opaqueSlotPtr = 0;
let colorsPtr = 0;
let colorsSize = 0;
let cursorPtr = 0;
let cursorSize = 0;
let cellRawPtr = 0;
let stylePtr = 0;
let fgRgbPtr = 0;
let bgRgbPtr = 0;
let utf8BufStructPtr = 0;
let utf8DataPtr = 0;
const UTF8_CAP = 64;

let ws = null;
let big5Decoder = new TextDecoder('big5');
let utf8Encoder = new TextEncoder();
let utf8Decoder = new TextDecoder('utf-8');

// Telnet state machine across WebSocket frames
const TELNET_DATA = 0;
const TELNET_IAC = 1;
const TELNET_CMD = 2;
const TELNET_SB = 3;
const TELNET_SB_IAC = 4;
let telnetState = TELNET_DATA;
let telnetCmd = 0;

let renderRequested = false;
let totalBytesRx = 0;

// DOM Elements
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const statsText = document.getElementById('statsText');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const quickBtns = document.querySelectorAll('.quick-btn');
const termWrapper = document.getElementById('termWrapper');
const canvas = document.getElementById('termCanvas');
const imeInput = document.getElementById('imeInput');
const ctx = canvas.getContext('2d', { alpha: false });

function setStatus(state, message) {
  statusDot.className = 'dot';
  if (state === 'connected') statusDot.classList.add('connected');
  else if (state === 'error') statusDot.classList.add('error');
  statusText.textContent = message;
}

function setupCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const logicalW = COLS * CELL_W;
  const logicalH = ROWS * CELL_H;
  canvas.style.width = `${logicalW}px`;
  canvas.style.height = `${logicalH}px`;
  canvas.width = Math.round(logicalW * dpr);
  canvas.height = Math.round(logicalH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.textBaseline = 'middle';
}

async function initWasm() {
  const response = await fetch('./ghostty-vt.wasm');
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} loading ghostty-vt.wasm`);
  }
  const wasmBytes = await response.arrayBuffer();

  const wasmModule = await WebAssembly.instantiate(wasmBytes, {
    env: {
      log: (ptr, len) => {
        const bytes = new Uint8Array(
          wasmModule.instance.exports.memory.buffer,
          ptr,
          len
        );
        console.log('[ghostty-vt]', utf8Decoder.decode(bytes));
      },
    },
  });

  wasmExports = wasmModule.instance.exports;
  wasmMemory = wasmExports.memory;

  // Read type layout JSON
  const jsonPtr = wasmExports.ghostty_type_json();
  const memBytes = new Uint8Array(wasmMemory.buffer, jsonPtr);
  let nulIdx = 0;
  while (memBytes[nulIdx] !== 0) nulIdx++;
  const jsonStr = utf8Decoder.decode(memBytes.subarray(0, nulIdx));
  typeLayout = JSON.parse(jsonStr);

  // Allocate reusable opaque handle slot
  opaqueSlotPtr = wasmExports.ghostty_wasm_alloc_opaque();

  // 1. Create terminal (80x24)
  checkResult(
    wasmExports.ghostty_terminal_new(0, opaqueSlotPtr, COLS, ROWS),
    'ghostty_terminal_new'
  );
  termPtr = wasmExports.ghostty_wasm_take_opaque(opaqueSlotPtr);

  // Configure BBS default colors (light gray on black) & 16-color VGA palette
  configureBbsColors();

  // 2. Create render state
  checkResult(
    wasmExports.ghostty_render_state_new(0, opaqueSlotPtr),
    'ghostty_render_state_new'
  );
  renderStatePtr = wasmExports.ghostty_wasm_take_opaque(opaqueSlotPtr);

  // 3. Create row iterator & row cells handles
  checkResult(
    wasmExports.ghostty_render_state_row_iterator_new(0, opaqueSlotPtr),
    'ghostty_render_state_row_iterator_new'
  );
  rowIterPtr = wasmExports.ghostty_wasm_take_opaque(opaqueSlotPtr);

  checkResult(
    wasmExports.ghostty_render_state_row_cells_new(0, opaqueSlotPtr),
    'ghostty_render_state_row_cells_new'
  );
  rowCellsPtr = wasmExports.ghostty_wasm_take_opaque(opaqueSlotPtr);

  // 4. Allocate scratch structs for rendering
  colorsSize = typeLayout.types.GhosttyRenderStateColors.size;
  colorsPtr = wasmExports.ghostty_wasm_alloc(colorsSize);

  cursorSize = typeLayout.types.GhosttyRenderStateCursor.size;
  cursorPtr = wasmExports.ghostty_wasm_alloc(cursorSize);

  cellRawPtr = wasmExports.ghostty_wasm_alloc(8);
  stylePtr = wasmExports.ghostty_wasm_alloc(
    typeLayout.types.GhosttyStyle.size
  );
  fgRgbPtr = wasmExports.ghostty_wasm_alloc(3);
  bgRgbPtr = wasmExports.ghostty_wasm_alloc(3);

  utf8BufStructPtr = wasmExports.ghostty_wasm_alloc(
    typeLayout.types.GhosttyBuffer.size
  );
  utf8DataPtr = wasmExports.ghostty_wasm_alloc(UTF8_CAP);
}

function checkResult(res, fnName) {
  if (res !== 0) {
    throw new Error(`${fnName} failed with code ${res}`);
  }
}

function configureBbsColors() {
  const OPT = typeLayout.types.GhosttyTerminalOption.values;
  const DATA = typeLayout.types.GhosttyTerminalData.values;

  const rgbPtr = wasmExports.ghostty_wasm_alloc(3);
  // Default foreground: #c0c0c0
  new Uint8Array(wasmMemory.buffer, rgbPtr, 3).set([0xc0, 0xc0, 0xc0]);
  wasmExports.ghostty_terminal_set(termPtr, OPT.COLOR_FOREGROUND, rgbPtr);

  // Default background: #000000
  new Uint8Array(wasmMemory.buffer, rgbPtr, 3).set([0x00, 0x00, 0x00]);
  wasmExports.ghostty_terminal_set(termPtr, OPT.COLOR_BACKGROUND, rgbPtr);
  wasmExports.ghostty_wasm_free(rgbPtr, 3);

  // Override first 16 palette colors with classic BBS ANSI colors
  const palBytes = 256 * 3;
  const palPtr = wasmExports.ghostty_wasm_alloc(palBytes);
  wasmExports.ghostty_terminal_get(termPtr, DATA.COLOR_PALETTE, palPtr);
  const palArr = new Uint8Array(wasmMemory.buffer, palPtr, palBytes);
  for (let i = 0; i < 16; i++) {
    palArr[i * 3 + 0] = BBS_PALETTE_16[i][0];
    palArr[i * 3 + 1] = BBS_PALETTE_16[i][1];
    palArr[i * 3 + 2] = BBS_PALETTE_16[i][2];
  }
  wasmExports.ghostty_terminal_set(termPtr, OPT.COLOR_PALETTE, palPtr);
  wasmExports.ghostty_wasm_free(palPtr, palBytes);
}

/**
 * Write UTF-8 text into the Ghostty VT terminal instance.
 */
function vtWriteString(str) {
  if (!str || !termPtr) return;
  const bytes = utf8Encoder.encode(str);
  const ptr = wasmExports.ghostty_wasm_alloc(bytes.length);
  new Uint8Array(wasmMemory.buffer, ptr, bytes.length).set(bytes);
  wasmExports.ghostty_terminal_vt_write(termPtr, ptr, bytes.length);
  wasmExports.ghostty_wasm_free(ptr, bytes.length);
  scheduleRender();
}

/**
 * Filter Telnet IAC commands from incoming binary stream, respond to
 * IAC DO NAWS with 80x24 window size, decode Big5 bytes to UTF-8, and
 * feed into ghostty_terminal_vt_write().
 */
function handleIncomingChunk(arrayBuffer) {
  const input = new Uint8Array(arrayBuffer);
  totalBytesRx += input.length;

  const cleanBytes = new Uint8Array(input.length);
  let cleanLen = 0;

  for (let i = 0; i < input.length; i++) {
    const b = input[i];

    switch (telnetState) {
      case TELNET_DATA:
        if (b === IAC) {
          telnetState = TELNET_IAC;
        } else {
          cleanBytes[cleanLen++] = b;
        }
        break;

      case TELNET_IAC:
        if (b === IAC) {
          // Escaped 0xFF data byte
          cleanBytes[cleanLen++] = 0xff;
          telnetState = TELNET_DATA;
        } else if (b === DO || b === DONT || b === WILL || b === WONT) {
          telnetCmd = b;
          telnetState = TELNET_CMD;
        } else if (b === SB) {
          telnetState = TELNET_SB;
        } else {
          telnetState = TELNET_DATA;
        }
        break;

      case TELNET_CMD:
        // Handle IAC DO NAWS (0xFF 0xFD 0x1F)
        if (telnetCmd === DO && b === OPT_NAWS) {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(NAWS_80X24);
          }
        }
        telnetState = TELNET_DATA;
        break;

      case TELNET_SB:
        if (b === IAC) {
          telnetState = TELNET_SB_IAC;
        }
        break;

      case TELNET_SB_IAC:
        if (b === SE) {
          telnetState = TELNET_DATA;
        } else if (b !== IAC) {
          telnetState = TELNET_SB;
        }
        break;
    }
  }

  if (cleanLen > 0) {
    const sub = cleanBytes.subarray(0, cleanLen);
    // Stream-decode Big5 so split multi-byte sequences across frames are preserved
    const decodedText = big5Decoder.decode(sub, { stream: true });
    if (decodedText.length > 0) {
      vtWriteString(decodedText);
    }
  }

  statsText.textContent = `80×24 · RX ${(totalBytesRx / 1024).toFixed(1)} KB · Big5 / Telnet · libghostty-vt.wasm`;
}

function scheduleRender() {
  if (!renderRequested) {
    renderRequested = true;
    requestAnimationFrame(() => {
      renderRequested = false;
      renderTerminal();
    });
  }
}

function rgbCss(r, g, b) {
  return `rgb(${r},${g},${b})`;
}

/**
 * Update GhosttyRenderState from GhosttyTerminal and draw the 80x24 grid onto HTML5 Canvas.
 */
function renderTerminal() {
  if (!termPtr || !renderStatePtr) return;

  const RS_DATA = typeLayout.types.GhosttyRenderStateData.values;
  const ROW_DATA = typeLayout.types.GhosttyRenderStateRowData.values;
  const CELL_DATA = typeLayout.types.GhosttyRenderStateRowCellsData.values;

  checkResult(
    wasmExports.ghostty_render_state_update(renderStatePtr, termPtr),
    'ghostty_render_state_update'
  );

  // Read global colors struct (sized struct: write size at offset 0)
  let view = new DataView(wasmMemory.buffer);
  view.setUint32(colorsPtr, colorsSize, true);
  checkResult(
    wasmExports.ghostty_render_state_get(
      renderStatePtr,
      RS_DATA.COLORS,
      colorsPtr
    ),
    'ghostty_render_state_get(COLORS)'
  );

  const colorsFields = typeLayout.types.GhosttyRenderStateColors.fields;
  const mem = new Uint8Array(wasmMemory.buffer);
  const bgOff = colorsPtr + colorsFields.background.offset;
  const fgOff = colorsPtr + colorsFields.foreground.offset;
  const palOff = colorsPtr + colorsFields.palette.offset;

  const defaultBg = [mem[bgOff], mem[bgOff + 1], mem[bgOff + 2]];
  const defaultFg = [mem[fgOff], mem[fgOff + 1], mem[fgOff + 2]];

  // Read cursor state
  view = new DataView(wasmMemory.buffer);
  view.setUint32(cursorPtr, cursorSize, true);
  checkResult(
    wasmExports.ghostty_render_state_get(
      renderStatePtr,
      RS_DATA.CURSOR,
      cursorPtr
    ),
    'ghostty_render_state_get(CURSOR)'
  );
  const curFields = typeLayout.types.GhosttyRenderStateCursor.fields;
  view = new DataView(wasmMemory.buffer);
  const cursorHasPos =
    view.getUint8(cursorPtr + curFields.viewport_has_value.offset) !== 0;
  const cursorVisible =
    view.getUint8(cursorPtr + curFields.visible.offset) !== 0;
  const cursorX = view.getUint16(cursorPtr + curFields.viewport_x.offset, true);
  const cursorY = view.getUint16(cursorPtr + curFields.viewport_y.offset, true);

  // Clear canvas with default background
  ctx.fillStyle = rgbCss(defaultBg[0], defaultBg[1], defaultBg[2]);
  ctx.fillRect(0, 0, COLS * CELL_W, ROWS * CELL_H);

  // Populate row iterator from render state
  view.setUint32(opaqueSlotPtr, rowIterPtr, true);
  checkResult(
    wasmExports.ghostty_render_state_get(
      renderStatePtr,
      RS_DATA.ROW_ITERATOR,
      opaqueSlotPtr
    ),
    'ghostty_render_state_get(ROW_ITERATOR)'
  );

  // Pass 1: Draw cell backgrounds row by row, and collect text glyphs to draw in Pass 2
  // (Drawing all backgrounds before glyphs prevents wide CJK characters from being clipped
  // by the background rect of the adjacent cell.)
  const textDrawList = [];

  let rowY = 0;
  while (wasmExports.ghostty_render_state_row_iterator_next(rowIterPtr)) {
    view = new DataView(wasmMemory.buffer);
    view.setUint32(opaqueSlotPtr, rowCellsPtr, true);
    checkResult(
      wasmExports.ghostty_render_state_row_get(
        rowIterPtr,
        ROW_DATA.CELLS,
        opaqueSlotPtr
      ),
      'ghostty_render_state_row_get(CELLS)'
    );

    let colX = 0;
    while (wasmExports.ghostty_render_state_row_cells_next(rowCellsPtr)) {
      // Read packed GhosttyCell (u64)
      wasmExports.ghostty_render_state_row_cells_get(
        rowCellsPtr,
        CELL_DATA.RAW,
        cellRawPtr
      );
      view = new DataView(wasmMemory.buffer);
      const rawCell = view.getBigUint64(cellRawPtr, true);

      // Extract wide property (bits 42..43): 0 = narrow, 1 = wide, 2 = spacer_tail, 3 = spacer_head
      const wide = Number((rawCell >> 42n) & 3n);
      const styleId = Number((rawCell >> 26n) & 0xffffn);
      const contentTag = Number(rawCell & 3n);

      let fg = defaultFg;
      let bg = defaultBg;
      let flags = 0;

      if (styleId !== 0 || contentTag >= 2) {
        wasmExports.ghostty_render_state_row_cells_get(
          rowCellsPtr,
          CELL_DATA.STYLE,
          stylePtr
        );
        view = new DataView(wasmMemory.buffer);
        flags = view.getUint16(stylePtr + 12, true);

        const fgRes = wasmExports.ghostty_render_state_row_cells_get(
          rowCellsPtr,
          CELL_DATA.FG_COLOR,
          fgRgbPtr
        );
        if (fgRes === 0) {
          const m = new Uint8Array(wasmMemory.buffer, fgRgbPtr, 3);
          fg = [m[0], m[1], m[2]];
        }

        const bgRes = wasmExports.ghostty_render_state_row_cells_get(
          rowCellsPtr,
          CELL_DATA.BG_COLOR,
          bgRgbPtr
        );
        if (bgRes === 0) {
          const m = new Uint8Array(wasmMemory.buffer, bgRgbPtr, 3);
          bg = [m[0], m[1], m[2]];
        }

        // In traditional BBS/PTT, bold + standard palette index (0..7) brightens to palette index (8..15)
        if (flags & STYLE_FLAG_BOLD) {
          const mStyle = new Uint8Array(wasmMemory.buffer, stylePtr, 4);
          const fgTag = mStyle[0];
          const fgPalIdx = mStyle[1];
          if (fgTag === 1 && fgPalIdx < 8) {
            const brightIdx = fgPalIdx + 8;
            const p = new Uint8Array(
              wasmMemory.buffer,
              palOff + brightIdx * 3,
              3
            );
            fg = [p[0], p[1], p[2]];
          } else if (fgTag === 0) {
            // Bold with default foreground -> bright white
            fg = [0xff, 0xff, 0xff];
          }
        }

        if (flags & STYLE_FLAG_INVERSE) {
          const tmp = fg;
          fg = bg;
          bg = tmp;
        }

        if (flags & STYLE_FLAG_FAINT) {
          fg = [
            Math.floor(fg[0] * 0.6),
            Math.floor(fg[1] * 0.6),
            Math.floor(fg[2] * 0.6),
          ];
        }
      }

      // Draw cell background if non-default
      if (
        bg[0] !== defaultBg[0] ||
        bg[1] !== defaultBg[1] ||
        bg[2] !== defaultBg[2]
      ) {
        ctx.fillStyle = rgbCss(bg[0], bg[1], bg[2]);
        ctx.fillRect(colX * CELL_W, rowY * CELL_H, CELL_W, CELL_H);
      }

      // Skip rendering glyph on spacer cells
      if (wide !== 2 && wide !== 3 && !(flags & STYLE_FLAG_INVISIBLE)) {
        // Read UTF-8 grapheme cluster
        view = new DataView(wasmMemory.buffer);
        view.setUint32(utf8BufStructPtr, utf8DataPtr, true);
        view.setUint32(utf8BufStructPtr + 4, UTF8_CAP, true);
        view.setUint32(utf8BufStructPtr + 8, 0, true);

        const utf8Res = wasmExports.ghostty_render_state_row_cells_get(
          rowCellsPtr,
          CELL_DATA.GRAPHEMES_UTF8,
          utf8BufStructPtr
        );
        if (utf8Res === 0) {
          view = new DataView(wasmMemory.buffer);
          const byteLen = view.getUint32(utf8BufStructPtr + 8, true);
          if (byteLen > 0) {
            const text = utf8Decoder.decode(
              new Uint8Array(wasmMemory.buffer, utf8DataPtr, byteLen)
            );
            if (text !== ' ') {
              textDrawList.push({
                x: colX * CELL_W,
                y: rowY * CELL_H,
                w: wide === 1 ? CELL_W * 2 : CELL_W,
                text,
                fg,
                flags,
              });
            }
          }
        }
      }

      colX++;
    }
    rowY++;
  }

  // Pass 2: Draw glyphs and text decorations
  let currentFont = '';
  for (let i = 0; i < textDrawList.length; i++) {
    const item = textDrawList[i];
    const bold = item.flags & STYLE_FLAG_BOLD ? 'bold ' : '';
    const italic = item.flags & STYLE_FLAG_ITALIC ? 'italic ' : '';
    const fontStr = `${italic}${bold}${FONT_SIZE}px ${FONT_FAMILY}`;
    if (fontStr !== currentFont) {
      ctx.font = fontStr;
      currentFont = fontStr;
    }

    ctx.fillStyle = rgbCss(item.fg[0], item.fg[1], item.fg[2]);
    ctx.fillText(item.text, item.x, item.y + CELL_H / 2 + 1);

    const underline =
      (item.flags & STYLE_UNDERLINE_MASK) >> STYLE_UNDERLINE_SHIFT;
    if (underline !== 0) {
      ctx.fillRect(item.x, item.y + CELL_H - 2, item.w, 1);
    }
    if (item.flags & STYLE_FLAG_STRIKETHROUGH) {
      ctx.fillRect(item.x, item.y + Math.floor(CELL_H / 2), item.w, 1);
    }
  }

  // Pass 3: Draw cursor
  if (cursorVisible && cursorHasPos && cursorX < COLS && cursorY < ROWS) {
    ctx.fillStyle = 'rgba(0, 220, 130, 0.75)';
    ctx.fillRect(
      cursorX * CELL_W,
      cursorY * CELL_H + CELL_H - 3,
      CELL_W,
      3
    );
  }

  wasmExports.ghostty_render_state_clean(renderStatePtr);
}

/**
 * Connect to PTT WebSocket endpoint.
 * Uses the local `/bbs` proxy by default (which sets `Origin: https://term.ptt.cc`
 * required by ws.ptt.cc) and falls back to `wss://ws.ptt.cc/bbs` if `/bbs` isn't available.
 */
function connectPtt(useDirect = false) {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    ws.close();
  }

  const targetUrl = useDirect ? PTT_DIRECT_WS_URL : PTT_PROXY_WS_URL;

  telnetState = TELNET_DATA;
  big5Decoder = new TextDecoder('big5');
  totalBytesRx = 0;

  // Reset terminal state on new connection
  vtWriteString('\x1bc\x1b[2J\x1b[H');

  setStatus('connecting', `Connecting to ${targetUrl}...`);
  connectBtn.disabled = true;

  let opened = false;

  try {
    ws = new WebSocket(targetUrl, ['telnet']);
    ws.binaryType = 'arraybuffer';
  } catch (err) {
    setStatus('error', `WebSocket error: ${err.message}`);
    connectBtn.disabled = false;
    return;
  }

  ws.addEventListener('open', () => {
    opened = true;
    setStatus('connected', 'Connected to ws.ptt.cc');
    connectBtn.disabled = true;
    disconnectBtn.disabled = false;
    quickBtns.forEach((b) => (b.disabled = false));
    focusTerminal();
  });

  ws.addEventListener('message', (event) => {
    if (event.data instanceof ArrayBuffer) {
      handleIncomingChunk(event.data);
    }
  });

  ws.addEventListener('close', (event) => {
    // If local proxy endpoint wasn't running (e.g. served via python http.server),
    // try direct connection or inform user to run `node server.js`.
    if (!opened && !useDirect) {
      connectPtt(true);
      return;
    }
    const hint = !opened
      ? ' — Make sure the Vite server (`mise run dev`) is running so `/bbs` is proxied'
      : '';
    setStatus('disconnected', `Disconnected (code ${event.code})${hint}`);
    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
    quickBtns.forEach((b) => (b.disabled = true));
  });

  ws.addEventListener('error', () => {
    if (opened) {
      setStatus('error', 'Connection error');
    }
  });
}

function disconnectPtt() {
  if (ws) {
    ws.close();
    ws = null;
  }
}

/**
 * Send raw string or Uint8Array over the PTT WebSocket
 */
function sendToPtt(data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (typeof data === 'string') {
    const bytes = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) {
      bytes[i] = data.charCodeAt(i) & 0xff;
    }
    ws.send(bytes);
  } else if (data instanceof Uint8Array) {
    ws.send(data);
  }
}

/**
 * Map KeyboardEvent to VT/ANSI escape sequences or control characters
 */
function mapKeyToAnsi(e) {
  if (e.altKey || e.metaKey) return null;

  // Ctrl + A..Z -> 0x01..0x1A
  if (e.ctrlKey && !e.shiftKey && e.key.length === 1) {
    const code = e.key.toUpperCase().charCodeAt(0);
    if (code >= 65 && code <= 90) {
      return String.fromCharCode(code - 64);
    }
  }

  switch (e.key) {
    case 'ArrowUp':
      return '\x1b[A';
    case 'ArrowDown':
      return '\x1b[B';
    case 'ArrowRight':
      return '\x1b[C';
    case 'ArrowLeft':
      return '\x1b[D';
    case 'Enter':
      return '\r';
    case 'Backspace':
      return '\x08';
    case 'Delete':
      return '\x1b[3~';
    case 'Tab':
      return '\t';
    case 'Escape':
      return '\x1b';
    case 'PageUp':
      return '\x1b[5~';
    case 'PageDown':
      return '\x1b[6~';
    case 'Home':
      return '\x1b[1~';
    case 'End':
      return '\x1b[4~';
    case 'Insert':
      return '\x1b[2~';
    default:
      if (!e.ctrlKey && e.key.length === 1) {
        const code = e.key.charCodeAt(0);
        if (code >= 0x20 && code <= 0x7e) {
          return e.key;
        }
      }
      return null;
  }
}

function focusTerminal() {
  imeInput.focus();
  termWrapper.classList.add('focused');
}

// Event Listeners
termWrapper.addEventListener('mousedown', (e) => {
  e.preventDefault();
  focusTerminal();
});

imeInput.addEventListener('focus', () => {
  termWrapper.classList.add('focused');
});

imeInput.addEventListener('blur', () => {
  termWrapper.classList.remove('focused');
});

let isComposing = false;

imeInput.addEventListener('compositionstart', () => {
  isComposing = true;
});

imeInput.addEventListener('compositionend', () => {
  isComposing = false;
  imeInput.value = '';
});

imeInput.addEventListener('keydown', (e) => {
  if (isComposing || e.isComposing) return;
  const seq = mapKeyToAnsi(e);
  if (seq !== null) {
    e.preventDefault();
    sendToPtt(seq);
    imeInput.value = '';
  }
});

connectBtn.addEventListener('click', () => connectPtt(false));
disconnectBtn.addEventListener('click', disconnectPtt);

quickBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    const raw = btn.getAttribute('data-send');
    if (raw) {
      const seq = raw
        .replace(/\\r/g, '\r')
        .replace(/\\n/g, '\n')
        .replace(/\\x1b/g, '\x1b');
      sendToPtt(seq);
    }
    focusTerminal();
  });
});

window.addEventListener('resize', () => {
  setupCanvas();
  scheduleRender();
});

// Boot application
(async function main() {
  setupCanvas();
  try {
    await initWasm();
    renderTerminal();
    setStatus('ready', 'WASM loaded. Connecting to PTT...');
    connectBtn.disabled = false;
    connectPtt();
  } catch (err) {
    console.error(err);
    setStatus('error', `Init error: ${err.message}`);
  }
})();
