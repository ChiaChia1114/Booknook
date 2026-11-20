import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { MIGRATIONS } from './schema';

export type SqlValue = string | number | bigint | null | Uint8Array;
type Param = SqlValue | boolean | undefined;

const toSql = (v: Param): SqlValue => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

/**
 * Thin synchronous wrapper around node:sqlite with a statement cache,
 * boolean/undefined parameter coercion and nested transactions (savepoints).
 */
export class Db {
  readonly raw: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();
  private txDepth = 0;

  constructor(file: string) {
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (file !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  get<T = Record<string, unknown>>(sql: string, ...params: Param[]): T | undefined {
    return this.stmt(sql).get(...params.map(toSql)) as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, ...params: Param[]): T[] {
    return this.stmt(sql).all(...params.map(toSql)) as T[];
  }

  run(sql: string, ...params: Param[]): { changes: number } {
    const r = this.stmt(sql).run(...params.map(toSql));
    return { changes: Number(r.changes) };
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /** Runs fn inside a transaction (savepoint when nested). Rolls back on throw. */
  tx<T>(fn: () => T): T {
    const name = `sp${this.txDepth}`;
    this.raw.exec(this.txDepth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
    this.txDepth++;
    try {
      const result = fn();
      this.txDepth--;
      this.raw.exec(this.txDepth === 0 ? 'COMMIT' : `RELEASE ${name}`);
      return result;
    } catch (err) {
      this.txDepth--;
      this.raw.exec(this.txDepth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`);
      throw err;
    }
  }

  migrate(): void {
    this.raw.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    const row = this.get<{ version: number }>('SELECT version FROM schema_version');
    let version = row?.version ?? 0;
    if (!row) this.run('INSERT INTO schema_version (version) VALUES (0)');
    for (let i = version; i < MIGRATIONS.length; i++) {
      this.tx(() => {
        this.raw.exec(MIGRATIONS[i]!);
        this.run('UPDATE schema_version SET version = ?', i + 1);
      });
      version = i + 1;
    }
  }

  close(): void {
    this.cache.clear();
    this.raw.close();
  }
}

export function openDb(file: string): Db {
  const db = new Db(file);
  db.migrate();
  return db;
}

/** Parses a JSON column, returning the fallback on null/invalid content. */
export function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string' || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
