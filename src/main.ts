import { GhosttyVtTerminal } from './ghostty-wasm';
import { mapKeyToAnsi } from './input';
import { PttConnectionClient, type ConnectionState } from './ptt-client';
import { CanvasTerminalRenderer, type TerminalRenderer } from './renderer';
import { WebGpuTerminalRenderer } from './webgpu-renderer';

function getRequiredElement<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing required DOM element #${id}`);
  }
  return el as T;
}

class GhosPttApp {
  private readonly statusDot = getRequiredElement<HTMLElement>('statusDot');
  private readonly statusText = getRequiredElement<HTMLElement>('statusText');
  private readonly statsText = getRequiredElement<HTMLElement>('statsText');
  private readonly connectBtn =
    getRequiredElement<HTMLButtonElement>('connectBtn');
  private readonly disconnectBtn =
    getRequiredElement<HTMLButtonElement>('disconnectBtn');
  private readonly rendererBtn =
    getRequiredElement<HTMLButtonElement>('rendererBtn');
  private readonly crtBtn = getRequiredElement<HTMLButtonElement>('crtBtn');
  private readonly copyBtn = getRequiredElement<HTMLButtonElement>('copyBtn');
  private readonly pasteBtn = getRequiredElement<HTMLButtonElement>('pasteBtn');
  private readonly termWrapper = getRequiredElement<HTMLElement>('termWrapper');
  private readonly canvas2d =
    getRequiredElement<HTMLCanvasElement>('termCanvas');
  private readonly canvasGpu =
    getRequiredElement<HTMLCanvasElement>('gpuCanvas');
  private readonly imeInput =
    getRequiredElement<HTMLTextAreaElement>('imeInput');
  private readonly quickBtns =
    document.querySelectorAll<HTMLButtonElement>('.quick-btn');

  private readonly metricBackend =
    getRequiredElement<HTMLElement>('metricBackend');
  private readonly metricFrameTime =
    getRequiredElement<HTMLElement>('metricFrameTime');
  private readonly metricFps = getRequiredElement<HTMLElement>('metricFps');
  private readonly metricDrawCount =
    getRequiredElement<HTMLElement>('metricDrawCount');
  private readonly metricGlyphCache =
    getRequiredElement<HTMLElement>('metricGlyphCache');
  private readonly metricAtlas = getRequiredElement<HTMLElement>('metricAtlas');
  private readonly metricGpuMem = getRequiredElement<HTMLElement>('metricGpuMem');

  private readonly canvasRenderer: CanvasTerminalRenderer;
  private webgpuRenderer: WebGpuTerminalRenderer | null = null;
  private activeRenderer: TerminalRenderer;
  private terminal: GhosttyVtTerminal | null = null;
  private pttClient: PttConnectionClient | null = null;

  private totalRxBytes = 0;
  private renderRequested = false;
  private isSelecting = false;
  private dragAnchorCell: { col: number; row: number } | null = null;
  private hasMovedDuringDrag = false;
  private isComposing = false;

  constructor() {
    this.canvasRenderer = new CanvasTerminalRenderer(this.canvas2d);
    this.activeRenderer = this.canvasRenderer;
    this.bindEvents();
    this.updateRendererUi();
    this.updateMetricsUi();
    setInterval(() => this.updateMetricsUi(), 1000);
  }

  public async start(): Promise<void> {
    try {
      const [terminal, gpuRenderer] = await Promise.all([
        GhosttyVtTerminal.create('./ghostty-vt.wasm'),
        WebGpuTerminalRenderer.create(this.canvasGpu),
      ]);

      this.terminal = terminal;
      this.webgpuRenderer = gpuRenderer;

      if (this.webgpuRenderer) {
        this.setRendererMode('webgpu');
      } else {
        this.setRendererMode('canvas2d');
      }

      this.pttClient = new PttConnectionClient(
        (cp) => this.terminal!.codepointWidth(cp),
        {
          onStatusChange: (state, msg) => this.handleStatusChange(state, msg),
          onTerminalText: (text, totalRx) => {
            this.totalRxBytes = totalRx;
            this.terminal?.writeVt(text);
            this.updateCopyButtonState();
            this.scheduleRender();
            this.updateStatsText();
          },
        }
      );

      this.renderNow();
      this.connectPtt();
    } catch (err) {
      console.error(err);
      const msg = err instanceof Error ? err.message : String(err);
      this.handleStatusChange('error', `Init error: ${msg}`);
    }
  }

