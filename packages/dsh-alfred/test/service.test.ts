import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AlfredResearchService, normalizeInstrument, supportedPeerSymbols, type MarketProvider } from '../src/service.js'
import { apply } from '../src/index.js'
import { AlfredLedgerService } from '../src/ledger.js'
import { evaluateValueStrategy } from '../src/strategy.js'

const config = { pythonPath: 'python', adapterPath: 'adapter.py', dbPath: '', timeoutMs: 1_000 }

function provider(): MarketProvider {
  return {
    async fetchPrices(symbol) {
      return [{ symbol, price: 25.5, previousClose: 25, observedAt: '2026-08-20', source: 'test' }]
    },
    async fetchRelative(symbol) {
      return { fetchedAt: '2026-08-20T00:00:00Z', source: 'test', symbol, pe: { current: '20' } }
    },
  }
}

describe('dsh-alfred research service', () => {
  it.each([
    ['HKEX:1810', 'HKEX:1810'],
    ['1810.HK', 'HKEX:1810'],
    ['700', 'HKEX:0700'],
    ['9988', 'HKEX:9988'],
    ['腾讯控股', 'HKEX:0700'],
    ['阿里巴巴', 'HKEX:9988'],
  ])('normalizes %s to %s', (value, expected) => {
    expect(normalizeInstrument(value)).toBe(expected)
  })

  it('rejects unsupported instruments', () => {
    expect(() => normalizeInstrument('600519.SH')).toThrow(/只支持/)
  })

  it('returns a bounded quote envelope for each supported stock', async () => {
    const service = new AlfredResearchService(config, provider())
    for (const instrument of ['HKEX:1810', 'HKEX:0700', 'HKEX:9988']) {
      await expect(service.quote(instrument)).resolves.toMatchObject({ ok: true, instrumentId: instrument, source: 'test' })
    }
  })

  it('passes peer symbols and cancellation to the fundamentals provider', async () => {
    let receivedPeers: string[] | undefined
    let receivedSignal: AbortSignal | undefined
    const market = provider()
    market.fetchRelative = async (symbol, peers, signal) => {
      receivedPeers = peers
      receivedSignal = signal
      return { fetchedAt: '2026-08-20T00:00:00Z', source: 'test', symbol, peers }
    }
    const service = new AlfredResearchService(config, market)
    const controller = new AbortController()
    await expect(service.fundamentals('HKEX:1810')).resolves.toMatchObject({ ok: true, data: { symbol: '01810' } })
    expect(supportedPeerSymbols('HKEX:1810')).toEqual(['00700', '09988'])
    await service.fundamentals('HKEX:1810', controller.signal)
    expect(receivedPeers).toEqual(['00700', '09988'])
    expect(receivedSignal).toBe(controller.signal)
  })

  it('keeps fundamentals bounded by omitting raw valuation series', async () => {
    const market = provider()
    market.fetchRelative = async symbol => ({ symbol, pe: { current: '20' }, peRaw: [{ date: '2026-08-20', value: 20 }], pcfRaw: [] })
    const service = new AlfredResearchService(config, market)
    const result = await service.fundamentals('HKEX:1810')
    expect(result).toMatchObject({ ok: true, data: { name: '小米集团-W', symbol: '01810', pe: { current: '20' } } })
    expect(result.data).not.toHaveProperty('peRaw')
    expect(result.data).not.toHaveProperty('pcfRaw')
  })

  it('attaches nextSteps guidance to fundamentals so the model asks for financial evidence, not intrinsic value', async () => {
    const service = new AlfredResearchService(config, provider())
    const result = await service.fundamentals('HKEX:0700')
    expect(result).toMatchObject({ ok: true, instrumentId: 'HKEX:0700' })
    expect(result.nextSteps).toMatchObject({ purpose: expect.stringContaining('内在价值') })
    expect(Array.isArray(result.nextSteps?.requiredFields)).toBe(true)
    expect(result.nextSteps!.requiredFields.length).toBeGreaterThanOrEqual(6)
    expect(result.nextSteps!.requiredFields.map(f => f.field)).toEqual(expect.arrayContaining(['最新报告期', '自由现金流或每股经营现金流', '股本 / 摊薄股数']))
  })

  it('reports an incompatible Alfred database instead of treating it as empty', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-alfred-'))
    const dbPath = path.join(tempDir, 'alfred.db')
    new DatabaseSync(dbPath).close()
    try {
      const service = new AlfredResearchService({ ...config, dbPath }, provider())
      expect(service.portfolioContext('HKEX:1810')).toMatchObject({ ok: false, instrumentId: 'HKEX:1810' })
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('normalizes financial statements into raw + standard-account summary', async () => {
    const market = provider()
    market.fetchFinancials = async () => ({
      fetchedAt: '2026-08-20T00:00:00Z',
      source: 'AKShare / Eastmoney (datacenter)',
      currency: 'HKD',
      statements: {
        balance: [
          { STD_ITEM_NAME: '现金及等价物', AMOUNT: 100, REPORT_DATE: '2026-06-30 00:00:00' },
          { STD_ITEM_NAME: '短期贷款', AMOUNT: 50, REPORT_DATE: '2026-06-30 00:00:00' },
          { STD_ITEM_NAME: '总资产', AMOUNT: 1000, REPORT_DATE: '2026-06-30 00:00:00' },
        ],
        income: [{ STD_ITEM_NAME: '营运收入', AMOUNT: 4000, REPORT_DATE: '2026-06-30 00:00:00' }],
        cashflow: [],
      },
    })
    const service = new AlfredResearchService(config, market)
    const result = await service.financialStatements('HKEX:0700', '报告期')
    expect(result).toMatchObject({ ok: true, instrumentId: 'HKEX:0700' })
    expect(result.data).toMatchObject({ symbol: '00700', indicator: '报告期' })
    const statements = result.data!.statements
    expect(statements.map((s: { kind: string }) => s.kind)).toEqual(['balance', 'income', 'cashflow'])
    const summary = result.data!.summary
    expect(summary.reportDate).toBe('2026-06-30')
    expect(summary.currency).toBe('HKD')
    expect(summary.balance.cashAndEquivalents.toString()).toBe('100')
    expect(summary.balance.interestBearingDebt.toString()).toBe('50')
    expect(summary.balance.totalAssets.toString()).toBe('1000')
  })

  it('reports a degraded state when the provider lacks financial statements', async () => {
    const market = provider()
    delete (market as Record<string, unknown>).fetchFinancials
    const service = new AlfredResearchService(config, market)
    await expect(service.financialStatements('HKEX:0700')).resolves.toMatchObject({ ok: false, instrumentId: 'HKEX:0700' })
  })

  it('registers research, strategy and confirmed-ledger tools', () => {
    const registered: Array<{ name: string }> = []
    apply({
      tools: { register: (tool: { name: string }) => registered.push(tool) },
      skills: { register: () => undefined },
      on: () => undefined,
    } as never, config)
    expect(registered.map(tool => tool.name)).toEqual([
      'alfred_stock_quote',
      'alfred_stock_fundamentals',
      'alfred_portfolio_context',
      'alfred_financial_statements',
      'alfred_value_strategy',
      'alfred_prepare_execution',
      'alfred_commit_execution',
      'alfred_prepare_initial_position',
      'alfred_commit_initial_position',
    ])
  })
})

describe('value strategy invariants', () => {
  it('creates a build candidate only inside the safety gates', () => {
    expect(evaluateValueStrategy({ instrumentId: '腾讯', currentPrice: 80, bearValue: 65, baseValue: 110, bullValue: 140, baseIrr: 0.16 }).state).toBe('build-candidate')
    expect(evaluateValueStrategy({ instrumentId: '腾讯', currentPrice: 100, bearValue: 60, baseValue: 110, bullValue: 140, baseIrr: 0.16 }).state).toBe('wait')
  })

  it('fails closed for missing data and red lines', () => {
    const base = { instrumentId: '阿里', currentPrice: 80, bearValue: 70, baseValue: 120, bullValue: 150, baseIrr: 0.2 }
    expect(evaluateValueStrategy({ ...base, dataComplete: false }).state).toBe('data-insufficient')
    expect(evaluateValueStrategy({ ...base, redLine: true }).state).toBe('exit-review')
  })

  it('returns a structured missing-field list for data-insufficient state', () => {
    const result = evaluateValueStrategy({ instrumentId: '腾讯', currentPrice: 447.2, bearValue: 300, baseValue: 450, bullValue: 600, baseIrr: 0.12, dataComplete: false })
    expect(result.state).toBe('data-insufficient')
    expect(Array.isArray(result.missingInputs)).toBe(true)
    expect(result.missingInputs).toEqual(expect.arrayContaining([
      expect.stringContaining('Bear/Base/Bull'),
      expect.stringContaining('Base IRR'),
      expect.stringContaining('口径与来源日期'),
    ]))
  })

  it('does not improve margin of safety when price rises', () => {
    const base = { instrumentId: '阿里', bearValue: 70, baseValue: 120, bullValue: 150, baseIrr: 0.12 }
    expect(evaluateValueStrategy({ ...base, currentPrice: 90 }).priceToBase).toBeLessThan(evaluateValueStrategy({ ...base, currentPrice: 100 }).priceToBase)
  })
})

describe('confirmed ledger writes', () => {
  function database() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-alfred-ledger-'))
    const dbPath = path.join(tempDir, 'alfred.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE positions (profile_id TEXT NOT NULL, instrument_id TEXT NOT NULL, quantity TEXT NOT NULL, cash TEXT NOT NULL, PRIMARY KEY(profile_id, instrument_id));
      CREATE TABLE ledger_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT NOT NULL, instrument_id TEXT NOT NULL, side TEXT NOT NULL, traded_at TEXT NOT NULL, quantity TEXT NOT NULL, price TEXT NOT NULL, stamp_duty TEXT NOT NULL, clearing_fee TEXT NOT NULL, transfer_fee TEXT NOT NULL, commission TEXT NOT NULL, external_id TEXT, execution_key TEXT NOT NULL UNIQUE);
      INSERT INTO positions VALUES ('default', 'HKEX:1810', '213600', '395000');
    `)
    db.close()
    return { tempDir, dbPath }
  }

  it('previews without writing and commits atomically after confirmation', () => {
    const { tempDir, dbPath } = database()
    try {
      const ledger = new AlfredLedgerService(dbPath)
      const preview = ledger.prepareExecution({ instrumentId: '小米', side: 'sell', tradedAt: '2026-08-20', quantity: '1000', price: '30', fees: { commission: '10' } }, 's1')
      let db = new DatabaseSync(dbPath)
      expect(db.prepare('SELECT count(*) AS n FROM ledger_entries').get()).toEqual({ n: 0 })
      db.close()
      expect(ledger.commitExecution(preview.confirmationToken, 's1')).toMatchObject({ status: 'applied', position: { quantity: '212600', cash: '424990' } })
      db = new DatabaseSync(dbPath)
      expect(db.prepare('SELECT count(*) AS n FROM ledger_entries').get()).toEqual({ n: 1 })
      expect(db.prepare('SELECT quantity, cash FROM positions WHERE instrument_id = ?').get('HKEX:1810')).toEqual({ quantity: '212600', cash: '424990' })
      db.close()
      expect(() => ledger.commitExecution(preview.confirmationToken, 's1')).toThrow(/无效|已使用/)
    } finally { fs.rmSync(tempDir, { recursive: true, force: true }) }
  })

  it('binds confirmation to the session and rejects overselling before insertion', () => {
    const { tempDir, dbPath } = database()
    try {
      const ledger = new AlfredLedgerService(dbPath)
      expect(() => ledger.prepareExecution({ instrumentId: '小米', side: 'sell', tradedAt: '2026-08-20', quantity: '999999', price: '30' }, 's1')).toThrow(/超过/)
      const preview = ledger.prepareExecution({ instrumentId: '小米', side: 'sell', tradedAt: '2026-08-20', quantity: '1', price: '30' }, 's1')
      expect(() => ledger.commitExecution(preview.confirmationToken, 's2')).toThrow(/当前会话/)
      const db = new DatabaseSync(dbPath)
      expect(db.prepare('SELECT count(*) AS n FROM ledger_entries').get()).toEqual({ n: 0 })
      db.close()
    } finally { fs.rmSync(tempDir, { recursive: true, force: true }) }
  })

  it('uses fixed-point arithmetic and refuses an over-budget buy', () => {
    const { tempDir, dbPath } = database()
    try {
      const ledger = new AlfredLedgerService(dbPath)
      const preview = ledger.prepareExecution({ instrumentId: '小米', side: 'buy', tradedAt: '2026-08-20', quantity: '0.1', price: '0.2' }, 's1')
      expect(preview.preview).toMatchObject({ gross: '0.02', projected: { cash: '394999.98' } })
      expect(() => ledger.prepareExecution({ instrumentId: '小米', side: 'buy', tradedAt: '2026-08-20', quantity: '1000000', price: '1' }, 's1')).toThrow(/超过当前现金/)
      expect(() => ledger.prepareExecution({ instrumentId: '小米', side: 'buy', tradedAt: '2026-08-20', quantity: '0.123456789', price: '1' }, 's1')).toThrow(/最多8位小数/)
      expect(() => ledger.prepareExecution({ instrumentId: '小米', side: 'buy', tradedAt: '2026-99-99', quantity: '1', price: '1' }, 's1')).toThrow(/有效的 ISO/)
      expect(() => ledger.prepareExecution({ instrumentId: '小米', side: 'buy', tradedAt: '2026-08-20T10:00:00', quantity: '1', price: '1' }, 's1')).toThrow(/有效的 ISO/)
    } finally { fs.rmSync(tempDir, { recursive: true, force: true }) }
  })

  it('initializes an empty instrument once and refuses overwrite', () => {
    const { tempDir, dbPath } = database()
    try {
      const ledger = new AlfredLedgerService(dbPath)
      const preview = ledger.prepareInitialPosition({ instrumentId: '腾讯', quantity: '100', cash: '5000' }, 's1')
      expect(ledger.commitInitialPosition(preview.confirmationToken, 's1')).toMatchObject({ status: 'applied' })
      expect(() => ledger.prepareInitialPosition({ instrumentId: '腾讯', quantity: '200', cash: '0' }, 's1')).toThrow(/已有持仓/)
    } finally { fs.rmSync(tempDir, { recursive: true, force: true }) }
  })
})
