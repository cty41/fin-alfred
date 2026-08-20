import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { AlfredResearchService, createDefaultConfig } from './service.js'
import { AlfredLedgerService } from './ledger.js'
import { evaluateValueStrategy } from './strategy.js'
import { registerGuidance } from './guidance.js'
import type { AlfredPluginConfig } from './types.js'

export const name = 'dsh-alfred'
export const inject = ['tools', 'skills']

export const Config: z<AlfredPluginConfig> = z.object({
  pythonPath: z.string().default(''),
  adapterPath: z.string().default(''),
  dbPath: z.string().default(''),
  timeoutMs: z.number().default(30_000),
  confirmationTtlMs: z.number().default(600_000),
})

export function apply(ctx: Context, config: AlfredPluginConfig): void {
  registerGuidance(ctx)
  const defaults = createDefaultConfig()
  const service = new AlfredResearchService({
    ...defaults,
    ...config,
    pythonPath: config.pythonPath || defaults.pythonPath,
    adapterPath: config.adapterPath || defaults.adapterPath,
    dbPath: config.dbPath || defaults.dbPath,
    timeoutMs: config.timeoutMs || defaults.timeoutMs,
  })
  const ledger = new AlfredLedgerService(config.dbPath || defaults.dbPath, config.confirmationTtlMs || 600_000)
  ctx.tools.register(defineTool({
    name: 'alfred_stock_quote',
    description: '查询小米、腾讯或阿里巴巴港股行情。支持 HKEX:1810、HKEX:0700、HKEX:9988。只读，不执行交易。',
    parameters: { instrumentId: { type: 'string', required: true, description: 'HKEX:1810、HKEX:0700 或 HKEX:9988。' } },
    output: textOutput(),
    execute: async (args, exec) => JSON.stringify(await service.quote(args.instrumentId, exec.signal)),
  }))
  ctx.tools.register(defineTool({
    name: 'alfred_stock_fundamentals',
    description: '查询三只港股的当前估值、历史分位统计和同业估值比较。返回精简数据事实，不自动给出交易指令。',
    parameters: { instrumentId: { type: 'string', required: true, description: 'HKEX:1810、HKEX:0700 或 HKEX:9988。' } },
    output: textOutput(),
    execute: async (args, exec) => JSON.stringify(await service.fundamentals(args.instrumentId, exec.signal)),
  }))
  ctx.tools.register(defineTool({
    name: 'alfred_portfolio_context',
    description: '只读查询 Alfred 对目标股票的持仓和策略上下文；没有数据库或记录时明确返回不可用。',
    parameters: { instrumentId: { type: 'string', required: true, description: 'HKEX:1810、HKEX:0700 或 HKEX:9988。' } },
    output: textOutput(),
    execute: async args => JSON.stringify(service.portfolioContext(args.instrumentId)),
  }))
  ctx.tools.register(defineTool({
    name: 'alfred_financial_statements',
    description: '查询三只港股的三大财务报表明细（资产负债表、利润表、现金流量表），返回原始科目、标准科目汇总（现金/投资/有息负债/少数股东权益等）及报告期与币种。只读，不执行交易。',
    parameters: { instrumentId: { type: 'string', required: true, description: 'HKEX:1810、HKEX:0700 或 HKEX:9988。' }, indicator: { type: 'string', enum: ['报告期', '年度'], description: '报告期返回最新各期（含季度）；年度仅返回年报（12-31）。' } },
    output: textOutput(),
    execute: async (args, exec) => JSON.stringify(await service.financialStatements(args.instrumentId, args.indicator ?? '报告期', exec.signal)),
  }))
  ctx.tools.register(defineTool({
    name: 'alfred_value_strategy',
    description: '根据已核对的Bear/Base/Bull每股价值、当前价和Base预期IRR生成动态价值策略状态。只计算，不读取或写入账本。',
    parameters: {
      instrumentId: instrumentParameter(),
      currentPrice: { type: 'number', required: true }, bearValue: { type: 'number', required: true }, baseValue: { type: 'number', required: true }, bullValue: { type: 'number', required: true }, baseIrr: { type: 'number', required: true, description: '小数形式，例如15%传0.15。' },
      redLine: { type: 'boolean' }, dataComplete: { type: 'boolean' },
    },
    output: textOutput(),
    execute: async args => JSON.stringify(evaluateValueStrategy(args as unknown as import('./types.js').StrategyInput)),
  }))
  ctx.tools.register(defineTool({
    name: 'alfred_prepare_execution',
    description: '预览登记一笔已经在券商真实发生的成交。只生成预览和确认令牌，不写数据库。不得用于拟交易或下单。',
    parameters: executionParameters(), output: textOutput(),
    execute: async (args, exec) => JSON.stringify(ledger.prepareExecution(executionInput(args as unknown as Record<string, string>), String(exec.agent?.id ?? 'unknown'))),
  }))
  ctx.tools.register(defineTool({
    name: 'alfred_commit_execution',
    description: '仅在用户看到预览后于下一轮明确确认时，使用预览令牌登记真实成交。不得自行调用。',
    parameters: { confirmationToken: { type: 'string', required: true } }, output: textOutput(),
    execute: async (args, exec) => JSON.stringify(ledger.commitExecution(args.confirmationToken, String(exec.agent?.id ?? 'unknown'))),
  }))
  ctx.tools.register(defineTool({
    name: 'alfred_prepare_initial_position',
    description: '预览首次设置一只股票的初始持仓和现金；已有持仓或成交时拒绝。只预览，不写数据库。',
    parameters: { instrumentId: instrumentParameter(), quantity: { type: 'string', required: true }, cash: { type: 'string', required: true } }, output: textOutput(),
    execute: async (args, exec) => JSON.stringify(ledger.prepareInitialPosition(args as unknown as import('./types.js').InitialPositionInput, String(exec.agent?.id ?? 'unknown'))),
  }))
  ctx.tools.register(defineTool({
    name: 'alfred_commit_initial_position',
    description: '仅在用户看到初始持仓预览后于下一轮明确确认时提交。不得覆盖已有持仓。',
    parameters: { confirmationToken: { type: 'string', required: true } }, output: textOutput(),
    execute: async (args, exec) => JSON.stringify(ledger.commitInitialPosition(args.confirmationToken, String(exec.agent?.id ?? 'unknown'))),
  }))
}

