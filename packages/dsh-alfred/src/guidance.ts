import type { Context } from '@deepseek-ai/cordis'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_NAME = 'alfred-investment-research'
const DESCRIPTION = '分析小米、腾讯或阿里巴巴的价值、安全边际、组合风险、分阶段买卖策略，或在明确确认后登记已真实发生的成交。'
const STARTUP = `Alfred investment-agent rules:
- Use Alfred tools for current market, fundamentals, portfolio, and valuation claims; expose source dates and missing evidence.
- Research and strategy are drafts. Never claim broker execution.
- A ledger write requires a prepare preview and a later explicit user confirmation before commit.
- Historical cost and technical price action cannot replace intrinsic-value and thesis analysis.`

export function registerGuidance(ctx: Context): void {
  const skillPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../skills', SKILL_NAME, 'SKILL.md')
  const content = stripFrontmatter(fs.readFileSync(skillPath, 'utf8'))
  const runtime = ctx as Context & { skills: { register(skill: unknown): unknown }; on(event: string, listener: (payload: any) => void): unknown }
  runtime.skills.register({
    name: SKILL_NAME,
    description: DESCRIPTION,
    source: 'bundled',
    content,
    path: skillPath,
    resourceBase: { kind: 'directory', path: path.dirname(skillPath) },
  })
  runtime.on('agent/session-start', ({ agent }) => {
    if (agent.session?.header?.agentPreset !== 'alfred') return
    ;(agent as any).inject({
      id: `alfred-startup-${String(agent.id)}`,
      role: 'user',
      content: [{ type: 'text', text: STARTUP }],
      source: { kind: 'plugin', plugin: 'dsh-alfred', form: 'instructions' },
    })
  })
}

function stripFrontmatter(value: string): string {
  return value.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '').trim()
}
