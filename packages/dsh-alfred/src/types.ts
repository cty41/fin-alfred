export const SUPPORTED_INSTRUMENTS = {
  "HKEX:1810": { symbol: "01810", name: "小米集团-W" },
  "HKEX:0700": { symbol: "00700", name: "腾讯控股" },
  "HKEX:9988": { symbol: "09988", name: "阿里巴巴-W" },
} as const

export type InstrumentId = keyof typeof SUPPORTED_INSTRUMENTS

export interface AlfredPluginConfig {
  pythonPath: string
  adapterPath: string
  dbPath: string
  timeoutMs: number
  confirmationTtlMs?: number
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
