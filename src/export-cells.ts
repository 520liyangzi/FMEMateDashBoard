/** Stay below Excel's 32,767 UTF-16-unit limit, including all continuation cells. */
const MAX_CELL_UNITS = 32_700;

function splitText(text: string): string[] {
  const pieces: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + MAX_CELL_UNITS, text.length);
    // Do not separate the two UTF-16 code units of an astral character.
    const before = text.charCodeAt(end - 1), after = text.charCodeAt(end);
    if (before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF) end--;
    pieces.push(text.slice(start, end));
    start = end;
  }
  return pieces;
}

/**
 * Continue oversized strings in adjacent named columns without truncation.
 * Column names are stable across rows and cannot overwrite source columns.
 */
export function splitLongCells(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const reserved = new Set(rows.flatMap(row => Object.keys(row)));
  const names = new Map<string, Map<number, string>>();
  const continuationName = (key: string, part: number) => {
    let byPart = names.get(key);
    if (!byPart) { byPart = new Map(); names.set(key, byPart); }
    const existing = byPart.get(part);
    if (existing) return existing;
    const base = `${key} (cont. ${part})`;
    let name = base, suffix = 2;
    while (reserved.has(name)) name = `${base} [${suffix++}]`;
    reserved.add(name);
    byPart.set(part, name);
    return name;
  };
  return rows.map(row => {
    const entries: [string, unknown][] = [];
    for (const [key, value] of Object.entries(row)) {
      if (typeof value !== 'string' || value.length <= MAX_CELL_UNITS) {
        entries.push([key, value]);
        continue;
      }
      const pieces = splitText(value);
      entries.push([key, pieces[0]]);
      for (let i = 1; i < pieces.length; i++) entries.push([continuationName(key, i + 1), pieces[i]]);
    }
    // fromEntries also preserves literal keys such as "__proto__" safely.
    return Object.fromEntries(entries);
  });
}
