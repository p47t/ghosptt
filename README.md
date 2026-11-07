# GhosPTT

A modern, high-performance **PTT (批踢踢實業坊)** web client powered by [`libghostty-vt`](https://github.com/ghostty-org/ghostty) compiled to WebAssembly, featuring a hardware-accelerated **WebGPU** renderer with retro CRT simulation, rich image preview popovers, and post gallery navigation.

## Features

- **`libghostty-vt` WebAssembly Core**: Uses Ghostty's native VT parser, terminal screen grid (`GhosttyTerminal`), render state (`GhosttyRenderState`), selection engine (`GhosttySelection`), and plain-text formatter (`GhosttyFormatter`).
- **Dual Rendering Engines (WebGPU & Canvas 2D)**:
  - **Hardware-Accelerated WebGPU**: Instanced quad rendering with dynamic CJK glyph texture atlas caching, physical pixel snapping, and nearest-neighbor sampling for razor-sharp terminal typography.
  - **Retro CRT Shader**: Toggleable authentic CRT monitor emulation featuring scanlines, barrel distortion / curvature, phosphor glow, bloom, and vignette.
  - **Canvas 2D Fallback**: Automatic, seamless fallback to HTML5 2D Canvas when WebGPU is unavailable or disabled.
  - **Procedural BBS Block Elements**: Full-cell, gap-free rendering for ANSI art blocks (`▁`–`█`, `▉`–`▏`, `▐`, `▔`, `▕`) and corner triangles (`◢`, `◣`, `◤`, `◥`) implemented procedurally in both WGSL shaders and Canvas 2D paths.
  - **Descender-Safe Glyph Geometry**: Calibrated 12×24 font baseline preventing clipping of descenders (`j`, `g`, `p`, `q`, `y`, `Q`, `@`, etc.) while maintaining exact vertical centering for CJK characters.
- **In-Terminal Image Previews & Lightbox Gallery**:
  - **Hover Popover Preview**: Hover over any image link (Imgur, direct `.jpg`, `.png`, `.gif`, `.webp`) in PTT posts to preview the image inline.
  - **Fullscreen Lightbox Viewer**: Click an image URL to view in an immersive modal with smooth transitions and auto-dismissed loading state.
  - **Gallery Navigation**: Post-level image accumulation allows stepping through previous and next images in a post using on-screen arrows or `Left` / `Right` arrow keys.
  - **Seamless Focus Restoration**: Closing the image viewer automatically restores keyboard input focus to the terminal.
- **Interactive URL Navigation & Underlining**:
  - Real-time terminal URL scanning across screen rows.
  - Interactive hover highlights with accent underlines and pointer cursors.
  - Click to open non-image URLs in a new browser tab.
- **Real-Time Performance Telemetry**:
  - Live metric bar displaying active renderer (`WebGPU` / `Canvas2D`), frame render time (`ms`), FPS, active draw calls / GPU instance count, dynamic glyph texture atlas dimensions, and cache slot utilization.
- **Telnet over WebSocket**: Connects to `wss://ws.ptt.cc/bbs` (subprotocol `telnet`) and handles Telnet `IAC` (`0xFF`) negotiation, automatically replying to `IAC DO NAWS` with an `80×24` window size (`0xFF 0xFA 0x1F 0x00 0x50 0x00 0x18 0xFF 0xF0`).
- **Big5 & Dual-Color DBCS ("雙色字") Support**:
  - Stateful stream decoder that handles Big5 2-byte characters split across WebSocket frames or interrupted mid-character by ANSI SGR escape sequences (`[Lead Byte] + \x1b[...m + [Trail Byte]`).
  - Preserves 2-column cell widths for East Asian Ambiguous characters in Big5 using `libghostty-vt` Mode 2027 (Grapheme Clustering).
  - Encodes UTF-8 strings (ASCII + Traditional Chinese) back into Big5 bytes for clipboard paste and IME input.
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
├── index.html              # Application shell, telemetry bar, and lightbox UI
├── mise.toml               # mise toolchain and task definitions
├── package.json            # Package manifest and scripts
├── tsconfig.json           # Strict TypeScript configuration
├── vite.config.ts          # Vite configuration + /bbs WebSocket proxy plugin
├── public/
│   └── ghostty-vt.wasm     # Prebuilt libghostty-vt WebAssembly binary
└── src/
    ├── main.ts             # Application entry point, telemetry wiring, DOM & clipboard events
    ├── ghostty-wasm.ts     # TypeScript wrapper around ghostty-vt.wasm C ABI & screen snapshotting
    ├── renderer.ts         # HTML5 Canvas 2D fallback renderer & metrics interface
    ├── webgpu-renderer.ts  # Hardware-accelerated WebGPU instanced renderer with CRT shader
    ├── image-preview.ts    # Inline URL hover popover, lightbox viewer & gallery navigation
    ├── ptt-client.ts       # WebSocket lifecycle, Telnet parser & Big5 stream pipeline
    ├── big5.ts             # Big5 <-> UTF-8 codec with mid-DBCS ANSI escape handling
    ├── telnet.ts           # Stateful Telnet IAC filter and NAWS 80x24 responder
    ├── input.ts            # KeyboardEvent to VT/ANSI escape sequence mapper
    └── constants.ts        # Grid dimensions, BBS 16-color palette, and style flags
```
