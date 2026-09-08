import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  listMigrationFiles,
  runMigrations,
  splitSqlStatements,
} from '../../src/services/migration.service';

jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

/** MySQL de mentira: simula information_schema y el libro de migraciones. */
function fakeDb(opts: { ledger?: number[]; hasProbeColumn?: boolean; failWith?: Record<string, string> } = {}) {
  const ledger = new Set<number>(opts.ledger ?? []);
  let ledgerExists = opts.ledger !== undefined;
  const executed: string[] = [];
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    const s = sql.trim();
    if (/information_schema\.tables/i.test(s)) return [{ n: ledgerExists ? 1 : 0 }];
    if (/information_schema\.columns/i.test(s)) return [{ n: opts.hasProbeColumn ? 1 : 0 }];
    if (/^CREATE TABLE IF NOT EXISTS schema_migrations/i.test(s)) { ledgerExists = true; return []; }
    if (/^INSERT IGNORE INTO schema_migrations/i.test(s)) { ledger.add(Number((params as any[])[0])); return []; }
    if (/^SELECT version FROM schema_migrations/i.test(s)) return [...ledger].map((v) => ({ version: v }));
    executed.push(s);
    const code = opts.failWith?.[s];
    if (code) { const e: any = new Error(code); e.code = code; throw e; }
    return [];
  });
  return { query, executed, ledger };
}

function tmpMigrations(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migr-'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

describe('splitSqlStatements', () => {
  it('quita comentarios, descarta USE y parte por ;', () => {
    const sql = `-- cabecera; con punto y coma\nUSE comprepdf;\n\nALTER TABLE a\n  ADD COLUMN b INT; -- fin\nUPDATE a SET b = 1 WHERE b IS NULL;\n`;
    expect(splitSqlStatements(sql)).toEqual([
      'ALTER TABLE a\n  ADD COLUMN b INT',
      'UPDATE a SET b = 1 WHERE b IS NULL',
    ]);
  });
});

describe('listMigrationFiles', () => {
  it('ordena por prefijo numérico e ignora lo que no sea NNN_x.sql', () => {
    const dir = tmpMigrations({ '010_b.sql': '', '002_a.sql': '', 'README.md': '', 'x.sql': '' });
    expect(listMigrationFiles(dir).map((m) => m.name)).toEqual(['002_a', '010_b']);
  });
});

describe('runMigrations', () => {
  const dir = tmpMigrations({
    '001_one.sql': 'ALTER TABLE t ADD COLUMN a INT;',
    '002_two.sql': 'CREATE TABLE IF NOT EXISTS u (id INT);\nALTER TABLE t ADD INDEX i (a);',
  });

  it('sin libro y sin la columna sonda: aplica todo en orden y lo registra', async () => {
    const db = fakeDb();
    const r = await runMigrations(db.query, dir);
    expect(r.applied).toEqual(['001_one', '002_two']);
    expect(db.executed).toEqual([
      'ALTER TABLE t ADD COLUMN a INT',
      'CREATE TABLE IF NOT EXISTS u (id INT)',
      'ALTER TABLE t ADD INDEX i (a)',
    ]);
    expect([...db.ledger]).toEqual([1, 2]);
  });

  it('sin libro pero con esquema al día: baseline sin ejecutar nada', async () => {
    const db = fakeDb({ hasProbeColumn: true });
    const r = await runMigrations(db.query, dir);
    expect(r.baselined).toEqual(['001_one', '002_two']);
    expect(db.executed).toEqual([]);
    expect([...db.ledger]).toEqual([1, 2]);
  });

  it('con libro: salta las registradas aunque la sonda exista', async () => {
    const db = fakeDb({ ledger: [1], hasProbeColumn: true });
    const r = await runMigrations(db.query, dir);
    expect(r.skipped).toEqual(['001_one']);
    expect(r.applied).toEqual(['002_two']);
    expect(db.executed).toHaveLength(2);
  });

  it('tolera "ya existe" (columna/índice/tabla) y sigue', async () => {
    const db = fakeDb({ failWith: { 'ALTER TABLE t ADD COLUMN a INT': 'ER_DUP_FIELDNAME', 'ALTER TABLE t ADD INDEX i (a)': 'ER_DUP_KEYNAME' } });
    const r = await runMigrations(db.query, dir);
    expect(r.applied).toEqual(['001_one', '002_two']);
    expect([...db.ledger]).toEqual([1, 2]);
  });

  it('cualquier otro error aborta y NO registra la migración', async () => {
    const db = fakeDb({ failWith: { 'CREATE TABLE IF NOT EXISTS u (id INT)': 'ER_PARSE_ERROR' } });
    await expect(runMigrations(db.query, dir)).rejects.toThrow('ER_PARSE_ERROR');
    expect([...db.ledger]).toEqual([1]);
  });

  it('segunda pasada no repite nada', async () => {
    const db = fakeDb();
    await runMigrations(db.query, dir);
    const before = db.executed.length;
    const r = await runMigrations(db.query, dir);
    expect(r.applied).toEqual([]);
    expect(r.skipped).toEqual(['001_one', '002_two']);
    expect(db.executed.length).toBe(before);
  });

  it('sin directorio: no hace nada', async () => {
    const db = fakeDb();
    const r = await runMigrations(db.query, null);
    expect(r).toEqual({ applied: [], baselined: [], skipped: [] });
    expect(db.query).not.toHaveBeenCalled();
  });
});