  private setRendererMode(mode: 'webgpu' | 'canvas2d'): void {
    if (mode === 'webgpu' && this.webgpuRenderer) {
      this.activeRenderer = this.webgpuRenderer;
      this.canvas2d.style.display = 'none';
      this.canvasGpu.style.display = 'block';
      this.webgpuRenderer.resize();
    } else {
      this.activeRenderer = this.canvasRenderer;
      this.canvasGpu.style.display = 'none';
      this.canvas2d.style.display = 'block';
      this.canvasRenderer.resize();
    }
    this.updateRendererUi();
    this.updateStatsText();
    this.updateMetricsUi();
    this.scheduleRender();
  }

  private updateRendererUi(): void {
    const isGpu = this.activeRenderer === this.webgpuRenderer;
    if (!this.webgpuRenderer) {
      this.rendererBtn.textContent = 'Renderer: Canvas 2D (No WebGPU)';
      this.rendererBtn.disabled = true;
      this.crtBtn.textContent = 'CRT: N/A';
      this.crtBtn.disabled = true;
      return;
    }

    this.rendererBtn.disabled = false;
    this.rendererBtn.textContent = isGpu
      ? 'Renderer: WebGPU'
      : 'Renderer: Canvas 2D';

    this.crtBtn.disabled = !isGpu;
    const crtOn = this.webgpuRenderer.isCrtEnabled();
    this.crtBtn.textContent = `CRT: ${crtOn ? 'On' : 'Off'}`;
  }

  private updateStatsText(): void {
    const isGpu = this.activeRenderer === this.webgpuRenderer;
    const backendLabel = isGpu
      ? this.webgpuRenderer?.isCrtEnabled()
        ? 'WebGPU (CRT)'
        : 'WebGPU'
      : 'Canvas 2D';
    this.statsText.textContent = `80×24 · RX ${(this.totalRxBytes / 1024).toFixed(1)} KB · ${backendLabel} · libghostty-vt.wasm`;
  }

  private connectPtt(): void {
    if (!this.terminal || !this.pttClient) return;
    this.terminal.reset();
    this.updateCopyButtonState();
    this.scheduleRender();
    this.pttClient.connect(false);
  }

  private handleStatusChange(state: ConnectionState, message: string): void {
    this.statusDot.className = 'dot';
    if (state === 'connected') this.statusDot.classList.add('connected');
    else if (state === 'error') this.statusDot.classList.add('error');
    this.statusText.textContent = message;

    const connected = state === 'connected';
    const connecting = state === 'connecting';

    this.connectBtn.disabled = connected || connecting;
    this.disconnectBtn.disabled = !connected;
    this.pasteBtn.disabled = !connected;
    this.quickBtns.forEach((btn) => {
      btn.disabled = !connected;
    });

    if (connected) {
      this.focusTerminal();
    }
  }

  private scheduleRender(): void {
    if (!this.renderRequested) {
      this.renderRequested = true;
      requestAnimationFrame(() => {
        this.renderRequested = false;
        this.renderNow();
      });
    }
  }

  private renderNow(): void {
    if (!this.terminal) return;
    const snapshot = this.terminal.captureFrameSnapshot();
    this.activeRenderer.render(snapshot);
    this.updateMetricsUi();
  }

