import { PttBig5StreamDecoder, encodeStringToBig5 } from './big5';
import { PTT_DIRECT_WS_URL } from './constants';
import { TelnetParser } from './telnet';

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
 * Telnet IAC negotiation (NAWS 80x24), and Big5 <-> UTF-8 stream conversion.
 */
export class PttConnectionClient {
  private ws: WebSocket | null = null;
  private readonly telnet = new TelnetParser();
  private readonly big5Decoder: PttBig5StreamDecoder;
  private readonly callbacks: PttClientCallbacks;
  private totalBytesRx = 0;

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

    this.telnet.reset();
    this.big5Decoder.reset();
    this.totalBytesRx = 0;

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
      this.callbacks.onStatusChange('connected', 'Connected to ws.ptt.cc');
    });

    this.ws.addEventListener('message', (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        this.handleIncomingChunk(event.data);
      }
    });

    this.ws.addEventListener('close', (event: CloseEvent) => {
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
      if (opened) {
        this.callbacks.onStatusChange('error', 'Connection error');
      }
    });
  }

  public disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  public sendRaw(data: string | Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
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
}
