// Utilidades puras para specs de páginas ("1-3,5") y rangos {from,to}.
// Convención: páginas 1-based, specs con rangos "a-b" y páginas sueltas "n".

export interface PageRange {
  from: number;
  to: number;
}

/**
 * "1-3,5" → [1,2,3,5]. Ignora tokens inválidos. Si se pasa pageCount,
 * descarta páginas fuera de [1, pageCount]. Devuelve ordenado y sin duplicados.
 */
export function parsePageSpec(spec: string, pageCount?: number): number[] {
  const pages = new Set<number>();
  for (const token of (spec || '').split(',')) {
    const t = token.trim();
    if (!t) continue;
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(t);
    if (m) {
      const a = parseInt(m[1], 10);
      const b = parseInt(m[2], 10);
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      for (let p = lo; p <= hi; p++) pages.add(p);
    } else if (/^\d+$/.test(t)) {
      pages.add(parseInt(t, 10));
    }
  }
  return [...pages]
    .filter((p) => p >= 1 && (!pageCount || p <= pageCount))
    .sort((a, b) => a - b);
}

/** [1,2,3,5] → "1-3,5" (ordena, deduplica, colapsa consecutivos). */
export function formatPageSpec(pages: Iterable<number>): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  if (!sorted.length) return '';
  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (const p of sorted.slice(1)) {
    if (p === prev + 1) {
      prev = p;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = prev = p;
  }
  parts.push(start === prev ? `${start}` : `${start}-${prev}`);
  return parts.join(',');
}

/** [{from:1,to:3},{from:5,to:5}] → "1-3,5". Respeta el orden dado. */
export function rangesToSpec(ranges: PageRange[]): string {
  return ranges
    .map((r) => (r.from === r.to ? `${r.from}` : `${r.from}-${r.to}`))
    .join(',');
}

/** pageCount=10, size=3 → [{1,3},{4,6},{7,9},{10,10}] (modo "Fijo"). */
export function chunkIntoRanges(pageCount: number, size: number): PageRange[] {
  if (pageCount < 1 || size < 1) return [];
  const out: PageRange[] = [];
  for (let from = 1; from <= pageCount; from += size) {
    out.push({ from, to: Math.min(from + size - 1, pageCount) });
  }
  return out;
}

/**
 * Valida un rango. Con pageCount > 0 exige to <= pageCount; con pageCount 0
 * (total desconocido, p. ej. preview fallida) solo valida 1 <= from <= to.
 */
export function isValidRange(r: PageRange, pageCount: number): boolean {
  if (!Number.isInteger(r.from) || !Number.isInteger(r.to)) return false;
  if (r.from < 1 || r.from > r.to) return false;
  return pageCount <= 0 || r.to <= pageCount;
}