  private updateMetricsUi(): void {
    const metrics = this.activeRenderer.getMetrics();
    this.metricBackend.textContent = metrics.backendName;

    // Frame time: e.g. "0.24 ms (avg 0.28 ms)"
    const curTime = metrics.lastFrameTimeMs.toFixed(2);
    const avgTime = metrics.avgFrameTimeMs.toFixed(2);
    this.metricFrameTime.textContent = `${curTime} ms (avg ${avgTime})`;

    // FPS
    this.metricFps.textContent =
      metrics.fps > 0 ? `${metrics.fps} fps` : 'idle';

    // Draw calls / Quads
    if (metrics.instanceCount !== undefined) {
      const passStr =
        metrics.renderPassCount && metrics.renderPassCount > 1
          ? ` (${metrics.renderPassCount} passes)`
          : '';
      this.metricDrawCount.textContent = `${metrics.instanceCount.toLocaleString()} quads${passStr}`;
    } else {
      this.metricDrawCount.textContent = `${metrics.drawCallCount.toLocaleString()} calls`;
    }

    // Glyph Cache
    if (metrics.glyphCacheEntries !== undefined) {
      this.metricGlyphCache.textContent = `${metrics.glyphCacheEntries.toLocaleString()} glyphs`;
    } else {
      this.metricGlyphCache.textContent = 'Canvas 2D Font';
    }

    // Texture Atlas
    if (metrics.textureAtlasDim) {
      const mb = (metrics.textureAtlasMemoryBytes! / (1024 * 1024)).toFixed(1);
      const usage =
        metrics.textureAtlasUsagePct !== undefined
          ? ` · ${metrics.textureAtlasUsagePct}%`
          : '';
      this.metricAtlas.textContent = `${metrics.textureAtlasDim} (${mb} MB${usage})`;
    } else {
      this.metricAtlas.textContent = 'None';
    }

    // GPU Memory
    if (metrics.totalGpuMemoryBytes !== undefined) {
      const mb = (metrics.totalGpuMemoryBytes / (1024 * 1024)).toFixed(1);
      this.metricGpuMem.textContent = `${mb} MB`;
    } else {
      this.metricGpuMem.textContent = 'N/A';
    }
  }

  private updateCopyButtonState(): void {
    this.copyBtn.disabled = !(this.terminal?.hasSelection() ?? false);
  }

  private focusTerminal(): void {
    this.imeInput.focus();
    this.termWrapper.classList.add('focused');
  }

  private async copySelectionToClipboard(): Promise<boolean> {
    if (!this.terminal) return false;
    const text = this.terminal.getSelectedText();
    if (!text) return false;

    try {
      await navigator.clipboard.writeText(text);
      const prev = this.statusText.textContent;
      this.statusText.textContent = `Copied ${text.length} chars to clipboard`;
      setTimeout(() => {
        if (this.statusText.textContent?.startsWith('Copied ')) {
          this.statusText.textContent = prev;
        }
      }, 1500);
      return true;
    } catch (err) {
      console.error('Clipboard copy failed:', err);
      return false;
    }
  }

