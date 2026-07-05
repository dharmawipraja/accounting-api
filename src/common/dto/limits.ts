/** Max items in a request's line/allocation array. The 1MB body cap already
 *  bounds worst-case size; this makes the ceiling explicit and rejects at
 *  validation time instead of running a derivation over a huge payload. */
export const MAX_LINE_ITEMS = 100;
