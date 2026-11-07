import {
  BBS_PALETTE_16,
  BIG5_WIDE_PAD_RE,
  CELL_H,
  CELL_W,
  COLS,
  ROWS,
  STYLE_FLAG_BOLD,
  STYLE_FLAG_FAINT,
  STYLE_FLAG_INVERSE,
  STYLE_FLAG_INVISIBLE,
  type RgbTuple,
} from './constants';

export interface GhosttyWasmExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  ghostty_type_json(): number;
  ghostty_wasm_alloc(len: number): number;
  ghostty_wasm_free(ptr: number, len: number): void;
  ghostty_wasm_alloc_opaque(): number;
  ghostty_wasm_free_opaque(ptr: number): void;
  ghostty_wasm_take_opaque(slot: number): number;
  ghostty_free(alloc: number, ptr: number, len: number): void;

  ghostty_unicode_codepoint_width(cp: number): number;

  ghostty_terminal_new(
    alloc: number,
    outTerm: number,
    cols: number,
    rows: number
  ): number;
  ghostty_terminal_free(term: number): void;
  ghostty_terminal_vt_write(term: number, ptr: number, len: number): void;
  ghostty_terminal_set(term: number, opt: number, valPtr: number): number;
  ghostty_terminal_get(term: number, data: number, outPtr: number): number;
  ghostty_terminal_grid_ref(
    term: number,
    pointPtr: number,
    outRefPtr: number
  ): number;
  ghostty_terminal_select_word(
    term: number,
    optsPtr: number,
    outSelPtr: number
  ): number;
  ghostty_terminal_select_line(
    term: number,
    optsPtr: number,
    outSelPtr: number
  ): number;
  ghostty_terminal_select_all(term: number, outSelPtr: number): number;

  ghostty_render_state_new(alloc: number, outState: number): number;
  ghostty_render_state_free(state: number): void;
  ghostty_render_state_update(state: number, term: number): number;
  ghostty_render_state_clean(state: number): number;
  ghostty_render_state_get(
    state: number,
    data: number,
    outPtr: number
  ): number;

  ghostty_render_state_row_iterator_new(
    alloc: number,
    outIter: number
  ): number;
  ghostty_render_state_row_iterator_free(iter: number): void;
  ghostty_render_state_row_iterator_next(iter: number): number;
  ghostty_render_state_row_get(
    iter: number,
    data: number,
    outPtr: number
  ): number;

  ghostty_render_state_row_cells_new(alloc: number, outCells: number): number;
  ghostty_render_state_row_cells_free(cells: number): void;
  ghostty_render_state_row_cells_next(cells: number): number;
  ghostty_render_state_row_cells_get(
    cells: number,
    data: number,
    outPtr: number
  ): number;

  ghostty_formatter_terminal_new(
    alloc: number,
    outFmt: number,
    term: number
  ): number;
  ghostty_formatter_set(fmt: number, opt: number, valPtr: number): number;
  ghostty_formatter_format_alloc(
    fmt: number,
    alloc: number,
    outPtrPtr: number,
    outLenPtr: number
  ): number;
  ghostty_formatter_free(fmt: number): void;
}

interface StructFieldLayout {
  offset: number;
  size: number;
  type: string;
}

interface StructTypeDesc {
  kind: 'struct';
  size: number;
  align: number;
  fields: Record<string, StructFieldLayout>;
}

interface EnumTypeDesc {
  kind: 'enum';
  values: Record<string, number>;
}

