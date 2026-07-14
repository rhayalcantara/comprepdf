import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { config } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Protege el módulo de certificados: solo TI, autenticado con una clave de
 * administrador (Fase 0 del plan, decisión D1 = "solo TI").
 *
 * El cliente debe enviar la clave en el header `X-Admin-Key`. Se compara contra
 * `CERT_ADMIN_KEY` con comparación de tiempo constante para no filtrar la clave
 * por temporización.
 *
 * Falla cerrado: si `CERT_ADMIN_KEY` no está configurada en el servidor, rechaza
 * todas las peticiones. Emitir identidades digitales nunca debe quedar abierto.
 */
export const requireAdminKey = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const expected = config.adminKey;

  // Fail-closed: sin clave configurada, el módulo permanece bloqueado.
  if (!expected) {
    logger.error(
      'CERT_ADMIN_KEY no está configurada: el módulo de certificados está bloqueado.'
    );
    res.status(503).json({
      success: false,
      error: { message: 'Certificate module is not configured' },
    });
    return;
  }

  const header = req.get('X-Admin-Key') || '';

  if (!header || !timingSafeEqual(header, expected)) {
    res.status(401).json({
      success: false,
      error: { message: 'Invalid or missing admin key' },
    });
    return;
  }

  next();
};

/**
 * Compara dos cadenas en tiempo constante. `crypto.timingSafeEqual` exige
 * buffers de igual longitud, así que primero se comparan las longitudes con un
 * hash de tamaño fijo para no revelar la longitud de la clave esperada.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
