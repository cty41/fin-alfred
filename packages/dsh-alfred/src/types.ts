/**
 * Anchor instruments: the three companies with first-class aliases, name
 * resolution, and shortcuts. They are NOT a support whitelist — Alfred now
 * accepts any Hong Kong listing as an `InstrumentId`. Anchors only provide
 * fast alias resolution and a fallback name when the securities master is
 * unavailable.
 */
export const ANCHOR_INSTRUMENTS = {
  "HKEX:1810": { symbol: "01810", name: "小米集团-W" },
  "HKEX:0700": { symbol: "00700", name: "腾讯控股" },
  "HKEX:9988": { symbol: "09988", name: "阿里巴巴-W" },
} as const

export type AnchorInstrumentId = keyof typeof ANCHOR_INSTRUMENTS

/**
 * Any Hong Kong listing, expressed as `HKEX:` + zero-padded 5-digit code
 * (e.g. `HKEX:0700`, `HKEX:0001`). Kept as a string type so it is not limited
 * to the anchor set.
 */
export type InstrumentId = string

export interface AlfredPluginConfig {
  pythonPath: string
  adapterPath: string
  dbPath: string
  timeoutMs: number
  confirmationTtlMs?: number
  /** Path to the securities/financial cache database (defaults to fin-alfred/alfred-meta.db). */
  metaDbPath?: string
}

export interface FeeInput {
  stampDuty?: string
  clearingFee?: string
  transferFee?: string
  commission?: string
}

export interface ExecutionInput {
  instrumentId: string
  side: 'buy' | 'sell'
  tradedAt: string
  quantity: string
  price: string
  fees?: FeeInput
  externalId?: string
}

export interface InitialPositionInput {
  instrumentId: string
  quantity: string
  cash: string
}

export interface StrategyInput {
  instrumentId: string
  currentPrice: number
  bearValue: number
  baseValue: number
  bullValue: number
  baseIrr: number
  redLine?: boolean
  dataComplete?: boolean
}

export interface ToolEnvelope {
  ok: boolean
  instrumentId?: InstrumentId
  data?: unknown
  source?: string
  observedAt?: string
  degraded?: boolean
  warning?: string
  error?: string
  nextSteps?: {
    purpose: string
    requiredFields: Array<{ field: string; note: string }>
    akShareNote?: string
  }
}