interface GhosttyTypeLayout {
  abi: {
    pointer_size: number;
    usize_size: number;
  };
  types: {
    GhosttyTerminalOption: EnumTypeDesc;
    GhosttyTerminalData: EnumTypeDesc;
    GhosttyRenderStateData: EnumTypeDesc;
    GhosttyRenderStateRowData: EnumTypeDesc;
    GhosttyRenderStateRowCellsData: EnumTypeDesc;
    GhosttyFormatterOption: EnumTypeDesc;
    GhosttyFormatterFormat: EnumTypeDesc;
    GhosttyRenderStateColors: StructTypeDesc;
    GhosttyRenderStateCursor: StructTypeDesc;
    GhosttyRenderStateRowSelection: StructTypeDesc;
    GhosttyStyle: StructTypeDesc;
    GhosttyBuffer: StructTypeDesc;
    GhosttyPoint: StructTypeDesc;
    GhosttyGridRef: StructTypeDesc;
    GhosttySelection: StructTypeDesc;
    GhosttyTerminalSelectWordOptions: StructTypeDesc;
    GhosttyTerminalSelectLineOptions: StructTypeDesc;
  };
}

export interface CellBackgroundRun {
  x: number;
  y: number;
  w: number;
  h: number;
  color: RgbTuple;
}

export interface CellGlyphItem {
  x: number;
  y: number;
  w: number;
  text: string;
  fg: RgbTuple;
  flags: number;
}

export interface SelectionRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface UrlUnderlineSpan {
  x: number;
  y: number;
  w: number;
  isHovered: boolean;
}

export interface TerminalFrameSnapshot {
  defaultBg: RgbTuple;
  defaultFg: RgbTuple;
  backgroundRects: CellBackgroundRun[];
  glyphs: CellGlyphItem[];
  selectionRects: SelectionRect[];
  urlUnderlines?: UrlUnderlineSpan[];
  screenLines: string[];
  cursor: {
    visible: boolean;
    x: number;
    y: number;
  };
}

const UTF8_CAP = 64;

/**
 * High-level TypeScript wrapper around `libghostty-vt` WebAssembly module.
 * Manages Wasm linear memory allocations, terminal state, selections, formatting,
 * and frame snapshot extraction.
 */
export class GhosttyVtTerminal {
  private readonly exports: GhosttyWasmExports;
  private readonly memory: WebAssembly.Memory;
  private readonly layout: GhosttyTypeLayout;
  private readonly utf8Encoder = new TextEncoder();
  private readonly utf8Decoder = new TextDecoder('utf-8');

  // Persistent handles
  private readonly opaqueSlotPtr: number;
  private readonly termPtr: number;
  private readonly renderStatePtr: number;
  private readonly rowIterPtr: number;
  private readonly rowCellsPtr: number;

  // Pre-allocated scratch buffers
  private readonly colorsPtr: number;
  private readonly colorsSize: number;
  private readonly cursorPtr: number;
  private readonly cursorSize: number;
  private readonly cellRawPtr: number;
  private readonly stylePtr: number;
  private readonly fgRgbPtr: number;
  private readonly bgRgbPtr: number;
  private readonly utf8BufStructPtr: number;
  private readonly utf8DataPtr: number;
  private readonly pointStructPtr: number;
  private readonly gridRefStartPtr: number;
  private readonly gridRefEndPtr: number;
  private readonly selectionStructPtr: number;
  private readonly rowSelectionPtr: number;
  private readonly rowSelectionSize: number;
  private readonly wordOptsPtr: number;
  private readonly wordOptsSize: number;
  private readonly lineOptsPtr: number;
  private readonly lineOptsSize: number;

