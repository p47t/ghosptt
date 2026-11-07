# AGENTS.md

This file provides context and guidelines for AI coding agents working in this repository.

## Project Overview

**GhosPTT** is a browser-based PTT (批踢踢實業坊) Telnet/WebSocket BBS client built with TypeScript, Vite, HTML5 Canvas, and `libghostty-vt` compiled to WebAssembly (`public/ghostty-vt.wasm`).

## Toolchain & Commands

This repository uses **`mise`** for toolchain management (`node = "latest"`) and task execution, and **`jj`** (Jujutsu) alongside Git for version control.

- Install dependencies: `mise run install` (or `mise exec -- npm install`)
- Run dev server (port 8000): `mise run dev`
- Typecheck (`tsc --noEmit`): `mise run typecheck`
- Production build (`tsc --noEmit && vite build`): `mise run build`
- Preview production build: `mise run preview`

Always run `mise run build` (which runs both TypeScript typechecking and the Vite bundle build) to verify changes before finishing a task.

## Architecture & Key Technical Invariants

1. **WebSocket Connection & Origin Proxy (`vite.config.ts`, `src/ptt-client.ts`)**:
   - PTT's WebSocket gateway (`wss://ws.ptt.cc/bbs`, subprotocol `['telnet']`) enforces `Origin: https://term.ptt.cc` and requires `ALPNProtocols: ['http/1.1']` during the TLS handshake.
   - Direct browser connections from `localhost` fail with HTTP 403 (WebSocket code `1006`).
   - `pttWebSocketProxyPlugin` in `vite.config.ts` intercepts WebSocket upgrades on `/bbs` and tunnels them over TLS to `ws.ptt.cc:443` with the required headers. Do not remove or break this proxy when modifying server configuration.

2. **Telnet Negotiation (`src/telnet.ts`)**:
   - Incoming binary WebSocket frames contain raw Telnet `IAC` (`0xFF`) sequences mixed with terminal output.
   - `TelnetParser` strips `IAC` sequences statefully across frame boundaries and replies to `IAC DO NAWS` (`0xFF 0xFD 0x1F`) with `NAWS_80X24` (`0xFF 0xFA 0x1F 0x00 0x50 0x00 0x18 0xFF 0xF0`).

3. **Big5 Stream Decoding & "雙色字" (`src/big5.ts`, `src/constants.ts`)**:
   - **Mid-character ANSI escapes**: PTT frequently emits ANSI SGR sequences (`\x1b[...m`) *between* the lead byte (`0x81..0xFE`) and trail byte (`0x40..0x7E`, `0xA1..0xFE`) of a 2-byte Big5 character. Never feed raw Telnet-stripped bytes directly into `TextDecoder('big5')` without separating embedded ANSI sequences first, or `TextDecoder` will abort the Big5 lead byte on `0x1B` (`ESC`) and corrupt the rest of the line.
   - **2-Column Ambiguous Widths**: In Big5 BBS, every 2-byte character occupies 2 columns (24px). Many Big5 symbols, box-drawing characters, and block elements have East Asian Ambiguous width (`1`) in Unicode (`ghostty_unicode_codepoint_width(cp) === 1`). `GhosttyVtTerminal` enables Mode 2027 (`\x1b[?2027h`, Grapheme Clustering) and `PttBig5StreamDecoder` appends `BIG5_WIDE_PAD` (`\u0903`) to width-1 Big5 characters so `libghostty-vt` allocates 2 cells for them. Always strip `BIG5_WIDE_PAD_RE` when extracting text for rendering or clipboard copy.

4. **`libghostty-vt` WASM Interface (`src/ghostty-wasm.ts`)**:
   - The prebuilt binary lives at `public/ghostty-vt.wasm` (built from `/home/patrick/code/libghostty`, tag `vt-1.0.0`).
   - Struct sizes and field offsets are discovered dynamically at startup via `ghostty_type_json()`.
   - Remember that Wasm linear memory (`exports.memory.buffer`) can grow during allocations; always construct `DataView` / `Uint8Array` views from `this.memory.buffer` immediately before reading or writing.
   - When querying `GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR` or `GHOSTTY_RENDER_STATE_ROW_DATA_CELLS`, the `out` parameter expects a *pointer to the handle* (`GhosttyRenderStateRowIterator*` / `GhosttyRenderStateRowCells*`), not the handle value itself.

5. **Canvas Rendering (`src/renderer.ts`)**:
   - Renders in passes: default background fill, non-default cell background rects, glyphs/decorations, selection overlay, and cursor.
   - `drawCustomBlockGlyph` draws block elements (`U+2581..U+2595`) and corner triangles (`U+25E2..U+25E5`) procedurally so ANSI art fills the full cell width (`12×24` or `24×24`) without font gaps.
