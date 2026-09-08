/**
 * Migraciones SQL aplicadas por el propio backend al arrancar.
 *
 * Por qué aquí y no en un paso aparte: en producción el despliegue lo hace el
 * Puente con una secuencia fija (git checkout → compose build → compose up) que
 * NO ejecuta SQL, y el MySQL vive dentro del compose sin puerto publicado, así
 * que nadie "de fuera" puede migrar. Si el backend migra antes de abrir el
 * puerto, desplegar ya migra y no hay pasos manuales que olvidar.
 *
 * Contrato:
 *   - Los archivos viven en `database/migrations/NNN_nombre.sql` y se aplican en
 *     orden por su prefijo numérico. Cada uno queda registrado en la tabla
 *     `schema_migrations` (creada aquí) y NO se vuelve a ejecutar.
 *   - Idempotente frente a esquemas ya migrados a mano (QA se migró con el
 *     cliente mysql, y una base recién creada con `schema.sql` ya lleva todo):
 *       * Baseline: si `schema_migrations` no existe y la base ya tiene la marca
 *         de la ÚLTIMA migración (ver `BASELINE_PROBE`), se registran todas como
 *         aplicadas sin ejecutar nada.
 *       * Tolerancia: si una sentencia falla porque la columna/índice/tabla/FK
 *         ya existe, se considera aplicada y se continúa (MySQL no tiene
 *         `ADD COLUMN IF NOT EXISTS`). Cualquier otro error aborta el arranque:
 *         un backend nuevo sobre un esquema viejo rompe a los usuarios en
 *         silencio, mejor no levantar.
 *   - DDL en MySQL no es transaccional: una migración cortada a mitad se
 *     reanuda en el siguiente arranque gracias a la tolerancia anterior.
 */
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

export type QueryFn = (sql: string, params?: unknown[]) => Promise<any>;

export interface MigrationFile {
  version: number;
  name: string;
  file: string;
}

/** Columna que solo existe si la última migración (012) está aplicada. */
export const BASELINE_PROBE = { table: 'compression_jobs', column: 'parent_job_id' };

/** Códigos de MySQL que significan "esto ya estaba hecho". */
const ALREADY_APPLIED_CODES = new Set([
  'ER_DUP_FIELDNAME',   // 1060 columna duplicada
  'ER_DUP_KEYNAME',     // 1061 índice duplicado
  'ER_TABLE_EXISTS_ERROR', // 1050 tabla ya existe
  'ER_FK_DUP_NAME',     // 1826 FK con ese nombre ya existe
  'ER_DUP_CONSTRAINT_NAME', // 3822 (MySQL 8) constraint duplicada
]);

/**
 * Dónde están los .sql. En el repo el backend corre desde `backend/`, así que
 * es `../database/migrations`; en la imagen Docker se copian a
 * `/app/database/migrations` (cwd=/app). `MIGRATIONS_DIR` manda si está.
 */
export function resolveMigrationsDir(): string | null {
  const candidates = [
    process.env.MIGRATIONS_DIR,
    path.resolve(process.cwd(), 'database/migrations'),
    path.resolve(process.cwd(), '../database/migrations'),
  ].filter((p): p is string => !!p);
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

export function listMigrationFiles(dir: string): MigrationFile[] {
  return fs.readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/i.test(f))
    .map((f) => ({ version: parseInt(f.split('_')[0], 10), name: f.replace(/\.sql$/i, ''), file: path.join(dir, f) }))
    .sort((a, b) => a.version - b.version);
}

/**
 * Parte un .sql en sentencias. Quita comentarios `-- ...` (los archivos llevan
 * mucha prosa, y una `;` dentro de un comentario partiría mal) y descarta los
 * `USE ...;` (la conexión ya está en la base correcta; en Docker el nombre
 * puede ser otro).
 */
export function splitSqlStatements(sql: string): string[] {
  const withoutComments = sql
    .split(/\r?\n/)
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
  return withoutComments
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^USE\s+/i.test(s));
}

function isAlreadyApplied(err: any): boolean {
  return !!err && (ALREADY_APPLIED_CODES.has(err.code) || ALREADY_APPLIED_CODES.has(err.driverError?.code));
}

async function tableExists(query: QueryFn, table: string): Promise<boolean> {
  const rows = await query(
    'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',
    [table],
  );
  return Number(rows?.[0]?.n ?? 0) > 0;
}

async function columnExists(query: QueryFn, table: string, column: string): Promise<boolean> {
  const rows = await query(
    'SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?',
    [table, column],
  );
  return Number(rows?.[0]?.n ?? 0) > 0;
}

export interface MigrationResult {
  applied: string[];
  baselined: string[];
  skipped: string[];
}

/**
 * Aplica las migraciones pendientes. `query` es la función de consulta de la
 * conexión (inyectable para tests).
 */
export async function runMigrations(query: QueryFn, dir: string | null = resolveMigrationsDir()): Promise<MigrationResult> {
  const result: MigrationResult = { applied: [], baselined: [], skipped: [] };
  if (!dir) {
    logger.warn('Migraciones: no se encontró database/migrations (ni MIGRATIONS_DIR); se omite');
    return result;
  }
  const files = listMigrationFiles(dir);
  if (files.length === 0) return result;

  const hadLedger = await tableExists(query, 'schema_migrations');
  await query(
    'CREATE TABLE IF NOT EXISTS schema_migrations ('
    + ' version INT NOT NULL PRIMARY KEY,'
    + ' name VARCHAR(255) NOT NULL,'
    + ' applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP'
    + ')',
  );

  // Baseline: esquema ya al día (schema.sql nuevo o QA migrado a mano) sin
  // libro de registro todavía → anotar todo como aplicado, sin ejecutar.
  if (!hadLedger && await columnExists(query, BASELINE_PROBE.table, BASELINE_PROBE.column)) {
    for (const m of files) {
      await query('INSERT IGNORE INTO schema_migrations (version, name) VALUES (?, ?)', [m.version, m.name]);
      result.baselined.push(m.name);
    }
    logger.info(`Migraciones: esquema al día, ${files.length} registradas como baseline`);
    return result;
  }

  const rows = await query('SELECT version FROM schema_migrations');
  const done = new Set<number>((rows || []).map((r: any) => Number(r.version)));

  for (const m of files) {
    if (done.has(m.version)) { result.skipped.push(m.name); continue; }
    const statements = splitSqlStatements(fs.readFileSync(m.file, 'utf8'));
    logger.info(`Migraciones: aplicando ${m.name} (${statements.length} sentencias)`);
    for (const stmt of statements) {
      try {
        await query(stmt);
      } catch (err: any) {
        if (isAlreadyApplied(err)) {
          logger.warn(`Migraciones: ${m.name}: ya aplicada una sentencia (${err.code || err.driverError?.code}), se continúa`);
          continue;
        }
        logger.error(`Migraciones: ${m.name} falló: ${err?.message || err}`);
        throw err;
      }
    }
    await query('INSERT IGNORE INTO schema_migrations (version, name) VALUES (?, ?)', [m.version, m.name]);
    result.applied.push(m.name);
  }
  if (result.applied.length) logger.info(`Migraciones: aplicadas ${result.applied.join(', ')}`);
  else logger.info('Migraciones: nada pendiente');
  return result;
}
