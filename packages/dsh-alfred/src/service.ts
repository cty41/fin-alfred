import { AkshareProvider } from '@fin-alfred/provider-akshare'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { accountMappingFor, latestReportDate, summarizeBalanceSheet, type RawStatement, type RawStatementRow } from '@fin-alfred/core'
import { SUPPORTED_INSTRUMENTS, type AlfredPluginConfig, type InstrumentId, type ToolEnvelope } from './types.js'

const PEERS = Object.keys(SUPPORTED_INSTRUMENTS) as InstrumentId[]

export interface MarketProvider {
  fetchPrices(symbol: string, signal?: AbortSignal): Promise<Array<{ symbol: string; price?: string | number; previousClose?: string | number; observedAt?: string; source?: string }>>
  fetchRelative(symbol: string, peers?: string[], signal?: AbortSignal): Promise<Record<string, unknown>>
  fetchFinancials?(symbol: string, indicator?: '报告期' | '年度', signal?: AbortSignal): Promise<Record<string, unknown>>
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
        nextSteps: {
          purpose: '这些是相对估值分位（历史/PCT），不是内在价值。要产出 Bear/Base/Bull 每股价值与 Base IRR，还需要财报证据。',
          requiredFields: [
            { field: '最新报告期', note: '报告期与日期（如 2026-06-30，来源日期）' },
            { field: '营业收入 / 同比', note: '及历史 3–5 年趋势' },
            { field: '归母净利润（IFRS 或 Non-IFRS）', note: '标注口径' },
            { field: '自由现金流或每股经营现金流', note: '用于 DCF/现金流锚' },
            { field: '分部收入', note: '腾讯：增值服务/网络广告/金融科技与企业服务' },
            { field: '净现金 / 投资组合公允价值', note: '影响估值方式' },
            { field: '股本 / 摊薄股数', note: '算每股价值' },
            { field: '折现参数', note: '无风险利率、股权风险溢价/贴现率、长期增长率假设' },
          ],
          akShareNote: 'AKShare 港股财务摘要接口（东方财富二手汇总，非腾讯 IR 官方 PDF）可补多数汇总字段（收入、净利、EPS、每股经营现金流等，HKD 口径），但分部/净现金/投资组合明细通常需官方财报。',
        },
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

  async financialStatements(value: string, indicator: '报告期' | '年度' = '报告期', signal?: AbortSignal): Promise<ToolEnvelope> {
    const instrumentId = normalizeInstrument(value)
    if (typeof this.provider.fetchFinancials !== 'function') {
      return { ok: false, instrumentId, error: '当前市场数据提供方不支持财务报表明细。' }
    }
    try {
      const raw = await this.provider.fetchFinancials(SUPPORTED_INSTRUMENTS[instrumentId].symbol, indicator, signal)
      const mapping = accountMappingFor(instrumentId)
      const statements = normalizeStatementSet(raw)
      const balanceRows = statements.find(s => s.kind === 'balance')?.rows ?? []
      const latestDate = latestReportDate(balanceRows)
      const currency = typeof raw.currency === 'string' ? raw.currency : undefined
      const summary = latestDate
        ? { reportDate: latestDate, currency, balance: summarizeBalanceSheet(balanceRows, mapping) }
        : undefined
      return {
        ok: true,
        instrumentId,
        data: {
          name: SUPPORTED_INSTRUMENTS[instrumentId].name,
          symbol: SUPPORTED_INSTRUMENTS[instrumentId].symbol,
          indicator,
          statements,
          summary,
        },
        source: typeof raw.source === 'string' ? raw.source : 'AKShare / Eastmoney (datacenter)',
        observedAt: typeof raw.fetchedAt === 'string' ? raw.fetchedAt : undefined,
      }
    } catch (error) {
      return { ok: false, instrumentId, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

function readOne(db: DatabaseSync, sql: string, ...params: string[]): unknown {
  return db.prepare(sql).get(...params) ?? null
}

const STATEMENT_KINDS = ['balance', 'income', 'cashflow'] as const

function normalizeStatementSet(raw: Record<string, unknown>): RawStatement[] {
  const statementsRaw = (raw.statements ?? {}) as Record<string, Array<Record<string, unknown>>>
  const result: RawStatement[] = []
  for (const kind of STATEMENT_KINDS) {
    const rows = (statementsRaw[kind] ?? []).map(normalizeStatementRow)
    result.push({ kind, reportDates: uniqueReportDates(rows), rows })
  }
  return result
}

function normalizeStatementRow(source: Record<string, unknown>): RawStatementRow {
  const row: RawStatementRow = {
    stdItemName: typeof source.STD_ITEM_NAME === 'string' ? source.STD_ITEM_NAME : undefined,
    amount: typeof source.AMOUNT === 'number' ? source.AMOUNT : null,
    reportDate: typeof source.REPORT_DATE === 'string' ? source.REPORT_DATE.slice(0, 10) : undefined,
    stdItemCode: typeof source.STD_ITEM_CODE === 'string' ? source.STD_ITEM_CODE : undefined,
    fiscalYear: typeof source.FISCAL_YEAR === 'string' ? source.FISCAL_YEAR : undefined,
  }
  return row
}

function uniqueReportDates(rows: RawStatementRow[]): string[] {
  const set = new Set<string>()
  for (const row of rows) if (row.reportDate) set.add(row.reportDate)
  return [...set].sort((a, b) => (a < b ? 1 : -1))
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
