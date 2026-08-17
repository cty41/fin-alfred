import { FormEvent, useEffect, useState } from "react";
import type { AppBridge } from "../bridge/AppBridge";
import type { DecisionEvaluation, StrategyDraftInput, XiaomiSignals } from "../domain/types";

const initialSignals: XiaomiSignals = {
  thesis_invalidated: false, fundamentals_deteriorated: false, fundamentals_strong: false,
  market_crash: false, rebound_confirmed_by_user: false, valuation_current: false,
  valuation_less_attractive: false, earnings_confirmed: false, ev_orders_confirmed: false,
  ev_deliveries_confirmed: false, gross_margin_confirmed: false, new_model_data_confirmed: false,
  macro_checklist_confirmed: false, sotp_confirmed: false, irr_confirmed: false,
  concentration_confirmed: false,
};

const checks: Array<[keyof XiaomiSignals, string]> = [
  ["thesis_invalidated", "投资逻辑已证伪（进入退出评估，不机械清仓）"],
  ["fundamentals_deteriorated", "基本面明显恶化"],
  ["fundamentals_strong", "基本面仍强"], ["market_crash", "市场处于崩跌"],
  ["rebound_confirmed_by_user", "我确认已出现明显反弹"],
  ["valuation_current", "最新估值与行情仍在有效期"],
  ["valuation_less_attractive", "上涨后估值吸引力下降"],
  ["earnings_confirmed", "财报已人工核对"], ["ev_orders_confirmed", "汽车订单已人工核对"],
  ["ev_deliveries_confirmed", "汽车交付已人工核对"], ["gross_margin_confirmed", "毛利已人工核对"],
  ["new_model_data_confirmed", "新车型数据已人工核对"],
  ["macro_checklist_confirmed", "就业、HY利差、2年期美债及市场范式已核对"],
  ["sotp_confirmed", "SOTP已核对"], ["irr_confirmed", "IRR已核对"],
  ["concentration_confirmed", "组合集中度已核对"],
];

const initialStrategy = JSON.stringify({ schema_version: 1, strategy_id: "xiaomi-stage-2", version: "1", condition: { kind: "human_confirmation", checklist_id: "rebound-confirmation" }, suggestion: { action: "review_sell_gap", reason_code: "STAGE_2_REBOUND", invalidation: "fundamental_thesis_invalidated" }, lifecycle: "DRAFT", test_scenarios: [{ name: "反弹已人工确认", inputs: { "rebound-confirmation": true }, expected_match: true, expected_action: "review_sell_gap" }] }, null, 2);

