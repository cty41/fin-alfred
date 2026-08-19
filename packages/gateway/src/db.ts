import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { Decimal, d } from "@fin-alfred/core";

export function defaultDataDir(): string {
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share");
  return path.join(local, "fin-alfred");
}

export interface DbOptions {
  dataDir?: string;
  dbPath?: string;
}

export function openDatabase(opts?: DbOptions): DatabaseSync {
  const dataDir = opts?.dataDir ?? defaultDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = opts?.dbPath ?? path.join(dataDir, "alfred.db");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);
INSERT OR IGNORE INTO schema_version (version) VALUES (1);
`);
  const row = db.prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").get() as { version: number };
  if (row.version < 2) {
    db.exec(`
CREATE TABLE IF NOT EXISTS watchlist (
  instrument_id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'HKD',
  added_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS financials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instrument_id TEXT NOT NULL,
  year INTEGER NOT NULL,
  currency TEXT NOT NULL,
  revenue TEXT NOT NULL,
  net_income TEXT NOT NULL,
  cash TEXT NOT NULL,
  debt TEXT NOT NULL,
  equity TEXT NOT NULL,
  operating_cash_flow TEXT NOT NULL,
  capex TEXT NOT NULL,
  source_url TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(instrument_id, year)
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  side TEXT NOT NULL,
  traded_at TEXT NOT NULL,
  quantity TEXT NOT NULL,
  price TEXT NOT NULL,
  stamp_duty TEXT NOT NULL DEFAULT '0',
  clearing_fee TEXT NOT NULL DEFAULT '0',
  transfer_fee TEXT NOT NULL DEFAULT '0',
  commission TEXT NOT NULL DEFAULT '0',
  external_id TEXT,
  execution_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS positions (
  profile_id TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  quantity TEXT NOT NULL,
  cash TEXT NOT NULL DEFAULT '0',
  PRIMARY KEY (profile_id, instrument_id)
);

CREATE TABLE IF NOT EXISTS strategies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instrument_id TEXT NOT NULL,
  side TEXT NOT NULL DEFAULT 'reduce',
  baseline_quantity TEXT NOT NULL,
  stages_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS recommendations (
  decision_key TEXT PRIMARY KEY,
  instrument_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  target_quantity TEXT NOT NULL,
  filled_quantity TEXT NOT NULL DEFAULT '0',
  resolution_reason TEXT,
  superseded_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS session_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS price_cache (
  instrument_id TEXT NOT NULL,
  price TEXT NOT NULL,
  previous_close TEXT,
  observed_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'akshare',
  PRIMARY KEY (instrument_id, observed_at)
);

CREATE TABLE IF NOT EXISTS assessments (
  instrument_id TEXT NOT NULL,
  gate TEXT NOT NULL,
  li_lu_json TEXT NOT NULL,
  burry_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (instrument_id, content_hash)
);
`);
    db.exec("INSERT OR REPLACE INTO schema_version (version) VALUES (2)");
  }
}

// ---- Watchlist ----
export function watchlistAdd(db: DatabaseSync, instrumentId: string, symbol: string, name: string, currency = "HKD"): void {
  db.prepare("INSERT OR IGNORE INTO watchlist (instrument_id, symbol, name, currency) VALUES (?, ?, ?, ?)")
    .run(instrumentId, symbol, name, currency);
}

export function watchlistRemove(db: DatabaseSync, instrumentId: string): void {
  db.prepare("DELETE FROM watchlist WHERE instrument_id = ?").run(instrumentId);
}

export function watchlistList(db: DatabaseSync): Array<{ instrumentId: string; symbol: string; name: string; currency: string }> {
  const rows = db.prepare("SELECT instrument_id, symbol, name, currency FROM watchlist ORDER BY added_at").all() as any[];
  return rows.map((r) => ({ instrumentId: r.instrument_id, symbol: r.symbol, name: r.name, currency: r.currency }));
}

// ---- Positions ----
export function getOrCreatePosition(db: DatabaseSync, profileId: string, instrumentId: string, initQty = "0", initCash = "0"): { quantity: string; cash: string } {
  db.prepare("INSERT OR IGNORE INTO positions (profile_id, instrument_id, quantity, cash) VALUES (?, ?, ?, ?)")
    .run(profileId, instrumentId, initQty, initCash);
  const row = db.prepare("SELECT quantity, cash FROM positions WHERE profile_id = ? AND instrument_id = ?")
    .get(profileId, instrumentId) as { quantity: string; cash: string };
  return row;
}

export function updatePosition(db: DatabaseSync, profileId: string, instrumentId: string, quantity: string, cash: string): void {
  db.prepare("UPDATE positions SET quantity = ?, cash = ? WHERE profile_id = ? AND instrument_id = ?")
    .run(quantity, cash, profileId, instrumentId);
}

// ---- Ledger ----
export function recordExecution(db: DatabaseSync, profileId: string, instrumentId: string, side: string, tradedAt: string, quantity: string, price: string, fees: { stampDuty: string; clearingFee: string; transferFee: string; commission: string }, externalId: string | null): "applied" | "duplicate" {
  const key = createHash("sha256")
    .update([profileId, instrumentId, side, tradedAt, quantity, price, externalId ?? ""].join("|"))
    .digest("hex");
  try {
    db.prepare(`INSERT INTO ledger_entries (profile_id, instrument_id, side, traded_at, quantity, price, stamp_duty, clearing_fee, transfer_fee, commission, external_id, execution_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(profileId, instrumentId, side, tradedAt, quantity, price, fees.stampDuty, fees.clearingFee, fees.transferFee, fees.commission, externalId, key);
    return "applied";
  } catch (e: any) {
    if (String(e.message).includes("UNIQUE")) return "duplicate";
    throw e;
  }
}

export function getLedgerEntries(db: DatabaseSync, profileId: string, instrumentId: string): any[] {
  return db.prepare("SELECT * FROM ledger_entries WHERE profile_id = ? AND instrument_id = ? ORDER BY traded_at")
    .all(profileId, instrumentId);
}

// ---- Sessions ----
export function createSession(db: DatabaseSync, id: string, title = ""): void {
  db.prepare("INSERT INTO sessions (id, title) VALUES (?, ?)").run(id, title);
}

export function listSessions(db: DatabaseSync): any[] {
  return db.prepare("SELECT id, title, created_at, updated_at FROM sessions ORDER BY updated_at DESC").all();
}

export function addSessionMessage(db: DatabaseSync, sessionId: string, role: string, content: string): void {
  db.prepare("INSERT INTO session_messages (session_id, role, content) VALUES (?, ?, ?)").run(sessionId, role, content);
  db.prepare("UPDATE sessions SET updated_at = datetime('now') WHERE id = ?").run(sessionId);
}

export function getSessionMessages(db: DatabaseSync, sessionId: string): any[] {
  return db.prepare("SELECT role, content, created_at FROM session_messages WHERE session_id = ? ORDER BY id").all(sessionId);
}

// ---- Price cache ----
export function cachePrice(db: DatabaseSync, instrumentId: string, price: string, previousClose: string | null, observedAt: string, source = "akshare"): void {
  db.prepare("INSERT OR REPLACE INTO price_cache (instrument_id, price, previous_close, observed_at, source) VALUES (?, ?, ?, ?, ?)")
    .run(instrumentId, price, previousClose, observedAt, source);
}

export function getLatestPrice(db: DatabaseSync, instrumentId: string): { price: string; previousClose: string | null; observedAt: string; source: string } | undefined {
  const row = db.prepare("SELECT price, previous_close, observed_at, source FROM price_cache WHERE instrument_id = ? ORDER BY observed_at DESC LIMIT 1").get(instrumentId) as any;
  if (!row) return undefined;
  return { price: row.price, previousClose: row.previous_close, observedAt: row.observed_at, source: row.source };
}

// ---- Strategies ----
export function saveStrategy(db: DatabaseSync, instrumentId: string, side: string, baselineQuantity: string, stagesJson: string): number {
  const result = db.prepare("INSERT INTO strategies (instrument_id, side, baseline_quantity, stages_json) VALUES (?, ?, ?, ?)")
    .run(instrumentId, side, baselineQuantity, stagesJson);
  return Number(result.lastInsertRowid);
}

export function getActiveStrategy(db: DatabaseSync, instrumentId: string): any | undefined {
  return db.prepare("SELECT * FROM strategies WHERE instrument_id = ? AND active = 1 ORDER BY created_at DESC LIMIT 1").get(instrumentId);
}

// ---- Recommendations ----
export function saveRecommendation(db: DatabaseSync, rec: { decisionKey: string; instrumentId: string; snapshotJson: string; status: string; targetQuantity: string; filledQuantity: string }): void {
  db.prepare(`INSERT OR REPLACE INTO recommendations (decision_key, instrument_id, snapshot_json, status, target_quantity, filled_quantity) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(rec.decisionKey, rec.instrumentId, rec.snapshotJson, rec.status, rec.targetQuantity, rec.filledQuantity);
}

// ---- Assessments ----
export function saveAssessment(db: DatabaseSync, instrumentId: string, gate: string, liLuJson: string, burryJson: string, contentHash: string): void {
  db.prepare("INSERT OR REPLACE INTO assessments (instrument_id, gate, li_lu_json, burry_json, content_hash) VALUES (?, ?, ?, ?, ?)")
    .run(instrumentId, gate, liLuJson, burryJson, contentHash);
}

export function getLatestAssessment(db: DatabaseSync, instrumentId: string): any | undefined {
  return db.prepare("SELECT * FROM assessments WHERE instrument_id = ? ORDER BY created_at DESC LIMIT 1").get(instrumentId);
}

// ---- Financials ----
export function upsertFinancials(db: DatabaseSync, fin: { instrumentId: string; year: number; currency: string; revenue: string; netIncome: string; cash: string; debt: string; equity: string; operatingCashFlow: string; capex: string; sourceUrl: string }): void {
  db.prepare(`INSERT OR REPLACE INTO financials (instrument_id, year, currency, revenue, net_income, cash, debt, equity, operating_cash_flow, capex, source_url, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
    .run(fin.instrumentId, fin.year, fin.currency, fin.revenue, fin.netIncome, fin.cash, fin.debt, fin.equity, fin.operatingCashFlow, fin.capex, fin.sourceUrl);
}

export function getFinancials(db: DatabaseSync, instrumentId: string): any[] {
  return db.prepare("SELECT * FROM financials WHERE instrument_id = ? ORDER BY year DESC").all(instrumentId);
}

