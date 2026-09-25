/** Max items in a request's line/allocation array. The 1MB body cap already
 *  bounds worst-case size; this makes the ceiling explicit and rejects at
 *  validation time instead of running a derivation over a huge payload. */
export const MAX_LINE_ITEMS = 100;

/** Max tax codes on one document line (a line realistically carries a PPN
 *  code plus a PPh code; 10 is a generous ceiling that bounds the lookup). */
export const MAX_TAX_CODES_PER_LINE = 10;
