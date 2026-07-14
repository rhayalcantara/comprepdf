/**
 * Sanea el nombre de salida elegido por el usuario (`outputName`).
 *
 * Quita caracteres inválidos para nombres de archivo, la extensión (.pdf/.zip)
 * si la escribió, y limita la longitud. Devuelve undefined si no queda nada
 * utilizable (el worker aplicará entonces el nombre por defecto).
 */
export function sanitizeOutputName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let name = raw.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim();
  name = name.replace(/\.(pdf|zip)$/i, '');
  name = name.replace(/^\.+|\.+$/g, '').trim();
  name = name.slice(0, 100).trim();
  return name || undefined;
}
