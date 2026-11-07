# GhosPTT

A minimal, self-contained **PTT (批踢踢實業坊)** web client powered by [`libghostty-vt`](https://github.com/ghostty-org/ghostty) compiled to WebAssembly.

## Features

- **`libghostty-vt` WebAssembly Core**: Uses Ghostty's VT parser, terminal screen grid (`GhosttyTerminal`), render state (`GhosttyRenderState`), selection engine (`GhosttySelection`), and plain-text formatter (`GhosttyFormatter`).
- **Telnet over WebSocket**: Connects to `wss://ws.ptt.cc/bbs` (subprotocol `telnet`) and handles Telnet `IAC` (`0xFF`) negotiation, automatically replying to `IAC DO NAWS` with an `80×24` window size (`0xFF 0xFA 0x1F 0x00 0x50 0x00 0x18 0xFF 0xF0`).
- **Big5 & Dual-Color DBCS ("雙色字") Support**:
  - Stateful stream decoder that handles Big5 2-byte characters split across WebSocket frames or interrupted mid-character by ANSI SGR escape sequences (`[Lead Byte] + \x1b[...m + [Trail Byte]`).
  - Preserves 2-column cell widths for East Asian Ambiguous characters in Big5 (block elements, triangles, box-drawing, and symbols) using `libghostty-vt` Mode 2027 (Grapheme Clustering).
  - Encodes UTF-8 strings (ASCII + Traditional Chinese) back into Big5 bytes for clipboard paste and IME input.
- **HTML5 Canvas Renderer**:
  - HiDPI-aware 80×24 terminal grid rendering with the classic 16-color VGA/BBS palette and bold-brightening.
  - Pixel-exact custom geometry for BBS block elements (`▁`–`█`, `▉`–`▏`, `▐`, `▔`, `▕`) and corner triangles (`◢`, `◣`, `◤`, `◥`) for gap-free ANSI art.
- **Selection, Copy & Paste**:
  - Mouse click-and-drag cell selection (`Alt`+drag for rectangular selection), double-click word selection, triple-click line selection, and `Ctrl+Shift+A` / `Cmd+A` Select All.
  - Copy selection to clipboard (`Ctrl+C` when selected, `Ctrl+Shift+C`, `Cmd+C`, or toolbar **Copy** button).
  - Paste text from clipboard (`Ctrl+V`, `Ctrl+Shift+V`, `Cmd+V`, or toolbar **Paste** button) and CJK IME composition input.

## Prerequisites

- [mise](https://mise.jdx.dev/) (manages the Node.js toolchain and project tasks)

## Getting Started

1. **Install dependencies**:
   ```bash
   mise run install
   ```

2. **Start the development server**:
   ```bash
   mise run dev
   ```
   Open `http://localhost:8000` in your browser.

   > **Note on the WebSocket Proxy**: `wss://ws.ptt.cc/bbs` requires `Origin: https://term.ptt.cc` over an HTTP/1.1 TLS ALPN handshake and rejects direct browser connections from `http://localhost` with `403 Forbidden` (WebSocket close code `1006`). The Vite server plugin in `vite.config.ts` automatically proxies `ws://localhost:8000/bbs` to `wss://ws.ptt.cc/bbs` with the required headers.

3. **Typecheck and build for production**:
   ```bash
   mise run typecheck
   mise run build
   mise run preview
   ```

## Project Structure

```text
.
├── index.html              # Application shell and toolbar UI
├── mise.toml               # mise toolchain and task definitions
├── package.json            # Package manifest and scripts
├── tsconfig.json           # Strict TypeScript configuration
├── vite.config.ts          # Vite configuration + /bbs WebSocket proxy plugin
├── public/
│   └── ghostty-vt.wasm     # Prebuilt libghostty-vt WebAssembly binary
└── src/
    ├── main.ts             # Application entry point, DOM events, clipboard & IME wiring
    ├── ghostty-wasm.ts     # TypeScript wrapper around ghostty-vt.wasm C ABI
    ├── renderer.ts         # HTML5 Canvas renderer & custom BBS block/triangle glyphs
    ├── ptt-client.ts       # WebSocket lifecycle, Telnet parser & Big5 stream pipeline
    ├── big5.ts             # Big5 <-> UTF-8 codec with mid-DBCS ANSI escape handling
    ├── telnet.ts           # Stateful Telnet IAC filter and NAWS 80x24 responder
    ├── input.ts            # KeyboardEvent to VT/ANSI escape sequence mapper
    └── constants.ts        # Grid dimensions, BBS 16-color palette, and style flags
```
