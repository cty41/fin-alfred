import { normalizeInstrument } from './service.js'
import type { StrategyInput } from './types.js'

export type StrategyState = 'data-insufficient' | 'exit-review' | 'build-candidate' | 'wait' | 'reduce-reference'

export interface StrategyResult {
  instrumentId: string
  state: StrategyState
  priceToBear: number
  priceToBase: number
  priceToBull: number
  bearDownside: number
  baseIrr: number
  reasons: string[]
  missingInputs?: string[]
}

export function evaluateValueStrategy(input: StrategyInput): StrategyResult {
  const instrumentId = normalizeInstrument(input.instrumentId)
  for (const [name, value] of Object.entries({ currentPrice: input.currentPrice, bearValue: input.bearValue, baseValue: input.baseValue, bullValue: input.bullValue })) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} 必须是正数。`)
  }
  if (!Number.isFinite(input.baseIrr)) throw new Error('baseIrr 必须是有限数。')
  const ratios = {
    priceToBear: input.currentPrice / input.bearValue,
    priceToBase: input.currentPrice / input.baseValue,
    priceToBull: input.currentPrice / input.bullValue,
    bearDownside: Math.max(0, (input.currentPrice - input.bearValue) / input.currentPrice),
  }
  let state: StrategyState
  const reasons: string[] = []
  const missingInputs: string[] = []
  if (input.dataComplete === false) {
    state = 'data-insufficient'
    reasons.push('关键数据不完整，不能给出精确买入结论。')
    missingInputs.push(
      'Bear/Base/Bull 每股价值的财报/数据来源与报告期',
      'Base IRR 的计算依据（贴现率假设、长期增长率）',
      '口径与来源日期（IFRS/Non-IFRS，HKD/CNY，来源）',
    )
  } else if (input.redLine) {
    state = 'exit-review'
    reasons.push('触发红线，停止新增风险并复核投资逻辑。')
  } else if (input.baseIrr >= 0.15 && ratios.bearDownside <= 0.25 && input.currentPrice < input.baseValue) {
    state = 'build-candidate'
    reasons.push('Base IRR 不低于15%、Bear下行不超过25%，且价格低于Base Value。')
  } else if (input.baseIrr < 0.08 || input.currentPrice >= input.bullValue) {
    state = 'reduce-reference'
    reasons.push('Base IRR低于8%或价格已接近/超过Bull Value。')
  } else {
    state = 'wait'
    reasons.push('安全边际或预期回报尚不足以触发建仓。')
  }
  const result: StrategyResult = { instrumentId, state, ...ratios, baseIrr: input.baseIrr, reasons }
  if (missingInputs.length > 0) result.missingInputs = missingInputs
  return result
}
