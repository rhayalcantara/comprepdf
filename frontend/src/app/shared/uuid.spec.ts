import { newId } from './uuid';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * QA se sirve por HTTP plano, donde `crypto.randomUUID` es `undefined` (ya rompió
 * el editor de formularios una vez). Además el backend valida el `sessionId` del
 * Estudio contra el patrón UUID: un fallback que no produjera un UUID de verdad
 * haría que las sesiones se descartaran EN SILENCIO y nada agruparía la cadena.
 */
describe('newId', () => {
  it('devuelve un UUID v4 en contexto seguro', () => {
    expect(newId()).toMatch(UUID_V4);
  });

  it('devuelve un UUID v4 también sin crypto.randomUUID (contexto inseguro)', () => {
    const original = crypto.randomUUID;
    try {
      // Así se ve `crypto` cuando la página no está en contexto seguro.
      (crypto as { randomUUID?: unknown }).randomUUID = undefined;
      const id = newId();
      expect(id).toMatch(UUID_V4);
    } finally {
      (crypto as { randomUUID?: unknown }).randomUUID = original;
    }
  });

  it('no repite ids', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId()));
    expect(ids.size).toBe(500);
  });
});
