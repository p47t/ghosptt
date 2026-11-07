/**
 * Maps a DOM `KeyboardEvent` to VT/ANSI escape sequences or control characters
 * expected by PTT / Telnet BBS.
 */
export function mapKeyToAnsi(e: KeyboardEvent): string | null {
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