function instrumentParameter() { return { type: 'string' as const, required: true as const, description: 'HKEX:1810、HKEX:0700 或 HKEX:9988。' } }
function executionParameters() {
  return {
    instrumentId: instrumentParameter(), side: { type: 'string' as const, required: true as const, enum: ['buy', 'sell'] }, tradedAt: { type: 'string' as const, required: true as const, description: 'ISO日期或时间。' }, quantity: { type: 'string' as const, required: true as const }, price: { type: 'string' as const, required: true as const },
    stampDuty: { type: 'string' as const }, clearingFee: { type: 'string' as const }, transferFee: { type: 'string' as const }, commission: { type: 'string' as const }, externalId: { type: 'string' as const },
  }
}
function executionInput(args: Record<string, string>) {
  return {
    instrumentId: args.instrumentId, side: args.side as 'buy' | 'sell', tradedAt: args.tradedAt, quantity: args.quantity, price: args.price, externalId: args.externalId,
    fees: { stampDuty: args.stampDuty, clearingFee: args.clearingFee, transferFee: args.transferFee, commission: args.commission },
  }
}

function textOutput() {
  return { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] }
}

export type { AlfredPluginConfig, InstrumentId, ToolEnvelope } from './types.js'
export { AlfredResearchService, normalizeInstrument } from './service.js'
export { AlfredLedgerService } from './ledger.js'
export { evaluateValueStrategy } from './strategy.js'