  private async pasteFromClipboard(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        this.pttClient?.sendTextAsBig5(text);
      }
    } catch (err) {
      console.error('Clipboard read failed:', err);
    }
  }

  private bindEvents(): void {
    // Mouse selection on terminal wrapper (single-click drag, double-click word, triple-click line)
    this.termWrapper.addEventListener('mousedown', (e: MouseEvent) => {
      if (e.button !== 0 || !this.terminal) return;
      e.preventDefault();
      this.focusTerminal();

      const cell = this.activeRenderer.clientPointToCell(e.clientX, e.clientY);

      if (e.detail === 2) {
        this.isSelecting = false;
        this.terminal.selectWordAt(cell.col, cell.row);
        this.updateCopyButtonState();
        this.scheduleRender();
        return;
      }

      if (e.detail >= 3) {
        this.isSelecting = false;
        this.terminal.selectLineAt(cell.col, cell.row);
        this.updateCopyButtonState();
        this.scheduleRender();
        return;
      }

      this.isSelecting = true;
      this.hasMovedDuringDrag = false;
      this.dragAnchorCell = cell;
      this.terminal.clearSelection();
      this.updateCopyButtonState();
      this.scheduleRender();
    });

    window.addEventListener('mousemove', (e: MouseEvent) => {
      if (!this.isSelecting || !this.dragAnchorCell || !this.terminal) return;
      const cell = this.activeRenderer.clientPointToCell(e.clientX, e.clientY);
      if (
        !this.hasMovedDuringDrag &&
        cell.col === this.dragAnchorCell.col &&
        cell.row === this.dragAnchorCell.row
      ) {
        return;
      }
      this.hasMovedDuringDrag = true;
      this.terminal.setCellSelection(
        this.dragAnchorCell.col,
        this.dragAnchorCell.row,
        cell.col,
        cell.row,
        e.altKey
      );
      this.updateCopyButtonState();
      this.scheduleRender();
    });

    window.addEventListener('mouseup', () => {
      this.isSelecting = false;
    });

    this.imeInput.addEventListener('focus', () => {
      this.termWrapper.classList.add('focused');
    });

    this.imeInput.addEventListener('blur', () => {
      this.termWrapper.classList.remove('focused');
    });

    this.imeInput.addEventListener('compositionstart', () => {
      this.isComposing = true;
    });

    this.imeInput.addEventListener('compositionend', (e: CompositionEvent) => {
      this.isComposing = false;
      const committed = e.data || this.imeInput.value;
      this.imeInput.value = '';
      if (committed) {
        this.pttClient?.sendTextAsBig5(committed);
      }
    });

    // Native clipboard events
    window.addEventListener('copy', (e: ClipboardEvent) => {
      if (!this.terminal?.hasSelection()) return;
      const text = this.terminal.getSelectedText();
      if (text) {
        e.preventDefault();
        e.clipboardData?.setData('text/plain', text);
        navigator.clipboard?.writeText(text).catch(() => {});
      }
    });

    window.addEventListener('paste', (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text/plain');
      if (text) {
        e.preventDefault();
        this.pttClient?.sendTextAsBig5(text);
        this.imeInput.value = '';
      }
    });

    // Keyboard navigation and shortcuts
    this.imeInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (this.isComposing || e.isComposing || !this.terminal) return;

      const keyUpper = e.key.toUpperCase();
      const isMod = e.ctrlKey || e.metaKey;

      // Select All: Ctrl+Shift+A or Cmd+A
      if (isMod && keyUpper === 'A' && (e.shiftKey || e.metaKey)) {
        e.preventDefault();
        this.terminal.selectAll();
        this.updateCopyButtonState();
        this.scheduleRender();
        return;
      }

      // Copy: Ctrl+Shift+C, Cmd+C, or Ctrl+C when a selection is active
      if (isMod && keyUpper === 'C') {
        if (e.shiftKey || e.metaKey || this.terminal.hasSelection()) {
          e.preventDefault();
          void this.copySelectionToClipboard();
          return;
        }
      }

      // Paste: Ctrl+Shift+V (Ctrl+V / Cmd+V fires the native `paste` event)
      if (isMod && keyUpper === 'V') {
        if (e.shiftKey) {
          e.preventDefault();
          void this.pasteFromClipboard();
        }
        return;
      }

      // Clear selection on Escape if one exists
      if (e.key === 'Escape' && this.terminal.hasSelection()) {
        this.terminal.clearSelection();
        this.updateCopyButtonState();
        this.scheduleRender();
      }

      const seq = mapKeyToAnsi(e);
      if (seq !== null) {
        e.preventDefault();
        this.pttClient?.sendRaw(seq);
        this.imeInput.value = '';
      }
    });

    // Toolbar buttons
    this.connectBtn.addEventListener('click', () => this.connectPtt());
    this.disconnectBtn.addEventListener('click', () =>
      this.pttClient?.disconnect()
    );
    this.rendererBtn.addEventListener('click', () => {
      if (!this.webgpuRenderer) return;
      const isGpu = this.activeRenderer === this.webgpuRenderer;
      this.setRendererMode(isGpu ? 'canvas2d' : 'webgpu');
      this.focusTerminal();
    });
    this.crtBtn.addEventListener('click', () => {
      if (!this.webgpuRenderer) return;
      this.webgpuRenderer.setCrtEnabled(!this.webgpuRenderer.isCrtEnabled());
      this.updateRendererUi();
      this.updateStatsText();
      this.scheduleRender();
      this.focusTerminal();
    });
    this.copyBtn.addEventListener('click', () => {
      void this.copySelectionToClipboard();
      this.focusTerminal();
    });
    this.pasteBtn.addEventListener('click', () => {
      void this.pasteFromClipboard();
      this.focusTerminal();
    });

    this.quickBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const raw = btn.getAttribute('data-send');
        if (raw) {
          const seq = raw
            .replace(/\\r/g, '\r')
            .replace(/\\n/g, '\n')
            .replace(/\\x1b/g, '\x1b');
          this.pttClient?.sendRaw(seq);
        }
        this.focusTerminal();
      });
    });

    window.addEventListener('resize', () => {
      this.activeRenderer.resize();
      this.scheduleRender();
    });
  }
}

const app = new GhosPttApp();
void app.start();