  private constructor(
    exports: GhosttyWasmExports,
    layout: GhosttyTypeLayout
  ) {
    this.exports = exports;
    this.memory = exports.memory;
    this.layout = layout;

    this.opaqueSlotPtr = exports.ghostty_wasm_alloc_opaque();

    // 1. Create terminal (80x24)
    this.check(
      exports.ghostty_terminal_new(0, this.opaqueSlotPtr, COLS, ROWS),
      'ghostty_terminal_new'
    );
    this.termPtr = exports.ghostty_wasm_take_opaque(this.opaqueSlotPtr);

    // 2. Create render state & iterators
    this.check(
      exports.ghostty_render_state_new(0, this.opaqueSlotPtr),
      'ghostty_render_state_new'
    );
    this.renderStatePtr = exports.ghostty_wasm_take_opaque(this.opaqueSlotPtr);

    this.check(
      exports.ghostty_render_state_row_iterator_new(0, this.opaqueSlotPtr),
      'ghostty_render_state_row_iterator_new'
    );
    this.rowIterPtr = exports.ghostty_wasm_take_opaque(this.opaqueSlotPtr);

    this.check(
      exports.ghostty_render_state_row_cells_new(0, this.opaqueSlotPtr),
      'ghostty_render_state_row_cells_new'
    );
    this.rowCellsPtr = exports.ghostty_wasm_take_opaque(this.opaqueSlotPtr);

    // 3. Allocate scratch structs
    this.colorsSize = layout.types.GhosttyRenderStateColors.size;
    this.colorsPtr = exports.ghostty_wasm_alloc(this.colorsSize);

    this.cursorSize = layout.types.GhosttyRenderStateCursor.size;
    this.cursorPtr = exports.ghostty_wasm_alloc(this.cursorSize);

    this.cellRawPtr = exports.ghostty_wasm_alloc(8);
    this.stylePtr = exports.ghostty_wasm_alloc(layout.types.GhosttyStyle.size);
    this.fgRgbPtr = exports.ghostty_wasm_alloc(3);
    this.bgRgbPtr = exports.ghostty_wasm_alloc(3);

    this.utf8BufStructPtr = exports.ghostty_wasm_alloc(
      layout.types.GhosttyBuffer.size
    );
    this.utf8DataPtr = exports.ghostty_wasm_alloc(UTF8_CAP);

    this.pointStructPtr = exports.ghostty_wasm_alloc(
      layout.types.GhosttyPoint.size
    );
    this.gridRefStartPtr = exports.ghostty_wasm_alloc(
      layout.types.GhosttyGridRef.size
    );
    this.gridRefEndPtr = exports.ghostty_wasm_alloc(
      layout.types.GhosttyGridRef.size
    );
    this.selectionStructPtr = exports.ghostty_wasm_alloc(
      layout.types.GhosttySelection.size
    );
    this.rowSelectionSize = layout.types.GhosttyRenderStateRowSelection.size;
    this.rowSelectionPtr = exports.ghostty_wasm_alloc(this.rowSelectionSize);

    this.wordOptsSize = layout.types.GhosttyTerminalSelectWordOptions.size;
    this.wordOptsPtr = exports.ghostty_wasm_alloc(this.wordOptsSize);

    this.lineOptsSize = layout.types.GhosttyTerminalSelectLineOptions.size;
    this.lineOptsPtr = exports.ghostty_wasm_alloc(this.lineOptsSize);

    this.configureBbsColors();
    this.writeVt('\x1b[?2027h');
  }

