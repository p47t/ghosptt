import { BIG5_WIDE_PAD } from './constants';

let unicodeToBig5Map: Map<string, number> | null = null;

/**
 * Build a reverse Unicode -> Big5 lookup table from the browser's native `TextDecoder('big5')`
 * so pasted or IME-entered Traditional Chinese characters can be transmitted as Big5 bytes to PTT.
 */
function getUnicodeToBig5Map(): Map<string, number> {
  if (unicodeToBig5Map) return unicodeToBig5Map;
  unicodeToBig5Map = new Map<string, number>();
  const dec = new TextDecoder('big5');
  const buf = new Uint8Array(2);

  for (let hi = 0x81; hi <= 0xfe; hi++) {
    buf[0] = hi;
    for (let lo = 0x40; lo <= 0xfe; lo++) {
      if (lo === 0x7f) continue;
      buf[1] = lo;
      const ch = dec.decode(buf);
      if (ch.length === 1 && ch !== '\ufffd' && !unicodeToBig5Map.has(ch)) {
        unicodeToBig5Map.set(ch, (hi << 8) | lo);
      }
    }
  }
  return unicodeToBig5Map;
}

/**
 * Encode a UTF-8 JavaScript string (ASCII + Traditional Chinese) into Big5 bytes for PTT.
 * Normalizes CRLF / LF line breaks into CR (`\r`) for Telnet BBS input.
 */
export function encodeStringToBig5(str: string): Uint8Array {
  const normalized = str.replace(/\r\n/g, '\r').replace(/\n/g, '\r');
  const u2b = getUnicodeToBig5Map();
  const out: number[] = [];

  for (const ch of normalized) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (cp < 0x80) {
      out.push(cp);
    } else {
      const big5 = u2b.get(ch);
      if (big5 !== undefined) {
        out.push((big5 >> 8) & 0xff, big5 & 0xff);
      }
    }
  }
  return new Uint8Array(out);
}

/**
 * Parse the end index of an ANSI escape sequence starting at `buf[start] === 0x1b`.
 * Returns -1 if the escape sequence is incomplete and needs more bytes from the next frame.
 */
function findAnsiEscapeEnd(buf: Uint8Array, start: number): number {
  if (start + 1 >= buf.length) return -1;
  const next = buf[start + 1];
  if (next === 0x5b) {
    // CSI sequence: ESC [ ... <final byte 0x40..0x7E>
    let j = start + 2;
    while (j < buf.length) {
      const c = buf[j];
      if (c >= 0x40 && c <= 0x7e) {
        return j + 1;
      }
      j++;
    }
    return -1;
  }
  // Simple 2-byte escape sequence (e.g. ESC M, ESC 7, ESC 8)
  return start + 2;
}

/**
 * Stateful decoder for PTT's mixed Big5 + ANSI escape stream.
 *
 * Handles two critical PTT / Big5 BBS behaviors:
 * 1. Mid-character ANSI styling ("雙色字"): PTT frequently embeds `\x1b[...m` SGR escape
 *    sequences *between* the lead byte (`0x81..0xFE`) and trail byte (`0x40..0x7E` / `0xA1..0xFE`)
 *    of a 2-byte Big5 character.
 * 2. East Asian Ambiguous width: In Big5 BBS, every 2-byte character occupies 2 columns (24px).
 *    Characters whose Unicode codepoint has width 1 in `codepointWidth()` are paired with
 *    `BIG5_WIDE_PAD` (`\u0903`) so `libghostty-vt` (with Mode 2027 enabled) allocates 2 grid cells.
 */
export class PttBig5StreamDecoder {
  private pendingBytes = new Uint8Array(0);
  private readonly pairDecoder = new TextDecoder('big5');
  private readonly codepointWidthFn: (cp: number) => number;

  constructor(codepointWidthFn: (cp: number) => number) {
    this.codepointWidthFn = codepointWidthFn;
  }

  public reset(): void {
    this.pendingBytes = new Uint8Array(0);
  }

  public decode(newCleanBytes: Uint8Array): string {
    let buf: Uint8Array;
    if (this.pendingBytes.length > 0) {
      buf = new Uint8Array(this.pendingBytes.length + newCleanBytes.length);
      buf.set(this.pendingBytes, 0);
      buf.set(newCleanBytes, this.pendingBytes.length);
    } else {
      buf = newCleanBytes;
    }

    let out = '';
    let i = 0;
    const pairBuf = new Uint8Array(2);

    while (i < buf.length) {
      const b = buf[i];

      // 1. Standalone ESC sequence
      if (b === 0x1b) {
        const end = findAnsiEscapeEnd(buf, i);
        if (end < 0) break; // Wait for more bytes
        for (let k = i; k < end; k++) {
          out += String.fromCharCode(buf[k]);
        }
        i = end;
        continue;
      }

      // 2. Big5 lead byte (0x81..0xFE)
      if (b >= 0x81 && b <= 0xfe) {
        let j = i + 1;
        let interveningEscapes = '';
        let incomplete = false;

        // Collect any ANSI escape sequences embedded between the Big5 lead and trail bytes
        while (j < buf.length && buf[j] === 0x1b) {
          const end = findAnsiEscapeEnd(buf, j);
          if (end < 0) {
            incomplete = true;
            break;
          }
          for (let k = j; k < end; k++) {
            interveningEscapes += String.fromCharCode(buf[k]);
          }
          j = end;
        }

        if (incomplete || j >= buf.length) {
          break; // Incomplete Big5 character at end of chunk; save for next frame
        }

        const trail = buf[j];
        const isValidTrail =
          (trail >= 0x40 && trail <= 0x7e) || (trail >= 0xa1 && trail <= 0xfe);

        if (isValidTrail) {
          pairBuf[0] = b;
          pairBuf[1] = trail;
          const ch = this.pairDecoder.decode(pairBuf);
          const cp = ch.codePointAt(0) ?? 0;
          const w = this.codepointWidthFn(cp);
          out += interveningEscapes + ch + (w === 1 ? BIG5_WIDE_PAD : '');
          i = j + 1;
        } else {
          // Invalid trail byte: discard dangling lead byte and keep intervening escapes
          out += interveningEscapes;
          i = j;
        }
        continue;
      }

      // 3. Standard single-byte ASCII / control character (0x00..0x7F)
      out += String.fromCharCode(b);
      i++;
    }

    this.pendingBytes = buf.slice(i);
    return out;
  }
}
