import { Bot, BookOpenText, BriefcaseBusiness, ChevronDown, ClipboardCheck, Database, FileClock, Languages, Settings, ShieldAlert } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { appBridge } from "./bridge";
import { AgentPanel } from "./components/AgentPanel";
import { QualityTrack } from "./components/QualityTrack";
import { StageProgress } from "./components/StageProgress";
import { SettingsPage } from "./components/SettingsPage";
import { DecisionPage } from "./components/DecisionPage";
import { ResearchDataEditor } from "./components/ResearchDataEditor";
import { ActivityPage } from "./components/ActivityPage";
import type { ProfileOverview } from "./domain/types";
import { I18nProvider, useI18n } from "./i18n";

const nav = [
  ["研究", "research", BookOpenText], ["组合", "portfolio", BriefcaseBusiness], ["决策", "decisions", ClipboardCheck],
  ["账本", "ledger", Database], ["审计", "audit", FileClock], ["设置", "settings", Settings],
] as const;

function money(amount: string) {
  return amount === "—" ? amount : `HK$${Number(amount).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`;
}

export function App() { return <I18nProvider><AppContent /></I18nProvider>; }

function AppContent() {
  const { locale, setLocale, t } = useI18n();
  const [overview, setOverview] = useState<ProfileOverview>();
  const [agentOpen, setAgentOpen] = useState(true);
  const [activePage, setActivePage] = useState("研究");
  const [profiles, setProfiles] = useState<Array<{ id: string; name: string }>>([]);
  const [creatingProfile, setCreatingProfile] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [editingResearch, setEditingResearch] = useState(false);

  useEffect(() => {
    void Promise.all([appBridge.getOverview(), appBridge.listProfiles()]).then(([nextOverview, items]) => {
      setOverview(nextOverview);
      setProfiles(items);
    });
  }, []);

  async function selectProfile(profileId: string) {
    setOverview(undefined);
    setOverview(await appBridge.getOverview(profileId));
  }

  async function createProfile(event: FormEvent) {
    event.preventDefault();
    if (!profileName.trim()) return;
    const created = await appBridge.createProfile(profileName);
    setProfiles((items) => [...items, created]);
    setProfileName("");
    setCreatingProfile(false);
    await selectProfile(created.id);
  }

  if (!overview) return <main className="loading">{t("opening")}</main>;

  const sold = Number(overview.initialQuantity) - Number(overview.currentQuantity);
  const stageOne = overview.stages[0];
  const completion = (sold / Number(stageOne.cumulativeTargetQuantity)) * 100;
  const activeDisplay = t(nav.find(([label]) => label === activePage)?.[1] ?? "research");

  return (
    <div className={`app-shell ${agentOpen ? "with-agent" : ""}`}>
      <aside className="sidebar">
        <div className="brand"><span>FA</span><div><strong>fin-alfred</strong><small>可靠的价值投资管家</small></div></div>
        <div className="profile-switcher"><span><small>{t("profile")}</small><select aria-label="切换投资档案" value={overview.profileId} onChange={(event) => void selectProfile(event.target.value)}>{profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}</option>)}</select></span><ChevronDown /></div>
        {creatingProfile ? <form className="create-profile" onSubmit={createProfile}><input aria-label="新档案名称" autoFocus maxLength={80} value={profileName} onChange={(event) => setProfileName(event.target.value)} placeholder="例如：家人投资档案" /><div><button type="button" onClick={() => setCreatingProfile(false)}>{t("cancel")}</button><button type="submit">{t("create")}</button></div></form> : <button className="new-profile" type="button" onClick={() => setCreatingProfile(true)}>{t("newProfile")}</button>}
        <nav>{nav.map(([label, key, Icon]) => <button className={activePage === label ? "active" : ""} onClick={() => setActivePage(label)} type="button" key={label}><Icon /><span>{t(key)}</span></button>)}</nav>
        <div className="sidebar-footer"><span className="mode-dot" />{appBridge.mode === "mock" ? t("browserMode") : t("encryptedMode")}</div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div><p className="breadcrumb">{activeDisplay}{activePage === "研究" ? ` / ${overview.symbol}` : ""}</p><h1>{activePage === "研究" ? overview.instrumentName : activeDisplay}</h1></div>
          <div className="top-actions"><button aria-label="切换语言" type="button" onClick={() => setLocale(locale === "zh-CN" ? "en" : "zh-CN")}><Languages />{t("language")}</button><button className="agent-toggle" type="button" onClick={() => setAgentOpen(true)}><Bot />{t("assistant")}</button></div>
        </header>

        {activePage === "设置" ? <SettingsPage bridge={appBridge} profileId={overview.profileId} onProfileImported={async (profile) => { setProfiles(await appBridge.listProfiles()); await selectProfile(profile.id); }} /> : activePage === "决策" ? <DecisionPage bridge={appBridge} profileId={overview.profileId} /> : activePage === "组合" || activePage === "账本" || activePage === "审计" ? <ActivityPage key={`${overview.profileId}:${activePage}`} bridge={appBridge} profileId={overview.profileId} view={activePage} /> : <div className="research-layout">
          <aside className="watchlist">
            <div className="panel-heading"><span>{t("watchlist")}</span><small>1</small></div>
            <button className="watch-item active" type="button"><span><strong>{overview.symbol}</strong><small>{overview.instrumentName}</small></span><span className="attention-dot" aria-label="需要复核" /></button>
            <div className="health-summary"><ShieldAlert /><div><strong>{overview.unknownCount}项证据待补充</strong><small>首版评分尚未发布</small></div></div>
          </aside>

          <section className="research-main">
            <div className="summary-row">
              <div><small>{t("currentPosition")}</small><strong>{Number(overview.currentQuantity).toLocaleString()}股</strong><span>初始 {Number(overview.initialQuantity).toLocaleString()}股</span></div>
              <div><small>{t("cash")}</small><strong>{money(overview.cash.amount)}</strong><span>已核验</span></div>
              <div><small>{t("completedReduction")}</small><strong>{sold.toLocaleString()}股</strong><span>Stage 1完成率 {completion.toFixed(2)}%</span></div>
            </div>

            <section className="trend-panel">
              <header className="section-heading"><div><p className="eyebrow">最近5年 + TTM</p><h2>业务质量趋势</h2></div><button type="button" onClick={() => setEditingResearch(true)}>录入研究数据</button></header>
              {editingResearch && <ResearchDataEditor key={overview.profileId} bridge={appBridge} profileId={overview.profileId} onClose={() => setEditingResearch(false)} />}
              <div className="empty-chart"><div className="chart-lines"><i /><i /><i /><i /></div><p>发布首版财务研究后，这里将显示收入、现金流、资本回报和汽车业务趋势。</p></div>
            </section>

            <div className="quality-grid">
              <QualityTrack title="李录轨" weight="长期复利质量 · 50%" dimensions={overview.liLu} />
              <QualityTrack title="Burry轨" weight="逆向价值与下行保护 · 50%" dimensions={overview.burry} />
            </div>
          </section>

          <aside className="decision-context">
            <section className="valuation-card">
              <header className="section-heading"><div><p className="eyebrow">SOTP主估值</p><h3>估值与回报</h3></div><span className="status warning">待发布</span></header>
              <dl><div><dt>Bear</dt><dd>{money(overview.valuation.bear.amount)}</dd></div><div><dt>Base</dt><dd>{money(overview.valuation.base.amount)}</dd></div><div><dt>Bull</dt><dd>{money(overview.valuation.bull.amount)}</dd></div><div><dt>Base IRR</dt><dd>{overview.valuation.baseIrr}</dd></div><div><dt>Reverse DCF</dt><dd>{overview.valuation.reverseDcf}</dd></div></dl>
            </section>
            <StageProgress stages={overview.stages} />
            <section className="next-action"><small>下一项必要工作</small><strong>发布小米首版SOTP与双轨评分</strong><p>在估值和基本面检查完成前，Stage 2不会生成可执行建议。</p><button type="button">开始研究草稿</button></section>
          </aside>
        </div>}
      </main>
      <AgentPanel key={overview.profileId} bridge={appBridge} overview={overview} open={agentOpen} onClose={() => setAgentOpen(false)} />
    </div>
  );
}
