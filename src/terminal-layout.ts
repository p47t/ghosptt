import { CELL_H, CELL_W, COLS, ROWS } from './constants';

export const LOGICAL_W = COLS * CELL_W;
export const LOGICAL_H = ROWS * CELL_H;

/** Convert displayed canvas coordinates, independent of backing resolution. */
export function clientPointToCell(canvas: HTMLCanvasElement, x: number, y: number) {
  const rect = canvas.getBoundingClientRect();
  return {
    col: Math.max(0, Math.min(COLS - 1, Math.floor((x - rect.left) * COLS / (rect.width || 1)))),
    row: Math.max(0, Math.min(ROWS - 1, Math.floor((y - rect.top) * ROWS / (rect.height || 1)))),
  };
}
