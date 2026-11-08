import { PttBig5StreamDecoder, encodeStringToBig5 } from './big5';
import { PTT_DIRECT_WS_URL } from './constants';
import { TelnetParser } from './telnet';

/**
 * Telnet IAC NOP (0xFF 0xF1) keep-alive sequence.
 * RFC 854 defines NOP as a safe no-operation command that Telnet servers (including PTT BBS)
 * ignore without moving the cursor or altering terminal screen state.
 */
export const TELNET_IAC_NOP = new Uint8Array([0xff, 0xf1]);

/**
 * Periodic interval (in milliseconds) to send keep-alive frames when connection is idle.
 * Kept well below Cloudflare's 100-second idle connection timeout.
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;

export type ConnectionState =
  | 'ready'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

export interface PttClientCallbacks {
  onStatusChange(state: ConnectionState, message: string): void;
  onTerminalText(utf8Text: string, totalBytesRx: number): void;
}

/**
 * Manages the WebSocket connection to PTT (`wss://ws.ptt.cc/bbs` via local `/bbs` proxy),
 * Telnet IAC negotiation (NAWS 80x24), Big5 <-> UTF-8 stream conversion, and
 * periodic keep-alive heartbeats to prevent proxy/Cloudflare idle timeouts.
 */
export class PttConnectionClient {
  private ws: WebSocket | null = null;
  private readonly telnet = new TelnetParser();
  private readonly big5Decoder: PttBig5StreamDecoder;
  private readonly callbacks: PttClientCallbacks;
  private totalBytesRx = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastActivityTime = 0;

  constructor(
    codepointWidthFn: (cp: number) => number,
    callbacks: PttClientCallbacks
  ) {
    this.big5Decoder = new PttBig5StreamDecoder(codepointWidthFn);
    this.callbacks = callbacks;
  }

  public isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  public connect(useDirect = false): void {
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      this.ws.close();
    }

    const proxyUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/bbs`;
    const targetUrl = useDirect ? PTT_DIRECT_WS_URL : proxyUrl;

    this.stopHeartbeat();
    this.telnet.reset();
    this.big5Decoder.reset();
    this.totalBytesRx = 0;
    this.lastActivityTime = Date.now();

    this.callbacks.onStatusChange('connecting', `Connecting to ${targetUrl}...`);

    let opened = false;

    try {
      this.ws = new WebSocket(targetUrl, ['telnet']);
      this.ws.binaryType = 'arraybuffer';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.callbacks.onStatusChange('error', `WebSocket error: ${msg}`);
      return;
    }

    this.ws.addEventListener('open', () => {
      opened = true;
      this.lastActivityTime = Date.now();
      this.startHeartbeat();
      this.callbacks.onStatusChange('connected', 'Connected to ws.ptt.cc');
    });

    this.ws.addEventListener('message', (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        this.handleIncomingChunk(event.data);
      }
    });

    this.ws.addEventListener('close', (event: CloseEvent) => {
      this.stopHeartbeat();
      if (!opened && !useDirect) {
        this.connect(true);
        return;
      }
      const hint = !opened
        ? ' — Make sure the Vite server (`mise run dev`) is running so `/bbs` is proxied'
        : '';
      this.callbacks.onStatusChange(
        'disconnected',
        `Disconnected (code ${event.code})${hint}`
      );
    });

    this.ws.addEventListener('error', () => {
      this.stopHeartbeat();
      if (opened) {
        this.callbacks.onStatusChange('error', 'Connection error');
      }
    });
  }

  public disconnect(): void {
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  public sendRaw(data: string | Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.lastActivityTime = Date.now();
    if (typeof data === 'string') {
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) {
        bytes[i] = data.charCodeAt(i) & 0xff;
      }
      this.ws.send(bytes);
    } else {
      this.ws.send(data);
    }
  }

  public sendTextAsBig5(text: string): void {
    if (!text) return;
    const bytes = encodeStringToBig5(text);
    if (bytes.length > 0) {
      this.sendRaw(bytes);
    }
  }

  private handleIncomingChunk(arrayBuffer: ArrayBuffer): void {
    this.lastActivityTime = Date.now();
    const rawBytes = new Uint8Array(arrayBuffer);
    this.totalBytesRx += rawBytes.length;

    const { cleanBytes, replies } = this.telnet.process(rawBytes);
    for (const reply of replies) {
      this.sendRaw(reply);
    }

    if (cleanBytes.length > 0) {
      const decodedText = this.big5Decoder.decode(cleanBytes);
      if (decodedText.length > 0) {
        this.callbacks.onTerminalText(decodedText, this.totalBytesRx);
      }
    }
  }

  public checkHeartbeat(): void {
    if (!this.isConnected()) {
      this.stopHeartbeat();
      return;
    }
    const idleMs = Date.now() - this.lastActivityTime;
    if (idleMs >= HEARTBEAT_INTERVAL_MS) {
      this.sendRaw(TELNET_IAC_NOP);
      this.lastActivityTime = Date.now();
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.checkHeartbeat(), 10_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
