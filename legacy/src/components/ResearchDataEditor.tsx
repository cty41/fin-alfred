import { FormEvent, useState } from "react";
import type { AppBridge } from "../bridge/AppBridge";
import type { EvidenceScoreInput, SotpInput, ValueAssessmentInput } from "../domain/types";

const names = ["Smartphone", "IoT & Lifestyle", "Internet Services", "EV", "AI、机器人及其他可选价值", "净现金、债务、少数股东权益和集团调整"];
const today = new Date().toISOString().slice(0, 10);
const review = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
const metricNames: Array<[string, string]> = [["revenue", "收入"], ["operating_cash_flow", "经营现金流"], ["capital_expenditure", "资本开支"], ["free_cash_flow", "自由现金流"], ["smartphone_gross_margin", "手机毛利率"], ["ev_gross_margin", "汽车毛利率"], ["net_cash", "净现金"], ["total_debt", "有息债务"]];
const liLuCriteria = [["moat", "护城河 25%"], ["incremental_roic", "增量资本回报与再投资 25%"], ["cash_conversion", "现金流转化 15%"], ["management_and_allocation", "管理层与资本配置 15%"], ["balance_sheet", "资产负债表 10%"], ["runway", "长期跑道 10%"]] as const;
const burryCriteria = [["valuation_discount", "估值折价 25%"], ["bear_protection", "Bear下行保护 25%"], ["balance_sheet", "资产负债表 15%"], ["normalized_fcf", "正常化自由现金流 15%"], ["expectation_gap", "预期差 10%"], ["catalyst", "催化与价值释放 10%"]] as const;
const unknownScores = Object.fromEntries([...liLuCriteria, ...burryCriteria].map(([key]) => [key, "unknown"])) as Record<string, EvidenceScoreInput>;

