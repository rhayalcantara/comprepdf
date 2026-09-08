/**
 * Genera un UUID v4.
 *
 * `crypto.randomUUID` solo existe en contextos SEGUROS (HTTPS o localhost) y QA
 * se sirve por HTTP plano, donde vale `undefined` — eso rompió el editor de
 * formularios el 2026-07-16. `crypto.getRandomValues` sí existe en contexto
 * inseguro, así que el fallback arma el UUID a mano con los bits de versión (4)
 * y variante (10xx) en su sitio: el backend valida el `sessionId` del Estudio
 * contra el patrón UUID y descartaría en silencio cualquier cosa que no lo sea.
 */
export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
