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

const REFERENCE_FILES = ['valuation-framework.md', 'position-strategy.md'] as const

export function registerGuidance(ctx: Context): void {
  const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../skills', SKILL_NAME)
  const skillPath = path.join(skillDir, 'SKILL.md')
  const content = buildSkillContent(skillDir, skillPath, fs.readFileSync(skillPath, 'utf8'))
  const runtime = ctx as Context & { skills: { register(skill: unknown): unknown }; on(event: string, listener: (payload: any) => void): unknown }
  runtime.skills.register({
    name: SKILL_NAME,
    description: DESCRIPTION,
    source: 'bundled',
    content,
    path: skillPath,
    resourceBase: { kind: 'directory', path: skillDir },
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

// The SKILL.md references files by relative markdown links, but the model loop
// is not guaranteed to have a filesystem tool to open them. Inline the reference
// bodies into the skill content so the valuation thresholds and position-strategy
// rules are always available to the model without a file-read capability.
function buildSkillContent(skillDir: string, skillPath: string, raw: string): string {
  const body = stripFrontmatter(raw)
  const sections: string[] = [body]
  for (const name of REFERENCE_FILES) {
    const refPath = path.join(skillDir, 'references', name)
    try {
      sections.push(`\n## ${name}\n\n${fs.readFileSync(refPath, 'utf8').trim()}`)
    } catch {
      sections.push(`\n## ${name}\n\n(reference file unavailable at ${refPath})`)
    }
  }
  return sections.join('\n').trim()
}