  public static async create(wasmUrl = './ghostty-vt.wasm'): Promise<GhosttyVtTerminal> {
    const response = await fetch(wasmUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} loading ${wasmUrl}`);
    }
    const wasmBytes = await response.arrayBuffer();
    const utf8Decoder = new TextDecoder('utf-8');

    const wasmModule = await WebAssembly.instantiate(wasmBytes, {
      env: {
        log: (ptr: number, len: number) => {
          const exp = wasmModule.instance.exports as GhosttyWasmExports;
          const bytes = new Uint8Array(exp.memory.buffer, ptr, len);
          console.log('[ghostty-vt]', utf8Decoder.decode(bytes));
        },
      },
    });

    const exports = wasmModule.instance.exports as GhosttyWasmExports;
    const jsonPtr = exports.ghostty_type_json();
    const memBytes = new Uint8Array(exports.memory.buffer, jsonPtr);
    let nulIdx = 0;
    while (memBytes[nulIdx] !== 0) nulIdx++;
    const jsonStr = utf8Decoder.decode(memBytes.subarray(0, nulIdx));
    const layout = JSON.parse(jsonStr) as GhosttyTypeLayout;

    return new GhosttyVtTerminal(exports, layout);
  }

  private check(res: number, fnName: string): void {
    if (res !== 0) {
      throw new Error(`${fnName} failed with code ${res}`);
    }
  }

  private configureBbsColors(): void {
    const OPT = this.layout.types.GhosttyTerminalOption.values;
    const DATA = this.layout.types.GhosttyTerminalData.values;

    const rgbPtr = this.exports.ghostty_wasm_alloc(3);
    new Uint8Array(this.memory.buffer, rgbPtr, 3).set([0xc0, 0xc0, 0xc0]);
    this.exports.ghostty_terminal_set(this.termPtr, OPT.COLOR_FOREGROUND, rgbPtr);

    new Uint8Array(this.memory.buffer, rgbPtr, 3).set([0x00, 0x00, 0x00]);
    this.exports.ghostty_terminal_set(this.termPtr, OPT.COLOR_BACKGROUND, rgbPtr);
    this.exports.ghostty_wasm_free(rgbPtr, 3);

    const palBytes = 256 * 3;
    const palPtr = this.exports.ghostty_wasm_alloc(palBytes);
    this.exports.ghostty_terminal_get(this.termPtr, DATA.COLOR_PALETTE, palPtr);
    const palArr = new Uint8Array(this.memory.buffer, palPtr, palBytes);
    for (let i = 0; i < 16; i++) {
      palArr[i * 3 + 0] = BBS_PALETTE_16[i][0];
      palArr[i * 3 + 1] = BBS_PALETTE_16[i][1];
      palArr[i * 3 + 2] = BBS_PALETTE_16[i][2];
    }
    this.exports.ghostty_terminal_set(this.termPtr, OPT.COLOR_PALETTE, palPtr);
    this.exports.ghostty_wasm_free(palPtr, palBytes);
  }

  public codepointWidth(cp: number): number {
    return this.exports.ghostty_unicode_codepoint_width(cp);
  }

  public writeVt(text: string): void {
    if (!text) return;
    const bytes = this.utf8Encoder.encode(text);
    const ptr = this.exports.ghostty_wasm_alloc(bytes.length);
    new Uint8Array(this.memory.buffer, ptr, bytes.length).set(bytes);
    this.exports.ghostty_terminal_vt_write(this.termPtr, ptr, bytes.length);
    this.exports.ghostty_wasm_free(ptr, bytes.length);
  }

  public reset(): void {
    this.writeVt('\x1bc\x1b[?2027h\x1b[2J\x1b[H');
  }

  private resolveGridRef(col: number, row: number, outRefPtr: number): boolean {
    const pointSize = this.layout.types.GhosttyPoint.size;
    new Uint8Array(this.memory.buffer, this.pointStructPtr, pointSize).fill(0);
    const dv = new DataView(this.memory.buffer);
    dv.setInt32(this.pointStructPtr, 0, true); // GHOSTTY_POINT_TAG_ACTIVE = 0
    dv.setUint16(this.pointStructPtr + 8, col, true);
    dv.setUint32(this.pointStructPtr + 12, row, true);
    return (
      this.exports.ghostty_terminal_grid_ref(
        this.termPtr,
        this.pointStructPtr,
        outRefPtr
      ) === 0
    );
  }

  public hasSelection(): boolean {
    const DATA = this.layout.types.GhosttyTerminalData.values;
    return (
      this.exports.ghostty_terminal_get(
        this.termPtr,
        DATA.SELECTION,
        this.selectionStructPtr
      ) === 0
    );
  }

  public clearSelection(): void {
    const OPT = this.layout.types.GhosttyTerminalOption.values;
    this.exports.ghostty_terminal_set(this.termPtr, OPT.SELECTION, 0);
  }

  public setCellSelection(
    startCol: number,
    startRow: number,
    endCol: number,
    endRow: number,
    rectangle = false
  ): void {
    if (!this.resolveGridRef(startCol, startRow, this.gridRefStartPtr)) return;
    if (!this.resolveGridRef(endCol, endRow, this.gridRefEndPtr)) return;

    const selSize = this.layout.types.GhosttySelection.size;
    new Uint8Array(this.memory.buffer, this.selectionStructPtr, selSize).fill(0);
    new Uint8Array(this.memory.buffer, this.selectionStructPtr, 8).set(
      new Uint8Array(this.memory.buffer, this.gridRefStartPtr, 8)
    );
    new Uint8Array(this.memory.buffer, this.selectionStructPtr + 8, 8).set(
      new Uint8Array(this.memory.buffer, this.gridRefEndPtr, 8)
    );
    new Uint8Array(this.memory.buffer, this.selectionStructPtr + 16, 1)[0] =
      rectangle ? 1 : 0;

    const OPT = this.layout.types.GhosttyTerminalOption.values;
    this.exports.ghostty_terminal_set(
      this.termPtr,
      OPT.SELECTION,
      this.selectionStructPtr
    );
  }

  public selectWordAt(col: number, row: number): void {
    if (!this.resolveGridRef(col, row, this.gridRefStartPtr)) return;

    new Uint8Array(this.memory.buffer, this.wordOptsPtr, this.wordOptsSize).fill(0);
    new DataView(this.memory.buffer).setUint32(
      this.wordOptsPtr,
      this.wordOptsSize,
      true
    );
    new Uint8Array(this.memory.buffer, this.wordOptsPtr + 4, 8).set(
      new Uint8Array(this.memory.buffer, this.gridRefStartPtr, 8)
    );

    if (
      this.exports.ghostty_terminal_select_word(
        this.termPtr,
        this.wordOptsPtr,
        this.selectionStructPtr
      ) === 0
    ) {
      const OPT = this.layout.types.GhosttyTerminalOption.values;
      this.exports.ghostty_terminal_set(
        this.termPtr,
        OPT.SELECTION,
        this.selectionStructPtr
      );
    }
  }

  public selectLineAt(col: number, row: number): void {
    if (!this.resolveGridRef(col, row, this.gridRefStartPtr)) return;

    new Uint8Array(this.memory.buffer, this.lineOptsPtr, this.lineOptsSize).fill(0);
    new DataView(this.memory.buffer).setUint32(
      this.lineOptsPtr,
      this.lineOptsSize,
      true
    );
    new Uint8Array(this.memory.buffer, this.lineOptsPtr + 4, 8).set(
      new Uint8Array(this.memory.buffer, this.gridRefStartPtr, 8)
    );

    if (
      this.exports.ghostty_terminal_select_line(
        this.termPtr,
        this.lineOptsPtr,
        this.selectionStructPtr
      ) === 0
    ) {
      const OPT = this.layout.types.GhosttyTerminalOption.values;
      this.exports.ghostty_terminal_set(
        this.termPtr,
        OPT.SELECTION,
        this.selectionStructPtr
      );
    }
  }

  public selectAll(): void {
    if (
      this.exports.ghostty_terminal_select_all(
        this.termPtr,
        this.selectionStructPtr
      ) === 0
    ) {
      const OPT = this.layout.types.GhosttyTerminalOption.values;
      this.exports.ghostty_terminal_set(
        this.termPtr,
        OPT.SELECTION,
        this.selectionStructPtr
      );
    }
  }

  public getSelectedText(): string {
    const DATA = this.layout.types.GhosttyTerminalData.values;
    const FMT_OPT = this.layout.types.GhosttyFormatterOption.values;
    const FMT_FORMAT = this.layout.types.GhosttyFormatterFormat.values;

    const hasSel =
      this.exports.ghostty_terminal_get(
        this.termPtr,
        DATA.SELECTION,
        this.selectionStructPtr
      ) === 0;
    if (!hasSel) return '';

    if (
      this.exports.ghostty_formatter_terminal_new(
        0,
        this.opaqueSlotPtr,
        this.termPtr
      ) !== 0
    ) {
      return '';
    }
    const fmtPtr = this.exports.ghostty_wasm_take_opaque(this.opaqueSlotPtr);

    const tmpPtr = this.exports.ghostty_wasm_alloc(4);
    new DataView(this.memory.buffer).setInt32(tmpPtr, FMT_FORMAT.PLAIN, true);
    this.exports.ghostty_formatter_set(fmtPtr, FMT_OPT.EMIT, tmpPtr);

    new Uint8Array(this.memory.buffer, tmpPtr, 1)[0] = 1; // trim = true
    this.exports.ghostty_formatter_set(fmtPtr, FMT_OPT.TRIM, tmpPtr);
    this.exports.ghostty_wasm_free(tmpPtr, 4);

    this.exports.ghostty_formatter_set(
      fmtPtr,
      FMT_OPT.SELECTION,
      this.selectionStructPtr
    );

    const outPtrSlot = this.exports.ghostty_wasm_alloc_opaque();
    const outLenPtr = this.exports.ghostty_wasm_alloc(4);
    let resultText = '';

    if (
      this.exports.ghostty_formatter_format_alloc(
        fmtPtr,
        0,
        outPtrSlot,
        outLenPtr
      ) === 0
    ) {
      const outPtr = this.exports.ghostty_wasm_take_opaque(outPtrSlot);
      const outLen = new DataView(this.memory.buffer).getUint32(
        outLenPtr,
        true
      );
      if (outPtr && outLen > 0) {
        resultText = this.utf8Decoder
          .decode(new Uint8Array(this.memory.buffer, outPtr, outLen))
          .replace(BIG5_WIDE_PAD_RE, '');
        this.exports.ghostty_free(0, outPtr, outLen);
      }
    }

    this.exports.ghostty_wasm_free_opaque(outPtrSlot);
    this.exports.ghostty_wasm_free(outLenPtr, 4);
    this.exports.ghostty_formatter_free(fmtPtr);
    return resultText;
  }

  /**
   * Updates `GhosttyRenderState` from the terminal and extracts a structured
   * frame snapshot for rendering onto the HTML5 Canvas.
   */
  public captureFrameSnapshot(): TerminalFrameSnapshot {
    const RS_DATA = this.layout.types.GhosttyRenderStateData.values;
    const ROW_DATA = this.layout.types.GhosttyRenderStateRowData.values;
    const CELL_DATA = this.layout.types.GhosttyRenderStateRowCellsData.values;

    this.check(
      this.exports.ghostty_render_state_update(
        this.renderStatePtr,
        this.termPtr
      ),
      'ghostty_render_state_update'
    );

    // Read global colors
    let view = new DataView(this.memory.buffer);
    view.setUint32(this.colorsPtr, this.colorsSize, true);
    this.check(
      this.exports.ghostty_render_state_get(
        this.renderStatePtr,
        RS_DATA.COLORS,
        this.colorsPtr
      ),
      'ghostty_render_state_get(COLORS)'
    );

    const colorsFields = this.layout.types.GhosttyRenderStateColors.fields;
    const mem = new Uint8Array(this.memory.buffer);
    const bgOff = this.colorsPtr + colorsFields.background.offset;
    const fgOff = this.colorsPtr + colorsFields.foreground.offset;
    const palOff = this.colorsPtr + colorsFields.palette.offset;

    const defaultBg: RgbTuple = [mem[bgOff], mem[bgOff + 1], mem[bgOff + 2]];
    const defaultFg: RgbTuple = [mem[fgOff], mem[fgOff + 1], mem[fgOff + 2]];

    // Read cursor state
    view = new DataView(this.memory.buffer);
    view.setUint32(this.cursorPtr, this.cursorSize, true);
    this.check(
      this.exports.ghostty_render_state_get(
        this.renderStatePtr,
        RS_DATA.CURSOR,
        this.cursorPtr
      ),
      'ghostty_render_state_get(CURSOR)'
    );
    const curFields = this.layout.types.GhosttyRenderStateCursor.fields;
    view = new DataView(this.memory.buffer);
    const cursorHasPos =
      view.getUint8(this.cursorPtr + curFields.viewport_has_value.offset) !== 0;
    const cursorVisible =
      view.getUint8(this.cursorPtr + curFields.visible.offset) !== 0;
    const cursorX = view.getUint16(
      this.cursorPtr + curFields.viewport_x.offset,
      true
    );
    const cursorY = view.getUint16(
      this.cursorPtr + curFields.viewport_y.offset,
      true
    );

    // Populate row iterator
    view.setUint32(this.opaqueSlotPtr, this.rowIterPtr, true);
    this.check(
      this.exports.ghostty_render_state_get(
        this.renderStatePtr,
        RS_DATA.ROW_ITERATOR,
        this.opaqueSlotPtr
      ),
      'ghostty_render_state_get(ROW_ITERATOR)'
    );

    const backgroundRects: CellBackgroundRun[] = [];
    const glyphs: CellGlyphItem[] = [];
    const selectionRects: SelectionRect[] = [];
    const screenLines: string[] = [];

    let rowY = 0;
    while (
      this.exports.ghostty_render_state_row_iterator_next(this.rowIterPtr)
    ) {
      view = new DataView(this.memory.buffer);
      const rowChars = new Array<string>(COLS).fill(' ');

      // Query row-local selection range
      view.setUint32(this.rowSelectionPtr, this.rowSelectionSize, true);
      const selRes = this.exports.ghostty_render_state_row_get(
        this.rowIterPtr,
        ROW_DATA.SELECTION,
        this.rowSelectionPtr
      );
      if (selRes === 0) {
        view = new DataView(this.memory.buffer);
        const startX = view.getUint16(this.rowSelectionPtr + 4, true);
        const endX = view.getUint16(this.rowSelectionPtr + 6, true);
        if (endX >= startX) {
          selectionRects.push({
            x: startX * CELL_W,
            y: rowY * CELL_H,
            w: (endX - startX + 1) * CELL_W,
            h: CELL_H,
          });
        }
      }

      view.setUint32(this.opaqueSlotPtr, this.rowCellsPtr, true);
      this.check(
        this.exports.ghostty_render_state_row_get(
          this.rowIterPtr,
          ROW_DATA.CELLS,
          this.opaqueSlotPtr
        ),
        'ghostty_render_state_row_get(CELLS)'
      );

      let colX = 0;
      while (
        this.exports.ghostty_render_state_row_cells_next(this.rowCellsPtr)
      ) {
        this.exports.ghostty_render_state_row_cells_get(
          this.rowCellsPtr,
          CELL_DATA.RAW,
          this.cellRawPtr
        );
        view = new DataView(this.memory.buffer);
        const rawCell = view.getBigUint64(this.cellRawPtr, true);

        const wide = Number((rawCell >> 42n) & 3n);
        const styleId = Number((rawCell >> 26n) & 0xffffn);
        const contentTag = Number(rawCell & 3n);

        let fg: RgbTuple = defaultFg;
        let bg: RgbTuple = defaultBg;
        let flags = 0;

        if (styleId !== 0 || contentTag >= 2) {
          this.exports.ghostty_render_state_row_cells_get(
            this.rowCellsPtr,
            CELL_DATA.STYLE,
            this.stylePtr
          );
          view = new DataView(this.memory.buffer);
          flags = view.getUint16(this.stylePtr + 12, true);

          const fgRes = this.exports.ghostty_render_state_row_cells_get(
            this.rowCellsPtr,
            CELL_DATA.FG_COLOR,
            this.fgRgbPtr
          );
          if (fgRes === 0) {
            const m = new Uint8Array(this.memory.buffer, this.fgRgbPtr, 3);
            fg = [m[0], m[1], m[2]];
          }

          const bgRes = this.exports.ghostty_render_state_row_cells_get(
            this.rowCellsPtr,
            CELL_DATA.BG_COLOR,
            this.bgRgbPtr
          );
          if (bgRes === 0) {
            const m = new Uint8Array(this.memory.buffer, this.bgRgbPtr, 3);
            bg = [m[0], m[1], m[2]];
          }

          // Traditional BBS bold brightens standard 8 palette colors (0..7 -> 8..15)
          if (flags & STYLE_FLAG_BOLD) {
            const mStyle = new Uint8Array(this.memory.buffer, this.stylePtr, 4);
            const fgTag = mStyle[0];
            const fgPalIdx = mStyle[1];
            if (fgTag === 1 && fgPalIdx < 8) {
              const brightIdx = fgPalIdx + 8;
              const p = new Uint8Array(
                this.memory.buffer,
                palOff + brightIdx * 3,
                3
              );
              fg = [p[0], p[1], p[2]];
            } else if (fgTag === 0) {
              fg = [0xff, 0xff, 0xff];
            }
          }

          if (flags & STYLE_FLAG_INVERSE) {
            const tmp = fg;
            fg = bg;
            bg = tmp;
          }

          if (flags & STYLE_FLAG_FAINT) {
            fg = [
              Math.floor(fg[0] * 0.6),
              Math.floor(fg[1] * 0.6),
              Math.floor(fg[2] * 0.6),
            ];
          }
        }

        if (
          bg[0] !== defaultBg[0] ||
          bg[1] !== defaultBg[1] ||
          bg[2] !== defaultBg[2]
        ) {
          backgroundRects.push({
            x: colX * CELL_W,
            y: rowY * CELL_H,
            w: CELL_W,
            h: CELL_H,
            color: bg,
          });
        }

        if (wide !== 2 && wide !== 3 && !(flags & STYLE_FLAG_INVISIBLE)) {
          view = new DataView(this.memory.buffer);
          view.setUint32(this.utf8BufStructPtr, this.utf8DataPtr, true);
          view.setUint32(this.utf8BufStructPtr + 4, UTF8_CAP, true);
          view.setUint32(this.utf8BufStructPtr + 8, 0, true);

          const utf8Res = this.exports.ghostty_render_state_row_cells_get(
            this.rowCellsPtr,
            CELL_DATA.GRAPHEMES_UTF8,
            this.utf8BufStructPtr
          );
          if (utf8Res === 0) {
            view = new DataView(this.memory.buffer);
            const byteLen = view.getUint32(this.utf8BufStructPtr + 8, true);
            if (byteLen > 0) {
              const rawText = this.utf8Decoder.decode(
                new Uint8Array(this.memory.buffer, this.utf8DataPtr, byteLen)
              );
              const text = rawText.replace(BIG5_WIDE_PAD_RE, '');
              if (text) {
                rowChars[colX] = text;
                if (wide === 1 && colX + 1 < COLS) {
                  rowChars[colX + 1] = '';
                }
                if (text !== ' ') {
                  glyphs.push({
                    x: colX * CELL_W,
                    y: rowY * CELL_H,
                    w: wide === 1 ? CELL_W * 2 : CELL_W,
                    text,
                    fg,
                    flags,
                  });
                }
              }
            }
          }
        }

        colX++;
      }
      screenLines.push(rowChars.join(''));
      rowY++;
    }

    this.exports.ghostty_render_state_clean(this.renderStatePtr);

    return {
      defaultBg,
      defaultFg,
      backgroundRects,
      glyphs,
      selectionRects,
      screenLines,
      cursor: {
        visible:
          cursorVisible && cursorHasPos && cursorX < COLS && cursorY < ROWS,
        x: cursorX,
        y: cursorY,
      },
    };
  }
}
