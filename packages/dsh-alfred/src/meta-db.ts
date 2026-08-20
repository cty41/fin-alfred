import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Market-data and security-master cache for dsh-alfred.
 *
 * This is deliberately a SEPARATE database from the ledger (`dbPath`, default
 * `fin-alfred/alfred.db`). The ledger holds personal positions and executions
 * under its own transactional write boundary; this cache holds reproducible,
 * refreshable reference data:
 *   - hk_securities      (full HK code -> name/currency list)
 *   - financial_cache    (three-statement snapshots keyed by code + period + statement)
 *   - price_cache        (latest price snapshots)
 *
 * The two files must not share a path: the legacy standalone gateway also used
 * `fin-alfred/alfred.db` with a different schema, so this cache uses its own
 * filename to avoid any schema collision.
 */

export const DEFAULT_META_DB_FILENAME = 'alfred-meta.db'

export interface MetaDbOptions {
  /** Directory holding the meta database. Defaults to %LOCALAPPDATA%/fin-alfred. */
  dataDir?: string
  /** Absolute path to the meta database file. Overrides dataDir + filename. */
  dbPath?: string
}

export interface HkSecurity {
  code: string
  nameZh: string
  nameEn: string
  currency: string
  updatedAt: string
}

export interface CachedFinancialStatement {
  instrumentId: string
  period: string
  kind: 'balance' | 'income' | 'cashflow'
  /** Raw rows exactly as returned by the adapter (audit trail). */
  rowsJson: string
  currency: string
  fetchedAt: string
}

export function defaultMetaDataDir(): string {
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'share')
  return path.join(local, 'fin-alfred')
}

function resolveMetaDbPath(opts?: MetaDbOptions): string {
  if (opts?.dbPath) return opts.dbPath
  const dir = opts?.dataDir ?? defaultMetaDataDir()
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, DEFAULT_META_DB_FILENAME)
}

export class AlfredMetaDb {
  private readonly dbPath: string

  constructor(opts?: MetaDbOptions) {
    this.dbPath = resolveMetaDbPath(opts)
  }

