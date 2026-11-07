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
export const NAWS_80X24 = new Uint8Array([
  0xff, 0xfa, 0x1f, 0x00, 0x50, 0x00, 0x18, 0xff, 0xf0,
]);

const enum TelnetState {
  Data = 0,
  Iac = 1,
  Cmd = 2,
  Sb = 3,
  SbIac = 4,
}

export interface TelnetFilterResult {
  cleanBytes: Uint8Array;
  replies: Uint8Array[];
}

/**
 * Stateful Telnet IAC stream parser.
 * Strips Telnet commands across arbitrary WebSocket frame boundaries and produces
 * protocol responses (such as NAWS 80x24 when receiving `IAC DO NAWS`).
 */
export class TelnetParser {
  private state: TelnetState = TelnetState.Data;
  private cmd = 0;

  public reset(): void {
    this.state = TelnetState.Data;
    this.cmd = 0;
  }

  public process(input: Uint8Array): TelnetFilterResult {
    const cleanBuf = new Uint8Array(input.length);
    let cleanLen = 0;
    const replies: Uint8Array[] = [];

    for (let i = 0; i < input.length; i++) {
      const b = input[i];

      switch (this.state) {
        case TelnetState.Data:
          if (b === IAC) {
            this.state = TelnetState.Iac;
          } else {
            cleanBuf[cleanLen++] = b;
          }
          break;

        case TelnetState.Iac:
          if (b === IAC) {
            // Escaped 0xFF data byte
            cleanBuf[cleanLen++] = 0xff;
            this.state = TelnetState.Data;
          } else if (b === DO || b === DONT || b === WILL || b === WONT) {
            this.cmd = b;
            this.state = TelnetState.Cmd;
          } else if (b === SB) {
            this.state = TelnetState.Sb;
          } else {
            this.state = TelnetState.Data;
          }
          break;

        case TelnetState.Cmd:
          // Handle IAC DO NAWS (0xFF 0xFD 0x1F)
          if (this.cmd === DO && b === OPT_NAWS) {
            replies.push(NAWS_80X24);
          }
          this.state = TelnetState.Data;
          break;

        case TelnetState.Sb:
          if (b === IAC) {
            this.state = TelnetState.SbIac;
          }
          break;

        case TelnetState.SbIac:
          if (b === SE) {
            this.state = TelnetState.Data;
          } else if (b !== IAC) {
            this.state = TelnetState.Sb;
          }
          break;
      }
    }

    return {
      cleanBytes: cleanBuf.subarray(0, cleanLen),
      replies,
    };
  }
}
