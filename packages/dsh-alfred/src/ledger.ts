import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import { Decimal, d } from '@fin-alfred/core'
import type { ExecutionInput, FeeInput, InitialPositionInput, InstrumentId } from './types.js'
import { normalizeInstrument } from './service.js'

type PendingAction = {
  kind: 'execution' | 'initial-position'
  sessionId: string
  expiresAt: number
  payload: ExecutionInput | InitialPositionInput
}

export class AlfredLedgerService {
  private readonly pending = new Map<string, PendingAction>()

  constructor(private readonly dbPath: string, private readonly ttlMs = 10 * 60_000) {}

  prepareExecution(input: ExecutionInput, sessionId = 'unknown') {
    const normalized = normalizeExecution(input)
    const current = this.readPosition(normalized.instrumentId)
    const fees = totalFees(normalized.fees)
    const quantity = decimal(normalized.quantity, 'quantity')
    const gross = quantity.mul(decimal(normalized.price, 'price'))
    if (normalized.side === 'sell' && quantity.gt(decimal(current.quantity, 'current quantity'))) {
      throw new Error(`卖出数量 ${normalized.quantity} 超过当前持仓 ${current.quantity}。`)
    }
    const nextQuantity = normalized.side === 'buy'
      ? decimal(current.quantity, 'current quantity').add(quantity)
      : decimal(current.quantity, 'current quantity').sub(quantity)
    const nextCash = normalized.side === 'buy'
      ? decimal(current.cash, 'current cash').sub(gross).sub(fees)
      : decimal(current.cash, 'current cash').add(gross).sub(fees)
    if (nextCash.isNegative()) throw new Error('买入金额和费用超过当前现金。')
    return this.issue('execution', sessionId, normalized, {
      action: 'register-real-execution', current, projected: { quantity: text(nextQuantity), cash: text(nextCash) }, gross: text(gross), totalFees: text(fees), executionKey: executionKey(normalized),
    })
  }

