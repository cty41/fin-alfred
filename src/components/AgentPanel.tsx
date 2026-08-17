import { Bot, ChevronRight, FileJson2, Send, X } from "lucide-react";
import { FormEvent, useState } from "react";
import type { AppBridge } from "../bridge/AppBridge";
import type { AgentArtifact, AgentMessage, AgentTransmissionPreview, ProfileOverview } from "../domain/types";
import type { AgentMessageInput } from "../bridge/AppBridge";

export function AgentPanel({ bridge, overview, open, onClose }: { bridge: AppBridge; overview: ProfileOverview; open: boolean; onClose: () => void }) {
  const [messages, setMessages] = useState<AgentMessage[]>([
    { id: "welcome", role: "assistant", content: "我可以读取当前授权范围、进行分析并创建草稿，但不能发布策略或登记成交。" },
  ]);
  const [artifact, setArtifact] = useState<AgentArtifact>();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [usage, setUsage] = useState<string>();
  const [preview, setPreview] = useState<AgentTransmissionPreview>();
  const [pending, setPending] = useState<AgentMessageInput>();
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!input.trim() || busy) return;
    const userMessage: AgentMessage = { id: crypto.randomUUID(), role: "user", content: input.trim() };
    const history = [...messages, userMessage];
    const request: AgentMessageInput = {
      conversationId: `conversation:${overview.profileId}:${overview.instrumentId}`,
      message: userMessage.content,
      history,
      context: {
        profileId: overview.profileId,
        instrumentId: overview.instrumentId,
        fields: ["position", "cash", "strategyStages", "researchStatus", "valuationSummary"],
        provider: bridge.mode === "desktop" ? "BYOK provider" : "Mock provider",
        baseUrl: bridge.mode === "desktop" ? "configured-provider" : "local://mock",
      },
    };
    setBusy(true);
    setError(undefined);
    try {
      setPreview(await bridge.previewAgentMessage(request));
      setPending(request);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function confirmSend() {
    if (!pending || busy) return;
    setMessages(pending.history);
    setInput("");
    setPreview(undefined);
    setBusy(true);
    setError(undefined);
    try {
      const reply = await bridge.sendAgentMessage(pending);
      setMessages((current) => [...current, reply.message]);
      setArtifact(reply.artifact);
      if (reply.usage) setUsage(`${reply.usage.inputTokens} 输入 · ${reply.usage.outputTokens} 输出 tokens`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(undefined);
      setBusy(false);
    }
  }

  return (
    <aside className={`agent-panel ${open ? "open" : ""}`} aria-label="研究助手">
      <header className="agent-header">
        <div className="agent-title"><Bot aria-hidden="true" /><div><strong>研究助手</strong><small>读取 · 分析 · 创建草稿</small></div></div>
        <button className="icon-button" type="button" aria-label="关闭对话栏" onClick={onClose}><X /></button>
      </header>
      <div className="context-strip">
        <span>当前作用域</span><strong>{overview.symbol}</strong><button type="button">查看发送内容 <ChevronRight /></button>
      </div>
      <div className="message-list">
        {messages.map((message) => <div className={`message ${message.role}`} key={message.id}>{message.content}</div>)}
        {busy && <div className="message assistant">正在分析已授权数据…</div>}
        {artifact && (
          <button className="artifact" type="button">
            <FileJson2 aria-hidden="true" />
            <span><small>策略草稿 · 未发布</small><strong>{artifact.title}</strong><em>{artifact.summary}</em></span>
            <ChevronRight aria-hidden="true" />
          </button>
        )}
      </div>
      {preview && (
        <section className="transmission-preview" aria-label="发送内容预览">
          <strong>发送前确认</strong>
          <small>{preview.destination} · {preview.model} · {preview.serializedBytes} bytes</small>
          <p>包含：{preview.fields.join("、")}</p>
          <p>排除：{preview.excluded.join("、")}</p>
          <div><button type="button" onClick={() => { setPreview(undefined); setPending(undefined); }}>取消</button><button type="button" onClick={confirmSend}>确认发送</button></div>
        </section>
      )}
      {error && <p className="agent-error" role="alert">{error}</p>}
      <form className="composer" onSubmit={submit}>
        <label htmlFor="agent-input">向研究助手提问</label>
        <textarea id="agent-input" value={input} onChange={(event) => setInput(event.target.value)} placeholder="例如：为Stage 2生成检查表草稿" rows={3} />
        <div><small>{usage ?? "调用前将预览数据作用域"}</small><button type="submit" disabled={busy || !input.trim()}><Send />发送</button></div>
      </form>
    </aside>
  );
}
