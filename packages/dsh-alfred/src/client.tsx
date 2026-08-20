import type { Context } from '@deepseek-ai/cordis'
import React, { useEffect, useState } from 'react'

const EXAMPLES = [
  '分析腾讯现在是否值得建仓',
  '比较腾讯和阿里巴巴的安全边际',
  '查看我的小米仓位和后续减仓条件',
  '小米最新财报对估值有什么影响',
  '我已经成交了一笔卖出，帮我预览登记',
]
const HELP_EVENT = 'dsh-alfred:show-help'

function AlfredHelpCard(props: any) {
  const summary = props.useSessions((state: any) => state.byId[String(props.sessionId)])
  const storageKey = `dsh-alfred-help:${String(props.sessionId)}`
  const [hidden, setHidden] = useState(() => globalThis.localStorage?.getItem(storageKey) === 'hidden')
  const [forced, setForced] = useState(false)
  useEffect(() => {
    const show = () => { setHidden(false); setForced(true) }
    globalThis.addEventListener?.(HELP_EVENT, show)
    return () => globalThis.removeEventListener?.(HELP_EVENT, show)
  }, [])
  if (summary?.agentPreset !== 'alfred' || (!summary.blank && !forced) || hidden) return null
  return <section style={cardStyle} aria-label="Alfred 使用指引">
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
      <div><strong>Alfred 投资研究</strong><div style={mutedStyle}>支持小米、腾讯和阿里。研究结论不是自动下单；账本写入会先预览并等待你确认。</div></div>
      <button type="button" style={buttonStyle} onClick={() => { globalThis.localStorage?.setItem(storageKey, 'hidden'); setForced(false); setHidden(true) }}>隐藏</button>
    </div>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
      {EXAMPLES.map(example => <button type="button" key={example} style={chipStyle} onClick={() => props.inputActions.setDraft(example)}>{example}</button>)}
    </div>
  </section>
}

function AlfredHelpButton(props: any) {
  const summary = props.useSessions((state: any) => state.byId[String(props.sessionId)])
  if (summary?.agentPreset !== 'alfred') return null
  return <button type="button" style={buttonStyle} aria-label="打开 Alfred 帮助" onClick={() => globalThis.dispatchEvent?.(new Event(HELP_EVENT))}>帮助</button>
}

export const inject = ['slots']
export function apply(ctx: Context): void {
  const slots = (ctx as Context & { slots: { inject(name: string, create: () => unknown): unknown; register(options: unknown, component: unknown): unknown } }).slots
  slots.inject('conversation.input.dock', () => slots.register({ name: 'conversation.input.dock', id: 'alfred-help', order: -20 }, AlfredHelpCard))
  slots.inject('conversation.input.right', () => slots.register({ name: 'conversation.input.right', id: 'alfred-help-button', order: 90 }, AlfredHelpButton))
}

const cardStyle: React.CSSProperties = { boxSizing: 'border-box', width: 'min(760px, calc(100% - 32px))', margin: '0 auto 8px', padding: 16, color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-specific-tip)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 12 }
const mutedStyle: React.CSSProperties = { marginTop: 4, color: 'var(--dsw-alias-label-secondary)', fontSize: 13, lineHeight: 1.5 }
const buttonStyle: React.CSSProperties = { color: 'var(--dsw-alias-label-secondary)', background: 'transparent', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, padding: '4px 9px', cursor: 'pointer' }
const chipStyle: React.CSSProperties = { ...buttonStyle, color: 'var(--dsw-alias-label-primary)', textAlign: 'left', padding: '7px 10px' }