export function DecisionPage({ bridge, profileId }: { bridge: AppBridge; profileId: string }) {
  const [signals, setSignals] = useState(initialSignals);
  const [evaluation, setEvaluation] = useState<DecisionEvaluation>();
  const [notice, setNotice] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [execution, setExecution] = useState({ tradedAt: "", quantity: "", price: "", stampDuty: "0", clearingFee: "0", transferFee: "0", commission: "0", externalId: "" });
  const [strategyText, setStrategyText] = useState(initialStrategy);
  const [strategies, setStrategies] = useState<StrategyDraftInput[]>([]);

  async function refreshStrategies() { setStrategies(await bridge.listStrategies(profileId)); }
  useEffect(() => { void bridge.listStrategies(profileId).then(setStrategies); }, [bridge, profileId]);
  function parsedStrategy() { return JSON.parse(strategyText) as StrategyDraftInput; }

  async function evaluate() {
    setNotice("");
    try { setEvaluation(await bridge.evaluateXiaomiDecision(profileId, signals)); setAccepted(false); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  }

  const decisionKey = evaluation?.recommendation?.decision_key;
  async function recordExecution(event: FormEvent) {
    event.preventDefault(); if (!decisionKey) return;
    try { const result = await bridge.recordDecisionExecution({ profileId, decisionKey, ...execution }); setNotice(result.applied ? `成交已原子登记：持股 ${result.ledger.quantity}，现金 ${result.ledger.cash}；建议状态 ${result.recommendation.status}。` : "该成交已登记，本次未改变账本。"); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  }
  return <section className="decision-page">
    <header><div><p className="eyebrow">xiaomi-four-stage-v1</p><h2>小米四阶段人工检查与建议</h2></div><span className="status warning">不连接券商</span></header>
    <p className="decision-warning">勾选表示你已人工核对该事实。系统只生成建议；“接受建议”不会登记成交、改变持仓或现金。</p>
    <div className="decision-checks">{checks.map(([key, label]) => <label key={key}><input type="checkbox" checked={signals[key]} onChange={(event) => setSignals((value) => ({ ...value, [key]: event.target.checked }))} />{label}</label>)}</div>
    <button className="primary-action" type="button" onClick={() => void evaluate()}>按当前快照确定性评估</button>
    {evaluation && <article className="decision-result">
      <strong>{evaluation.outcome.outcome === "propose_sell" ? `建议卖出 ${Number(evaluation.outcome.quantity).toLocaleString()} 股` : evaluation.outcome.outcome === "exit_review" ? "进入退出评估" : evaluation.outcome.outcome === "completed" ? "四阶段计划已完成" : "等待，不执行"}</strong>
      <code>{evaluation.outcome.reason_code}</code>
      {!!evaluation.outcome.missing_checks?.length && <p>缺少：{evaluation.outcome.missing_checks.join("、")}</p>}
      {decisionKey && <><small>决策键 {decisionKey}</small><div className="decision-actions"><button type="button" disabled={accepted} onClick={async () => { await bridge.acceptDecision(profileId, decisionKey); setAccepted(true); setNotice("建议已接受；尚未登记任何成交，持仓和现金未改变。"); }}>接受建议</button><input aria-label="拒绝原因" value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} placeholder="拒绝原因" /><button type="button" disabled={accepted || !rejectReason.trim()} onClick={async () => { await bridge.rejectDecision(profileId, decisionKey, rejectReason); setNotice("建议已拒绝并写入审计。"); }}>拒绝</button><button type="button" onClick={async () => setNotice(await bridge.replayDecision(profileId, decisionKey) ? "确定性重放一致。" : "重放不一致，已停止操作。")}>验证重放</button></div>{accepted && <form className="execution-form" onSubmit={recordExecution}><h3>独立登记真实成交</h3><p>只填写券商已经成交的结果；系统不会下单。总费用会从卖出现金流扣除。</p><label>成交日期<input aria-label="成交日期" type="date" value={execution.tradedAt} onChange={(event) => setExecution((value) => ({ ...value, tradedAt: event.target.value }))} /></label><label>股数<input aria-label="成交股数" inputMode="numeric" value={execution.quantity} onChange={(event) => setExecution((value) => ({ ...value, quantity: event.target.value }))} /></label><label>均价 HKD<input aria-label="成交均价" inputMode="decimal" value={execution.price} onChange={(event) => setExecution((value) => ({ ...value, price: event.target.value }))} /></label>{([['stampDuty','印花税'],['clearingFee','清算费'],['transferFee','过户费'],['commission','手续费']] as const).map(([field, label]) => <label key={field}>{label}<input aria-label={label} inputMode="decimal" value={execution[field]} onChange={(event) => setExecution((value) => ({ ...value, [field]: event.target.value }))} /></label>)}<label>券商成交编号（推荐）<input aria-label="券商成交编号" value={execution.externalId} onChange={(event) => setExecution((value) => ({ ...value, externalId: event.target.value }))} /></label><button type="submit" disabled={!execution.tradedAt || !execution.quantity || !execution.price}>登记成交（不可替代券商下单）</button></form>}</>}
    </article>}
    {notice && <output aria-live="polite">{notice}</output>}
    <article className="decision-result strategy-editor">
      <h3>策略 DSL 正式编辑器</h3>
      <p>AI 只能生成草稿。保存、校验和发布是三个独立的本机动作；只有你点击“人工发布”才会改变正式策略版本。</p>
      <textarea aria-label="策略 DSL JSON" rows={14} value={strategyText} onChange={(event) => setStrategyText(event.target.value)} />
      <div className="decision-actions">
        <button type="button" onClick={async () => { try { const inserted = await bridge.saveStrategyDraft(profileId, parsedStrategy()); await refreshStrategies(); setNotice(inserted ? "策略草稿已保存，尚未校验或发布。" : "相同草稿已存在，本次未产生重复版本。"); } catch (error) { setNotice(String(error)); } }}>保存草稿</button>
      </div>
      {strategies.map((strategy) => <div className="strategy-version" key={`${strategy.strategy_id}:${strategy.version}`}>
        <code>{strategy.strategy_id} v{strategy.version}</code><span className="status">{strategy.lifecycle}</span>
        <button type="button" disabled={strategy.lifecycle !== "DRAFT"} onClick={async () => { try { await bridge.validateStrategy(profileId, strategy.strategy_id, strategy.version); await refreshStrategies(); setNotice("Schema、类型和权限边界校验通过；仍未发布。"); } catch (error) { setNotice(String(error)); } }}>校验</button>
        <button type="button" disabled={strategy.lifecycle !== "VALIDATED"} onClick={async () => { try { await bridge.publishStrategy(profileId, strategy.strategy_id, strategy.version); await refreshStrategies(); setNotice("策略已由本机用户明确发布；旧的正式版本已自动标记为 SUPERSEDED。"); } catch (error) { setNotice(String(error)); } }}>人工发布</button>
      </div>)}
    </article>
  </section>;
}
