export const COLS = 80;
export const ROWS = 24;
export const CELL_W = 12;
export const CELL_H = 24;
export const FONT_SIZE = 20;
export const FONT_FAMILY =
  '"Sarasa Mono TC", "Noto Sans Mono CJK TC", "Microsoft JhengHei", "PingFang TC", "Heiti TC", "Courier New", monospace';

export const PTT_DIRECT_WS_URL = 'wss://ws.ptt.cc/bbs';

export type RgbTuple = readonly [number, number, number];

/**
 * Classic BBS / VGA 16-color palette (indices 0..15).
 */
export const BBS_PALETTE_16: readonly RgbTuple[] = [
  [0x00, 0x00, 0x00], // 0: Black
  [0x80, 0x00, 0x00], // 1: Red
  [0x00, 0x80, 0x00], // 2: Green
  [0x80, 0x80, 0x00], // 3: Yellow / Brown
  [0x00, 0x00, 0x80], // 4: Blue
  [0x80, 0x00, 0x80], // 5: Magenta
  [0x00, 0x80, 0x80], // 6: Cyan
  [0xc0, 0xc0, 0xc0], // 7: White (Light Gray)
  [0x80, 0x80, 0x80], // 8: Bright Black (Dark Gray)
  [0xff, 0x00, 0x00], // 9: Bright Red
  [0x00, 0xff, 0x00], // 10: Bright Green
  [0xff, 0xff, 0x00], // 11: Bright Yellow
  [0x00, 0x00, 0xff], // 12: Bright Blue
  [0xff, 0x00, 0xff], // 13: Bright Magenta
  [0x00, 0xff, 0xff], // 14: Bright Cyan
  [0xff, 0xff, 0xff], // 15: Bright White
];

/**
 * Style bitflags from `ghostty/vt/style.h`.
 */
export const STYLE_FLAG_BOLD = 1 << 0;
export const STYLE_FLAG_ITALIC = 1 << 1;
export const STYLE_FLAG_FAINT = 1 << 2;
export const STYLE_FLAG_BLINK = 1 << 3;
export const STYLE_FLAG_INVERSE = 1 << 4;
export const STYLE_FLAG_INVISIBLE = 1 << 5;
export const STYLE_FLAG_STRIKETHROUGH = 1 << 6;
export const STYLE_UNDERLINE_SHIFT = 8;
export const STYLE_UNDERLINE_MASK = 0x7 << STYLE_UNDERLINE_SHIFT;

/**
 * In libghostty-vt with Mode 2027 (Grapheme Clustering) enabled, East Asian Ambiguous
 * characters (such as █, ▊, ▄, ◢, ◣, ◤, ◥, ★, ─, │) have codepoint width 1 in Unicode,
 * whereas in Big5/PTT every 2-byte character occupies 2 terminal columns (24x24px).
 *
 * Appending U+0903 (a spacing combining mark with width_zero_in_grapheme=false) to any
 * width-1 Big5 double-byte character causes libghostty-vt to treat the grapheme cluster
 * as width 2 (occupying 2 grid cells natively), and we strip U+0903 when rendering/copying.
 */
export const BIG5_WIDE_PAD = '\u0903';
export const BIG5_WIDE_PAD_RE = /\u0903/g;
