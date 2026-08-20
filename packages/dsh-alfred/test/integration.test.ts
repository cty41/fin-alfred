import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../src/index.js'
import { apply as applyClient } from '../src/client.js'
import { AlfredLedgerService } from '../src/ledger.js'
import { evaluateValueStrategy } from '../src/strategy.js'

const config = { pythonPath: 'python', adapterPath: 'adapter.py', dbPath: 'missing.db', timeoutMs: 1_000 }

describe('bundled guidance and web registration', () => {
  it('registers the skill and injects startup rules only for Alfred sessions', () => {
    let skill: any
    let listener: ((payload: any) => void) | undefined
    apply({
      tools: { register: () => undefined },
      skills: { register: (value: any) => { skill = value } },
      on: (event: string, value: any) => { if (event === 'agent/session-start') listener = value },
    } as never, config)
    expect(skill).toMatchObject({ name: 'alfred-investment-research', source: 'bundled' })
    expect(skill.content).toContain('Never claim to place a broker order')
    expect(skill.content).toContain('## valuation-framework.md')
    expect(skill.content).toContain('For Tencent')
    expect(skill.content).toContain('## position-strategy.md')
    expect(skill.content).toContain('Cumulative reduction targets')
    expect(skill.resourceBase.path).toMatch(/alfred-investment-research$/u)
    const injected: any[] = []
    listener?.({ agent: { id: 'a1', session: { header: { agentPreset: 'standard' } }, inject: (message: any) => injected.push(message) } })
    listener?.({ agent: { id: 'a2', session: { header: { agentPreset: 'alfred' } }, inject: (message: any) => injected.push(message) } })
    expect(injected).toHaveLength(1)
    expect(injected[0]).toMatchObject({ role: 'user', source: { kind: 'plugin', plugin: 'dsh-alfred', form: 'instructions' } })
  })

  it('registers help UI in official composer slots', () => {
    const rows: any[] = []
    const slots = { inject: (_name: string, factory: () => unknown) => factory(), register: (options: any, component: unknown) => { rows.push({ options, component }) } }
    applyClient({ slots } as never)
    expect(rows.map(row => row.options)).toEqual([
      { name: 'conversation.input.dock', id: 'alfred-help', order: -20 },
      { name: 'conversation.input.right', id: 'alfred-help-button', order: 90 },
    ])
  })

  it('ships company-specific valuation references', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../skills/alfred-investment-research/references')
    const valuation = fs.readFileSync(path.join(root, 'valuation-framework.md'), 'utf8')
    expect(valuation).toContain('For Tencent')
    expect(valuation).toContain('For Alibaba')
    expect(valuation).toContain('Do not copy business weights')
  })
})

describe('strategy scenario matrix', () => {
  const base = { currentPrice: 80, bearValue: 65, baseValue: 110, bullValue: 140, baseIrr: 0.16 }
  it.each(['小米', '腾讯控股', '阿里巴巴'])(`evaluates %s with the same capital-safety gates`, instrumentId => {
    expect(evaluateValueStrategy({ instrumentId, ...base }).state).toBe('build-candidate')
  })
  it('moves to reduction reference as expected return falls below 8%', () => {
    expect(evaluateValueStrategy({ instrumentId: '腾讯', ...base, baseIrr: 0.079 }).state).toBe('reduce-reference')
  })
  it('moves to reduction reference when price reaches Bull Value', () => {
    expect(evaluateValueStrategy({ instrumentId: '阿里', ...base, currentPrice: 140 }).state).toBe('reduce-reference')
  })
  it('rejects non-positive valuation inputs', () => {
    expect(() => evaluateValueStrategy({ instrumentId: '腾讯', ...base, baseValue: 0 })).toThrow(/正数/)
  })
})

describe('ledger race and replay safety', () => {
  function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alfred-race-'))
    const dbPath = path.join(dir, 'alfred.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE positions (profile_id TEXT NOT NULL, instrument_id TEXT NOT NULL, quantity TEXT NOT NULL, cash TEXT NOT NULL, PRIMARY KEY(profile_id, instrument_id));
      CREATE TABLE ledger_entries (id INTEGER PRIMARY KEY, profile_id TEXT, instrument_id TEXT, side TEXT, traded_at TEXT, quantity TEXT, price TEXT, stamp_duty TEXT, clearing_fee TEXT, transfer_fee TEXT, commission TEXT, external_id TEXT, execution_key TEXT UNIQUE);
      INSERT INTO positions VALUES ('default', 'HKEX:1810', '100', '0');
    `)
    db.close()
    return { dir, dbPath }
  }

  it('rolls back when the position changes after preview', () => {
    const { dir, dbPath } = fixture()
    try {
      const ledger = new AlfredLedgerService(dbPath)
      const preview = ledger.prepareExecution({ instrumentId: '小米', side: 'sell', tradedAt: '2026-08-20', quantity: '100', price: '10' }, 's')
      const db = new DatabaseSync(dbPath)
      db.prepare('UPDATE positions SET quantity = ?').run('50')
      db.close()
      expect(() => ledger.commitExecution(preview.confirmationToken, 's')).toThrow(/超过当前持仓/)
      const verify = new DatabaseSync(dbPath)
      expect(verify.prepare('SELECT count(*) AS n FROM ledger_entries').get()).toEqual({ n: 0 })
      verify.close()
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('rejects an expired token without writing', () => {
    const { dir, dbPath } = fixture()
    try {
      const ledger = new AlfredLedgerService(dbPath, -1)
      const preview = ledger.prepareExecution({ instrumentId: '小米', side: 'sell', tradedAt: '2026-08-20', quantity: '1', price: '10' }, 's')
      expect(() => ledger.commitExecution(preview.confirmationToken, 's')).toThrow(/过期/)
      const db = new DatabaseSync(dbPath)
      expect(db.prepare('SELECT count(*) AS n FROM ledger_entries').get()).toEqual({ n: 0 })
      db.close()
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