export function ResearchDataEditor({ bridge, profileId, onClose }: { bridge: AppBridge; profileId: string; onClose: () => void }) {
  const [price, setPrice] = useState("");
  const [quoteSource, setQuoteSource] = useState("");
  const [values, setValues] = useState(names.map(() => ({ bear: "", base: "", bull: "" })));
  const [shares, setShares] = useState("");
  const [asOf, setAsOf] = useState(today);
  const [reviewDue, setReviewDue] = useState(review);
  const [evidence, setEvidence] = useState("");
  const [notice, setNotice] = useState("");
  const [fundamentalDates, setFundamentalDates] = useState({ periodEnd: today, publishedAt: today, validUntil: review });
  const [fundamentalSource, setFundamentalSource] = useState("");
  const [metrics, setMetrics] = useState<Record<string, string>>(Object.fromEntries(metricNames.map(([key]) => [key, ""])));
  const [gate, setGate] = useState<ValueAssessmentInput["gate"]>("yellow");
  const [liLuScores, setLiLuScores] = useState<Record<string, EvidenceScoreInput>>({ ...unknownScores });
  const [burryScores, setBurryScores] = useState<Record<string, EvidenceScoreInput>>({ ...unknownScores });
  const [reverseDcf, setReverseDcf] = useState({ enterpriseValue: "", startingFcf: "", discountRate: "0.10", terminalMultiple: "", years: "5", evidence: "" });

  async function saveQuote(event: FormEvent) {
    event.preventDefault(); setNotice("");
    try { const inserted = await bridge.saveManualQuote(profileId, price, new Date().toISOString(), quoteSource); setNotice(inserted ? "人工行情快照已保存，24小时后自动失效。" : "相同行情快照已存在。"); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  }

  async function refreshOnlineQuote() {
    setNotice("");
    try { const result = await bridge.refreshMarketQuote(profileId); setNotice(result.inserted ? `在线行情已保存：HKD ${result.snapshot.price}，来源 ${result.snapshot.source_label}。` : "提供器返回的相同行情快照已存在。"); }
    catch (error) { setNotice(`${error instanceof Error ? error.message : String(error)}；可继续使用下方人工行情兜底。`); }
  }

  async function saveValuation(event: FormEvent) {
    event.preventDefault(); setNotice("");
    const component = (index: number) => ({ name: names[index], bear_value: values[index].bear, base_value: values[index].base, bull_value: values[index].bull, confidence: "medium" as const, evidence_reference: evidence });
    const snapshot: SotpInput = { profile_id: profileId, instrument_id: "HKEX:1810", as_of: asOf, review_due: reviewDue, components: [0, 1, 2, 3, 4].map(component), group_adjustment: component(5), diluted_shares: shares };
    try { await bridge.saveSotp(profileId, snapshot); setNotice("SOTP快照已保存；决策会固定引用其内容哈希和复核日期。"); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  }

  async function saveFundamentals(event: FormEvent) {
    event.preventDefault(); setNotice("");
    try { const inserted = await bridge.saveFundamentals(profileId, { profile_id: profileId, instrument_id: "HKEX:1810", period_end: fundamentalDates.periodEnd, published_at: fundamentalDates.publishedAt, valid_until: fundamentalDates.validUntil, source_label: fundamentalSource, metrics: Object.fromEntries(metricNames.map(([key]) => [key, metrics[key].trim() ? metrics[key] : null])) }); setNotice(inserted ? "基本面快照已保存；空白指标明确记录为Unknown。" : "相同基本面快照已存在。"); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  }

  async function saveAssessment(event: FormEvent) {
    event.preventDefault(); setNotice("");
    const assessment = { gate, li_lu: Object.fromEntries(liLuCriteria.map(([key]) => [key, liLuScores[key]])), burry: Object.fromEntries(burryCriteria.map(([key]) => [key, burryScores[key]])) } as ValueAssessmentInput;
    try { await bridge.saveValueAssessment(profileId, assessment); setNotice("双轨评分已版本化保存；Unknown不会按中性计分，红黄线继续约束仓位。"); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  }

  async function saveReverseDcf(event: FormEvent) {
    event.preventDefault(); setNotice("");
    try { const result = await bridge.saveReverseDcf(profileId, { profile_id: profileId, instrument_id: "HKEX:1810", as_of: asOf, review_due: reviewDue, enterprise_value: reverseDcf.enterpriseValue, starting_free_cash_flow: reverseDcf.startingFcf, discount_rate: reverseDcf.discountRate, terminal_multiple: reverseDcf.terminalMultiple, years: Number(reverseDcf.years), evidence_reference: reverseDcf.evidence }); setNotice(`Reverse DCF已保存：市场隐含FCF年增速 ${(Number(result.impliedFcfGrowth) * 100).toFixed(2)}%。`); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  }

  return <section className="research-editor">
    <header><div><p className="eyebrow">人工数据兜底</p><h2>行情与SOTP快照</h2></div><button type="button" onClick={onClose}>关闭</button></header>
    <div className="online-quote"><button type="button" disabled={bridge.mode !== "http"} onClick={() => void refreshOnlineQuote()}>从已配置提供器刷新行情</button><p>在线失败不会覆盖现有快照，也不会阻止人工兜底。</p></div>
    <form onSubmit={saveQuote}><h3>港股行情 · 人工兜底</h3><label>1810.HK价格（HKD）<input aria-label="1810.HK价格" inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} /></label><label>来源与核验说明<input aria-label="行情来源" value={quoteSource} onChange={(event) => setQuoteSource(event.target.value)} placeholder="例如：券商成交页，人工核对" /></label><button type="submit" disabled={!price || !quoteSource.trim()}>保存24小时行情快照</button></form>
    <form onSubmit={saveFundamentals}><h3>基本面快照（空白保留为Unknown，不按中性计分）</h3><div className="fundamental-grid">{metricNames.map(([key, label]) => <label key={key}>{label}<input aria-label={label} inputMode="decimal" value={metrics[key]} onChange={(event) => setMetrics((current) => ({ ...current, [key]: event.target.value }))} /></label>)}</div><label>报告期末<input type="date" value={fundamentalDates.periodEnd} onChange={(event) => setFundamentalDates((value) => ({ ...value, periodEnd: event.target.value }))} /></label><label>发布日期<input type="date" value={fundamentalDates.publishedAt} onChange={(event) => setFundamentalDates((value) => ({ ...value, publishedAt: event.target.value }))} /></label><label>有效期/强制复核日<input type="date" value={fundamentalDates.validUntil} onChange={(event) => setFundamentalDates((value) => ({ ...value, validUntil: event.target.value }))} /></label><label>财报来源<input aria-label="基本面来源" value={fundamentalSource} onChange={(event) => setFundamentalSource(event.target.value)} placeholder="公告名称、发布日期和页码" /></label><button type="submit" disabled={!fundamentalSource.trim()}>保存基本面快照</button></form>
    <form onSubmit={saveAssessment}><h3>李录 / Burry 双轨评分</h3><label>红黄线状态<select aria-label="红黄线状态" value={gate} onChange={(event) => setGate(event.target.value as ValueAssessmentInput["gate"])}><option value="clear">Clear</option><option value="yellow">Yellow（最大仓位25%）</option><option value="red">Red（禁止新增风险，进入退出评估）</option></select></label><div className="assessment-grid"><section><strong>李录轨 · 50%</strong>{liLuCriteria.map(([key, label]) => <ScoreSelect key={key} label={label} value={liLuScores[key]} onChange={(score) => setLiLuScores((current) => ({ ...current, [key]: score }))} />)}</section><section><strong>Burry轨 · 50%</strong>{burryCriteria.map(([key, label]) => <ScoreSelect key={key} label={label} value={burryScores[key]} onChange={(score) => setBurryScores((current) => ({ ...current, [key]: score }))} />)}</section></div><button type="submit">保存版本化评分</button></form>
    <form onSubmit={saveReverseDcf}><h3>Reverse DCF隐含假设</h3><label>当前企业价值<input aria-label="当前企业价值" inputMode="decimal" value={reverseDcf.enterpriseValue} onChange={(event) => setReverseDcf((value) => ({ ...value, enterpriseValue: event.target.value }))} /></label><label>起始正常化FCF<input aria-label="起始正常化FCF" inputMode="decimal" value={reverseDcf.startingFcf} onChange={(event) => setReverseDcf((value) => ({ ...value, startingFcf: event.target.value }))} /></label><label>折现率（0.10代表10%）<input aria-label="Reverse DCF折现率" inputMode="decimal" value={reverseDcf.discountRate} onChange={(event) => setReverseDcf((value) => ({ ...value, discountRate: event.target.value }))} /></label><label>终值FCF倍数<input aria-label="终值FCF倍数" inputMode="decimal" value={reverseDcf.terminalMultiple} onChange={(event) => setReverseDcf((value) => ({ ...value, terminalMultiple: event.target.value }))} /></label><label>预测年数<input aria-label="Reverse DCF预测年数" inputMode="numeric" value={reverseDcf.years} onChange={(event) => setReverseDcf((value) => ({ ...value, years: event.target.value }))} /></label><label>证据与口径<input aria-label="Reverse DCF证据" value={reverseDcf.evidence} onChange={(event) => setReverseDcf((value) => ({ ...value, evidence: event.target.value }))} /></label><button type="submit" disabled={!reverseDcf.enterpriseValue || !reverseDcf.startingFcf || !reverseDcf.terminalMultiple || !reverseDcf.evidence.trim()}>求解并保存隐含增速</button></form>
    <form onSubmit={saveValuation}><h3>小米SOTP（价值和摊薄股数使用相同的“百万”单位）</h3><div className="sotp-grid"><strong>分部</strong><strong>Bear</strong><strong>Base</strong><strong>Bull</strong>{names.map((name, index) => <div className="sotp-row" key={name}><span>{name}</span>{(["bear", "base", "bull"] as const).map((field) => <input aria-label={`${name} ${field}`} inputMode="decimal" value={values[index][field]} onChange={(event) => setValues((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: event.target.value } : item))} key={field} />)}</div>)}</div><label>摊薄股数（百万股）<input aria-label="摊薄股数" inputMode="decimal" value={shares} onChange={(event) => setShares(event.target.value)} /></label><label>估值日<input type="date" value={asOf} onChange={(event) => setAsOf(event.target.value)} /></label><label>复核日<input type="date" value={reviewDue} onChange={(event) => setReviewDue(event.target.value)} /></label><label>证据引用<input aria-label="SOTP证据引用" value={evidence} onChange={(event) => setEvidence(event.target.value)} placeholder="财报页码、研究文件或计算说明" /></label><button type="submit" disabled={!shares || !evidence.trim() || values.some((item) => !item.bear || !item.base || !item.bull)}>保存版本化SOTP</button></form>
    {notice && <output aria-live="polite">{notice}</output>}
  </section>;
}

function ScoreSelect({ label, value, onChange }: { label: string; value: EvidenceScoreInput; onChange: (value: EvidenceScoreInput) => void }) {
  return <label>{label}<select aria-label={label} value={value} onChange={(event) => onChange(event.target.value as EvidenceScoreInput)}><option value="unknown">Unknown</option><option value="zero">0</option><option value="one">1</option><option value="two">2</option><option value="three">3</option><option value="four">4</option></select></label>;
}