  open(): DatabaseSync {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true })
    const db = new DatabaseSync(this.dbPath)
    db.exec('PRAGMA journal_mode=WAL')
    db.exec('PRAGMA foreign_keys=ON')
    migrate(db)
    return db
  }

  // ---- Securities master ----

  upsertSecurities(securities: HkSecurity[]): void {
    const db = this.open()
    try {
      const stmt = db.prepare(
        'INSERT INTO hk_securities (code, name_zh, name_en, currency, updated_at) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(code) DO UPDATE SET name_zh = excluded.name_zh, name_en = excluded.name_en, currency = excluded.currency, updated_at = excluded.updated_at',
      )
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const s of securities) stmt.run(s.code, s.nameZh, s.nameEn, s.currency, s.updatedAt)
        db.exec('COMMIT')
      } catch (e) {
        try { db.exec('ROLLBACK') } catch {}
        throw e
      }
    } finally {
      db.close()
    }
  }

  getSecurity(code: string): HkSecurity | undefined {
    const db = this.open()
    try {
      const row = db.prepare('SELECT code, name_zh, name_en, currency, updated_at FROM hk_securities WHERE code = ?').get(code) as { code: string; name_zh: string; name_en: string; currency: string; updated_at: string } | undefined
      return row ? { code: row.code, nameZh: row.name_zh, nameEn: row.name_en, currency: row.currency, updatedAt: row.updated_at } : undefined
    } finally {
      db.close()
    }
  }

  listSecurities(): HkSecurity[] {
    const db = this.open()
    try {
      const rows = db.prepare('SELECT code, name_zh, name_en, currency, updated_at FROM hk_securities ORDER BY code').all() as Array<{ code: string; name_zh: string; name_en: string; currency: string; updated_at: string }>
      return rows.map(row => ({ code: row.code, nameZh: row.name_zh, nameEn: row.name_en, currency: row.currency, updatedAt: row.updated_at }))
    } finally {
      db.close()
    }
  }

  securitiesUpdatedAt(): string | undefined {
    const db = this.open()
    try {
      const row = db.prepare('SELECT MAX(updated_at) AS t FROM hk_securities').get() as { t: string | null }
      return row?.t ?? undefined
    } finally {
      db.close()
    }
  }

  // ---- Financial statement cache ----

  upsertFinancial(kind: CachedFinancialStatement['kind'], instrumentId: string, period: string, rowsJson: string, currency: string, fetchedAt: string): void {
    const db = this.open()
    try {
      db.prepare(
        'INSERT INTO financial_cache (instrument_id, period, statement_kind, rows_json, currency, fetched_at) VALUES (?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(instrument_id, period, statement_kind) DO UPDATE SET rows_json = excluded.rows_json, currency = excluded.currency, fetched_at = excluded.fetched_at',
      ).run(instrumentId, period, kind, rowsJson, currency, fetchedAt)
    } finally {
      db.close()
    }
  }

  getFinancial(instrumentId: string, period: string, kind: CachedFinancialStatement['kind']): CachedFinancialStatement | undefined {
    const db = this.open()
    try {
      const row = db.prepare('SELECT instrument_id, period, statement_kind, rows_json, currency, fetched_at FROM financial_cache WHERE instrument_id = ? AND period = ? AND statement_kind = ?').get(instrumentId, period, kind) as { instrument_id: string; period: string; statement_kind: string; rows_json: string; currency: string; fetched_at: string } | undefined
      return row ? { instrumentId: row.instrument_id, period: row.period, kind: row.statement_kind as CachedFinancialStatement['kind'], rowsJson: row.rows_json, currency: row.currency, fetchedAt: row.fetched_at } : undefined
    } finally {
      db.close()
    }
  }

  // ---- Price cache ----

  upsertPrice(instrumentId: string, price: string, previousClose: string | null, observedAt: string, source: string): void {
    const db = this.open()
    try {
      db.prepare('INSERT INTO price_cache (instrument_id, price, previous_close, observed_at, source) VALUES (?, ?, ?, ?, ?) ON CONFLICT(instrument_id, observed_at) DO UPDATE SET price = excluded.price, previous_close = excluded.previous_close, source = excluded.source').run(instrumentId, price, previousClose, observedAt, source)
    } finally {
      db.close()
    }
  }

  getLatestPrice(instrumentId: string): { price: string; previousClose: string | null; observedAt: string; source: string } | undefined {
    const db = this.open()
    try {
      const row = db.prepare('SELECT price, previous_close, observed_at, source FROM price_cache WHERE instrument_id = ? ORDER BY observed_at DESC LIMIT 1').get(instrumentId) as { price: string; previous_close: string | null; observed_at: string; source: string } | undefined
      return row ? { price: row.price, previousClose: row.previous_close, observedAt: row.observed_at, source: row.source } : undefined
    } finally {
      db.close()
    }
  }
}

function migrate(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);
INSERT OR IGNORE INTO schema_version (version) VALUES (1);
`)
  const cur = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number }
  if (cur.version < 2) {
    db.exec(`
CREATE TABLE IF NOT EXISTS hk_securities (
  code TEXT PRIMARY KEY,
  name_zh TEXT NOT NULL,
  name_en TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'HKD',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS financial_cache (
  instrument_id TEXT NOT NULL,
  period TEXT NOT NULL,
  statement_kind TEXT NOT NULL,
  rows_json TEXT NOT NULL,
  currency TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (instrument_id, period, statement_kind)
);
CREATE TABLE IF NOT EXISTS price_cache (
  instrument_id TEXT NOT NULL,
  price TEXT NOT NULL,
  previous_close TEXT,
  observed_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'akshare',
  PRIMARY KEY (instrument_id, observed_at)
);
`)
    db.exec('INSERT OR REPLACE INTO schema_version (version) VALUES (2)')
  }
}
