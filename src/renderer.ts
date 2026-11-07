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

function rgbCss(c: RgbTuple): string {
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export interface RenderMetrics {
  backendName: string;
  lastFrameTimeMs: number;
  avgFrameTimeMs: number;
  fps: number;
  drawCallCount: number;
  instanceCount?: number;
  renderPassCount?: number;
  glyphCacheEntries?: number;
  textureAtlasDim?: string;
  textureAtlasMemoryBytes?: number;
  textureAtlasUsagePct?: number;
  totalGpuMemoryBytes?: number;
}

export interface TerminalRenderer {
  readonly backendName: string;
  resize(): void;
  clientPointToCell(
    clientX: number,
    clientY: number
  ): { col: number; row: number };
  render(frame: TerminalFrameSnapshot): void;
  getMetrics(): RenderMetrics;
  destroy?(): void;
}

/**
 * Renders `TerminalFrameSnapshot` frames from `GhosttyVtTerminal` onto an HTML5 Canvas.
 * Includes pixel-exact geometry for BBS block elements and triangles.
 */
export class CanvasTerminalRenderer implements TerminalRenderer {
  public readonly backendName = 'Canvas 2D';
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  private lastFrameTimeMs = 0;
  private avgFrameTimeMs = 0;
  private lastDrawCallCount = 0;
  private frameCount = 0;
  private lastFpsTimestamp = performance.now();
  private currentFps = 0;
  private lastRenderTimestamp = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) {
      throw new Error('Failed to acquire 2D canvas context');
    }
    this.ctx = ctx;
    this.resize();
  }

  public resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const logicalW = COLS * CELL_W;
    const logicalH = ROWS * CELL_H;
    this.canvas.style.width = `${logicalW}px`;
    this.canvas.style.height = `${logicalH}px`;
    this.canvas.width = Math.round(logicalW * dpr);
    this.canvas.height = Math.round(logicalH * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.textBaseline = 'middle';
  }

  public clientPointToCell(
    clientX: number,
    clientY: number
  ): { col: number; row: number } {
    const rect = this.canvas.getBoundingClientRect();
    const relX = clientX - rect.left;
    const relY = clientY - rect.top;
    const col = Math.max(0, Math.min(COLS - 1, Math.floor(relX / CELL_W)));
    const row = Math.max(0, Math.min(ROWS - 1, Math.floor(relY / CELL_H)));
    return { col, row };
  }

  /**
   * Custom pixel-exact Canvas drawing for BBS block elements (`U+2581..U+2595`)
   * and geometric triangles (`U+25E2..U+25E5`) so ANSI art on PTT is crisp and
   * fills the full 2-column (24x24) or 1-column (12x24) cell without font gaps.
   */
  private drawCustomBlockGlyph(
    cp: number,
    x: number,
    y: number,
    w: number,
    h: number,
    fgCss: string
  ): boolean {
    const ctx = this.ctx;
    ctx.fillStyle = fgCss;

    // Lower 1/8 .. 8/8 blocks: U+2581 (▁) .. U+2588 (█)
    if (cp >= 0x2581 && cp <= 0x2588) {
      const eighths = cp - 0x2580; // 1..8
      const bh = Math.round((h * eighths) / 8);
      ctx.fillRect(x, y + h - bh, w, bh);
      return true;
    }

    // Left 7/8 .. 1/8 blocks: U+2589 (▉) .. U+258F (▏)
    if (cp >= 0x2589 && cp <= 0x258f) {
      const eighths = 8 - (cp - 0x2588); // 7..1
      const bw = Math.round((w * eighths) / 8);
      ctx.fillRect(x, y, bw, h);
      return true;
    }

    // Right half block: U+2590 (▐)
    if (cp === 0x2590) {
      const bw = Math.round(w / 2);
      ctx.fillRect(x + w - bw, y, bw, h);
      return true;
    }

    // Upper 1/8 block: U+2594 (▔)
    if (cp === 0x2594) {
      const bh = Math.max(2, Math.round(h / 8));
      ctx.fillRect(x, y, w, bh);
      return true;
    }

    // Right 1/8 block: U+2595 (▕)
    if (cp === 0x2595) {
      const bw = Math.max(2, Math.round(w / 8));
      ctx.fillRect(x + w - bw, y, bw, h);
      return true;
    }

    // Corner triangles used in PTT ANSI art: U+25E2 (◢), U+25E3 (◣), U+25E4 (◤), U+25E5 (◥)
    if (cp >= 0x25e2 && cp <= 0x25e5) {
      ctx.beginPath();
      if (cp === 0x25e2) {
        // ◢ Lower right triangle
        ctx.moveTo(x, y + h);
        ctx.lineTo(x + w, y);
        ctx.lineTo(x + w, y + h);
      } else if (cp === 0x25e3) {
        // ◣ Lower left triangle
        ctx.moveTo(x, y);
        ctx.lineTo(x + w, y + h);
        ctx.lineTo(x, y + h);
      } else if (cp === 0x25e4) {
        // ◤ Upper left triangle
        ctx.moveTo(x, y);
        ctx.lineTo(x + w, y);
        ctx.lineTo(x, y + h);
      } else if (cp === 0x25e5) {
        // ◥ Upper right triangle
        ctx.moveTo(x, y);
        ctx.lineTo(x + w, y);
        ctx.lineTo(x + w, y + h);
      }
      ctx.closePath();
      ctx.fill();
      return true;
    }

    return false;
  }

  public render(frame: TerminalFrameSnapshot): void {
    const t0 = performance.now();
    const ctx = this.ctx;
    let drawCalls = 0;

    // 1. Fill terminal background
    ctx.fillStyle = rgbCss(frame.defaultBg);
    ctx.fillRect(0, 0, COLS * CELL_W, ROWS * CELL_H);
    drawCalls++;

    // 2. Draw non-default cell backgrounds
    for (let i = 0; i < frame.backgroundRects.length; i++) {
      const rect = frame.backgroundRects[i];
      ctx.fillStyle = rgbCss(rect.color);
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      drawCalls++;
    }

    // 3. Draw glyphs and text decorations
    let currentFont = '';
    for (let i = 0; i < frame.glyphs.length; i++) {
      const item = frame.glyphs[i];
      const fgCss = rgbCss(item.fg);
      const cp = item.text.codePointAt(0) ?? 0;

      if (!this.drawCustomBlockGlyph(cp, item.x, item.y, item.w, CELL_H, fgCss)) {
        const bold = item.flags & STYLE_FLAG_BOLD ? 'bold ' : '';
        const italic = item.flags & STYLE_FLAG_ITALIC ? 'italic ' : '';
        const fontStr = `${italic}${bold}${FONT_SIZE}px ${FONT_FAMILY}`;
        if (fontStr !== currentFont) {
          ctx.font = fontStr;
          currentFont = fontStr;
        }

        ctx.fillStyle = fgCss;
        ctx.fillText(item.text, item.x, item.y + CELL_H / 2 + 1);
        drawCalls++;
      } else {
        drawCalls++;
      }

      const underline =
        (item.flags & STYLE_UNDERLINE_MASK) >> STYLE_UNDERLINE_SHIFT;
      if (underline !== 0) {
        ctx.fillStyle = fgCss;
        ctx.fillRect(item.x, item.y + CELL_H - 2, item.w, 1);
        drawCalls++;
      }
      if (item.flags & STYLE_FLAG_STRIKETHROUGH) {
        ctx.fillStyle = fgCss;
        ctx.fillRect(item.x, item.y + Math.floor(CELL_H / 2), item.w, 1);
        drawCalls++;
      }
    }

    // 4. Draw selection highlight overlay
    if (frame.selectionRects.length > 0) {
      ctx.fillStyle = 'rgba(78, 168, 222, 0.35)';
      for (let i = 0; i < frame.selectionRects.length; i++) {
        const r = frame.selectionRects[i];
        ctx.fillRect(r.x, r.y, r.w, r.h);
        drawCalls++;
      }
    }

    // 5. Draw cursor
    if (frame.cursor.visible) {
      ctx.fillStyle = 'rgba(0, 220, 130, 0.75)';
      ctx.fillRect(
        frame.cursor.x * CELL_W,
        frame.cursor.y * CELL_H + CELL_H - 3,
        CELL_W,
        3
      );
      drawCalls++;
    }

    const t1 = performance.now();
    const duration = t1 - t0;
    this.lastFrameTimeMs = duration;
    this.avgFrameTimeMs =
      this.avgFrameTimeMs === 0
        ? duration
        : this.avgFrameTimeMs * 0.85 + duration * 0.15;
    this.lastDrawCallCount = drawCalls;
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
    const now = performance.now();
    const isIdle = now - this.lastRenderTimestamp > 1200;
    return {
      backendName: this.backendName,
      lastFrameTimeMs: this.lastFrameTimeMs,
      avgFrameTimeMs: this.avgFrameTimeMs,
      fps: isIdle ? 0 : this.currentFps,
      drawCallCount: this.lastDrawCallCount,
    };
  }
}
