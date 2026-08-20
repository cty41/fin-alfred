import { AkshareProvider } from '@fin-alfred/provider-akshare'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SUPPORTED_INSTRUMENTS, type AlfredPluginConfig, type InstrumentId, type ToolEnvelope } from './types.js'

const PEERS = Object.keys(SUPPORTED_INSTRUMENTS) as InstrumentId[]

export interface MarketProvider {
  fetchPrices(symbol: string, signal?: AbortSignal): Promise<Array<{ symbol: string; price?: string | number; previousClose?: string | number; observedAt?: string; source?: string }>>
  fetchRelative(symbol: string, peers?: string[], signal?: AbortSignal): Promise<Record<string, unknown>>
}

export function normalizeInstrument(value: string): InstrumentId {
  const raw = value.trim()
  const aliases: Record<string, InstrumentId> = {
    小米: 'HKEX:1810', '小米集团': 'HKEX:1810', '小米集团-W': 'HKEX:1810',
    腾讯: 'HKEX:0700', '腾讯控股': 'HKEX:0700',
    阿里: 'HKEX:9988', '阿里巴巴': 'HKEX:9988', '阿里巴巴-W': 'HKEX:9988',
  }
  if (aliases[raw]) return aliases[raw]
  const normalized = raw.toUpperCase().replace(/\.HK$/u, '').replace(/^HKEX:/u, '')
  const id = `HKEX:${normalized.padStart(4, '0')}` as InstrumentId
  if (!(id in SUPPORTED_INSTRUMENTS)) {
    throw new Error('当前原型只支持 HKEX:1810、HKEX:0700、HKEX:9988。')
  }
  return id
}

export class AlfredResearchService {
  private readonly provider: MarketProvider

  constructor(private readonly config: AlfredPluginConfig, provider?: MarketProvider) {
    this.provider = provider ?? new AkshareProvider({
      pythonPath: config.pythonPath,
      adapterPath: config.adapterPath,
      timeoutMs: config.timeoutMs,
    })
  }

  async quote(value: string, signal?: AbortSignal): Promise<ToolEnvelope> {
    const instrumentId = normalizeInstrument(value)
    try {
      const rows = await this.provider.fetchPrices(SUPPORTED_INSTRUMENTS[instrumentId].symbol, signal)
      const row = rows.at(-1)
      if (!row) return { ok: false, instrumentId, error: '数据源未返回行情。' }
      const data = {
        name: SUPPORTED_INSTRUMENTS[instrumentId].name,
        symbol: SUPPORTED_INSTRUMENTS[instrumentId].symbol,
        price: row.price,
        previousClose: row.previousClose,
        observedAt: row.observedAt,
        source: row.source,
      }
      return {
        ok: true,
        instrumentId,
        data,
        source: row.source ?? 'AKShare',
        observedAt: row.observedAt,
      }
    } catch (error) {
      return { ok: false, instrumentId, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async fundamentals(value: string, signal?: AbortSignal): Promise<ToolEnvelope> {
    const instrumentId = normalizeInstrument(value)
    try {
      const relative = await this.provider.fetchRelative(
        SUPPORTED_INSTRUMENTS[instrumentId].symbol,
        supportedPeerSymbols(instrumentId),
        signal,
      )
      const { peRaw: _peRaw, pcfRaw: _pcfRaw, ...summary } = relative
      return {
        ok: true,
        instrumentId,
        data: { name: SUPPORTED_INSTRUMENTS[instrumentId].name, ...summary },
        source: typeof relative.source === 'string' ? relative.source : 'AKShare / Baidu / Eastmoney',
        observedAt: typeof relative.fetchedAt === 'string' ? relative.fetchedAt : undefined,
      }
    } catch (error) {
      return { ok: false, instrumentId, error: error instanceof Error ? error.message : String(error) }
    }
  }

  portfolioContext(value: string): ToolEnvelope {
    const instrumentId = normalizeInstrument(value)
    const dbPath = this.config.dbPath || defaultDbPath()
    if (!fs.existsSync(dbPath)) {
      return { ok: true, instrumentId, data: { available: false }, warning: `未找到 Alfred 数据库：${dbPath}` }
    }
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const position = readOne(db, 'SELECT profile_id, quantity, cash FROM positions WHERE profile_id = ? AND instrument_id = ? LIMIT 1', 'default', instrumentId)
        const strategy = readOne(db, 'SELECT side, baseline_quantity, stages_json, created_at FROM strategies WHERE instrument_id = ? AND active = 1 ORDER BY created_at DESC LIMIT 1', instrumentId)
        return { ok: true, instrumentId, data: { available: true, position, strategy } }
      } finally {
        db.close()
      }
    } catch (error) {
      return { ok: false, instrumentId, error: `无法只读打开 Alfred 数据库：${error instanceof Error ? error.message : String(error)}` }
    }
  }
}

function readOne(db: DatabaseSync, sql: string, ...params: string[]): unknown {
  return db.prepare(sql).get(...params) ?? null
}

function defaultDbPath(): string {
  const dataDir = process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'share')
  return path.join(dataDir, 'fin-alfred', 'alfred.db')
}

export function createDefaultConfig(): AlfredPluginConfig {
  return {
    pythonPath: process.env.FIN_ALFRED_PYTHON_PATH ?? path.resolve(process.cwd(), 'data-provider/.venv/Scripts/python.exe'),
    adapterPath: process.env.FIN_ALFRED_AKSHARE_ADAPTER ?? path.resolve(process.cwd(), 'data-provider/akshare_adapter.py'),
    dbPath: process.env.FIN_ALFRED_DB_PATH ?? defaultDbPath(),
    timeoutMs: Number(process.env.FIN_ALFRED_AKSHARE_TIMEOUT_MS ?? 30_000),
  }
}

export function supportedPeerSymbols(instrumentId: InstrumentId): string[] {
  return PEERS.filter(peer => peer !== instrumentId).map(peer => SUPPORTED_INSTRUMENTS[peer].symbol)
}