  commitExecution(token: string, sessionId = 'unknown') {
    const pending = this.consume(token, 'execution', sessionId)
    const input = pending.payload as ExecutionInput
    const db = this.open()
    try {
      db.exec('BEGIN IMMEDIATE')
      const existing = db.prepare('SELECT id FROM ledger_entries WHERE execution_key = ?').get(executionKey(input))
      if (existing) {
        db.exec('ROLLBACK')
        return { ok: true, status: 'duplicate', instrumentId: input.instrumentId }
      }
      const current = positionRow(db, input.instrumentId as InstrumentId)
      const quantity = decimal(input.quantity, 'quantity')
      const price = decimal(input.price, 'price')
      const fees = totalFees(input.fees)
      if (input.side === 'sell' && quantity.gt(decimal(current.quantity, 'current quantity'))) throw new Error('卖出数量超过当前持仓。')
      const nextQuantity = input.side === 'buy' ? decimal(current.quantity, 'current quantity').add(quantity) : decimal(current.quantity, 'current quantity').sub(quantity)
      const gross = quantity.mul(price)
      const nextCash = input.side === 'buy' ? decimal(current.cash, 'current cash').sub(gross).sub(fees) : decimal(current.cash, 'current cash').add(gross).sub(fees)
      if (nextCash.isNegative()) throw new Error('买入金额和费用超过当前现金。')
      const f = fullFees(input.fees)
      db.prepare('INSERT INTO ledger_entries (profile_id, instrument_id, side, traded_at, quantity, price, stamp_duty, clearing_fee, transfer_fee, commission, external_id, execution_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run('default', input.instrumentId, input.side, input.tradedAt, input.quantity, input.price, f.stampDuty, f.clearingFee, f.transferFee, f.commission, input.externalId ?? null, executionKey(input))
      db.prepare('UPDATE positions SET quantity = ?, cash = ? WHERE profile_id = ? AND instrument_id = ?').run(text(nextQuantity), text(nextCash), 'default', input.instrumentId)
      db.exec('COMMIT')
      return { ok: true, status: 'applied', instrumentId: input.instrumentId, position: { quantity: text(nextQuantity), cash: text(nextCash) } }
    } catch (error) {
      try { db.exec('ROLLBACK') } catch {}
      throw error
    } finally { db.close() }
  }

  prepareInitialPosition(input: InitialPositionInput, sessionId = 'unknown') {
    const normalized = { instrumentId: normalizeInstrument(input.instrumentId), quantity: positiveOrZero(input.quantity, 'quantity'), cash: positiveOrZero(input.cash, 'cash') }
    this.assertInitialPositionAvailable(normalized.instrumentId)
    return this.issue('initial-position', sessionId, normalized, { action: 'initialize-position', projected: { quantity: normalized.quantity, cash: normalized.cash } })
  }

  commitInitialPosition(token: string, sessionId = 'unknown') {
    const pending = this.consume(token, 'initial-position', sessionId)
    const input = pending.payload as InitialPositionInput
    const db = this.open()
    try {
      db.exec('BEGIN IMMEDIATE')
      assertInitialAvailable(db, input.instrumentId as InstrumentId)
      db.prepare('INSERT INTO positions (profile_id, instrument_id, quantity, cash) VALUES (?, ?, ?, ?)').run('default', input.instrumentId, input.quantity, input.cash)
      db.exec('COMMIT')
      return { ok: true, status: 'applied', instrumentId: input.instrumentId, position: { quantity: input.quantity, cash: input.cash } }
    } catch (error) {
      try { db.exec('ROLLBACK') } catch {}
      throw error
    } finally { db.close() }
  }

  private issue(kind: PendingAction['kind'], sessionId: string, payload: PendingAction['payload'], preview: Record<string, unknown>) {
    const token = randomUUID()
    const expiresAt = Date.now() + this.ttlMs
    this.pending.set(token, { kind, sessionId, expiresAt, payload })
    return { ok: true, requiresConfirmation: true, confirmationToken: token, expiresAt: new Date(expiresAt).toISOString(), preview }
  }

  private consume(token: string, kind: PendingAction['kind'], sessionId: string) {
    const item = this.pending.get(token)
    if (!item || item.kind !== kind) throw new Error('确认令牌无效或已使用。')
    this.pending.delete(token)
    if (item.expiresAt <= Date.now()) throw new Error('确认令牌已过期，请重新预览。')
    if (item.sessionId !== sessionId) throw new Error('确认令牌不属于当前会话。')
    return item
  }

  private open() {
    if (!fs.existsSync(this.dbPath)) throw new Error(`未找到 Alfred 数据库：${this.dbPath}`)
    const db = new DatabaseSync(this.dbPath)
    db.exec('PRAGMA foreign_keys=ON')
    return db
  }

  private readPosition(instrumentId: InstrumentId) { const db = this.open(); try { return positionRow(db, instrumentId) } finally { db.close() } }
  private assertInitialPositionAvailable(instrumentId: InstrumentId) { const db = this.open(); try { assertInitialAvailable(db, instrumentId) } finally { db.close() } }
}

function normalizeExecution(input: ExecutionInput): ExecutionInput & { instrumentId: InstrumentId } {
  if (input.side !== 'buy' && input.side !== 'sell') throw new Error('side 必须是 buy 或 sell。')
  validateTradedAt(input.tradedAt)
  return { ...input, instrumentId: normalizeInstrument(input.instrumentId), quantity: positive(input.quantity, 'quantity'), price: positive(input.price, 'price'), fees: fullFees(input.fees) }
}
function validateTradedAt(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/u.exec(value)
  if (!match) throw new Error('tradedAt 必须是有效的 ISO 日期或带时区时间。')
  const [year, month, day] = match.slice(1, 4).map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || (value.includes('T') && !Number.isFinite(Date.parse(value)))) {
    throw new Error('tradedAt 必须是有效的 ISO 日期或带时区时间。')
  }
}
function positionRow(db: DatabaseSync, id: InstrumentId) { return (db.prepare('SELECT quantity, cash FROM positions WHERE profile_id = ? AND instrument_id = ?').get('default', id) as { quantity: string; cash: string } | undefined) ?? { quantity: '0', cash: '0' } }
function assertInitialAvailable(db: DatabaseSync, id: InstrumentId) {
  if (db.prepare('SELECT 1 FROM ledger_entries WHERE profile_id = ? AND instrument_id = ? LIMIT 1').get('default', id)) throw new Error('已有成交记录，不能设置初始持仓。')
  if (db.prepare('SELECT 1 FROM positions WHERE profile_id = ? AND instrument_id = ? LIMIT 1').get('default', id)) throw new Error('已有持仓记录，不能覆盖初始持仓。')
}
function executionKey(i: ExecutionInput) { return createHash('sha256').update(['default', i.instrumentId, i.side, i.tradedAt, i.quantity, i.price, i.externalId ?? ''].join('|')).digest('hex') }
function fullFees(fees?: FeeInput) { return { stampDuty: positiveOrZero(fees?.stampDuty ?? '0', 'stampDuty'), clearingFee: positiveOrZero(fees?.clearingFee ?? '0', 'clearingFee'), transferFee: positiveOrZero(fees?.transferFee ?? '0', 'transferFee'), commission: positiveOrZero(fees?.commission ?? '0', 'commission') } }
function totalFees(fees?: FeeInput) { return Object.values(fullFees(fees)).reduce((sum, value) => sum.add(d(value)), Decimal.zero()) }
function positive(v: string, name: string) { const n = decimal(v, name); if (!n.isPositive()) throw new Error(`${name} 必须大于0。`); return text(n) }
function positiveOrZero(v: string, name: string) { const n = decimal(v, name); if (n.isNegative()) throw new Error(`${name} 不能为负数。`); return text(n) }
function decimal(v: string, name: string) {
  if (!/^-?\d+(?:\.\d{1,8})?$/u.test(v.trim())) throw new Error(`${name} 必须是最多8位小数的有限数。`)
  return d(v)
}
function text(v: Decimal) { return v.toString() }
