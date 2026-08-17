import { FormEvent, useEffect, useState } from "react";
import type { AppBridge } from "../bridge/AppBridge";

type LegacyMigration = Awaited<ReturnType<AppBridge["getLegacyMigration"]>>;

export function SettingsPage({ bridge, profileId, onProfileImported }: { bridge: AppBridge; profileId: string; onProfileImported: (profile: { id: string; name: string }) => Promise<void> }) {
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/");
  const [model, setModel] = useState("gpt-5-mini");
  const [apiKey, setApiKey] = useState("");
  const [notice, setNotice] = useState("");
  const [configured, setConfigured] = useState(false);
  const [backupPassword, setBackupPassword] = useState("");
  const [restoreFile, setRestoreFile] = useState<File>();
  const [restorePassword, setRestorePassword] = useState("");
  const [backupNotice, setBackupNotice] = useState("");
  const [marketUrl, setMarketUrl] = useState("");
  const [marketSource, setMarketSource] = useState("");
  const [marketKey, setMarketKey] = useState("");
  const [marketConfigured, setMarketConfigured] = useState(false);
  const [marketNotice, setMarketNotice] = useState("");
  const [mcpConfigured, setMcpConfigured] = useState(false);
  const [mcpToken, setMcpToken] = useState("");
  const [legacy, setLegacy] = useState<LegacyMigration>({ available: false, profiles: [] });
  const [migrationNotice, setMigrationNotice] = useState("");

  useEffect(() => {
    void bridge.getLlmConfiguration(profileId).then((status) => {
      setConfigured(status.configured);
      if (bridge.mode === "http") {
        setBaseUrl(status.baseUrl);
        setModel(status.model);
      }
    });
    void bridge.getMarketProviderConfiguration(profileId).then((status) => {
      setMarketConfigured(status.configured);
      if (bridge.mode === "http") { setMarketUrl(status.quoteUrl); setMarketSource(status.sourceLabel); }
    });
    void bridge.getMcpConfiguration(profileId).then((status) => setMcpConfigured(status.configured));
    void bridge.getLegacyMigration().then(setLegacy);
  }, [bridge, profileId]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setNotice("");
    try {
      await bridge.configureLlm({ profileId, baseUrl, model, apiKey });
      setApiKey("");
      setConfigured(true);
      setNotice("配置已保存。密钥仅存于本机系统密钥库。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function exportBackup(event: FormEvent) {
    event.preventDefault(); setBackupNotice("");
    try {
      const backup = await bridge.exportProfileBackup(profileId, backupPassword);
      const link = document.createElement("a");
      link.href = URL.createObjectURL(backup);
      link.download = `${profileId}.fin-alfred-backup`;
      link.click();
      URL.revokeObjectURL(link.href);
      setBackupPassword(""); setBackupNotice("加密备份已生成；BYOK密钥未包含在内。");
    } catch (error) { setBackupNotice(error instanceof Error ? error.message : String(error)); }
  }

  async function saveMarket(event: FormEvent) {
    event.preventDefault(); setMarketNotice("");
    try { await bridge.configureMarketProvider(profileId, marketUrl, marketSource, marketKey); setMarketKey(""); setMarketConfigured(true); setMarketNotice("在线行情提供器已保存；密钥仅在本机系统密钥库中。未配置或请求失败时仍可人工录入。"); }
    catch (error) { setMarketNotice(error instanceof Error ? error.message : String(error)); }
  }

  async function importBackup(event: FormEvent) {
    event.preventDefault(); setBackupNotice("");
    try {
      if (!restoreFile) throw new Error("请选择备份文件");
      const profile = await bridge.importProfileBackup(restorePassword, await restoreFile.arrayBuffer());
      setRestorePassword(""); await onProfileImported(profile);
      setBackupNotice(`已恢复并切换到“${profile.name}”。重复导入同一备份不会重复成交。`);
    } catch (error) { setBackupNotice(error instanceof Error ? error.message : String(error)); }
  }

  async function createMcpToken() {
    setMcpToken("");
    try {
      const result = await bridge.createMcpToken(profileId);
      setMcpToken(result.token);
      setMcpConfigured(true);
    } catch (error) {
      setMcpToken(error instanceof Error ? error.message : String(error));
    }
  }

  async function migrateLegacyProfiles() {
    setMigrationNotice("");
    try {
      const result = await bridge.migrateLegacyProfiles();
      setMigrationNotice(result.imported.length ? `已安全迁移 ${result.imported.length} 个档案；旧数据仍保留。` : "这些旧档案已经迁移，无需重复处理。");
      setLegacy(await bridge.getLegacyMigration());
      if (result.imported[0]) await onProfileImported(result.imported[0]);
    } catch (error) {
      setMigrationNotice(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <section className="settings-page">
      <header><p className="eyebrow">BYOK · 读取 / 分析 / 创建草稿</p><h2>模型服务商</h2><span className={`status ${configured ? "" : "warning"}`}>{configured ? "已配置" : "未配置"}</span></header>
      <form onSubmit={save}>
        <label>Base URL<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} disabled={bridge.mode !== "http"} /></label>
        <label>模型<input value={model} onChange={(event) => setModel(event.target.value)} disabled={bridge.mode !== "http"} /></label>
        <label>API Key<input aria-label="API Key" type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} disabled={bridge.mode !== "http"} /></label>
        <p>正式档案只保存服务商地址和模型；API Key 不进入数据库、备份、日志或对话。仅允许 HTTPS（回环开发地址除外）。</p>
        <button type="submit" disabled={bridge.mode !== "http" || !apiKey.trim()}>保存BYOK配置</button>
        {notice && <output aria-live="polite">{notice}</output>}
      </form>
      <header><p className="eyebrow">默认关闭 · JSON 合约</p><h2>在线行情提供器</h2><span className={`status ${marketConfigured ? "" : "warning"}`}>{marketConfigured ? "已配置" : "未配置"}</span></header>
      <form onSubmit={saveMarket}>
        <label>报价 URL<input aria-label="在线行情URL" value={marketUrl} onChange={(event) => setMarketUrl(event.target.value)} placeholder="https://provider.example/v1/quotes/1810.HK" disabled={bridge.mode !== "http"} /></label>
        <label>来源标签<input aria-label="在线行情来源" value={marketSource} onChange={(event) => setMarketSource(event.target.value)} placeholder="提供器与套餐名称" disabled={bridge.mode !== "http"} /></label>
        <label>Bearer API Key（公开端点可留空）<input aria-label="行情 API Key" type="password" autoComplete="off" value={marketKey} onChange={(event) => setMarketKey(event.target.value)} disabled={bridge.mode !== "http"} /></label>
        <p>端点必须返回 <code>{`{"price":"25.62","currency":"HKD","observed_at":"2026-08-17T10:00:00Z"}`}</code>。仅允许 HTTPS，禁止重定向、URL 凭据、查询参数和片段。</p>
        <button type="submit" disabled={bridge.mode !== "http" || !marketUrl.trim() || !marketSource.trim()}>保存行情配置</button>
        {marketNotice && <output aria-live="polite">{marketNotice}</output>}
      </form>
      <header><p className="eyebrow">READ / ANALYZE / CREATE_DRAFT</p><h2>专家 MCP</h2><span className={`status ${mcpConfigured ? "" : "warning"}`}>{mcpConfigured ? "已配置" : "默认关闭"}</span></header>
      <section>
        <p>MCP 只提供读取、分析和创建草稿工具；不能接受建议、发布策略或登记成交。令牌只显示一次。</p>
        <button type="button" disabled={bridge.mode !== "http"} onClick={() => void createMcpToken()}>{mcpConfigured ? "轮换 MCP 令牌" : "创建 MCP 令牌"}</button>
        {mcpToken && <output aria-live="polite"><code>{mcpToken}</code></output>}
      </section>
      {legacy.available && <><header><p className="eyebrow">旧桌面数据 · 用户确认</p><h2>迁移 Tauri 档案</h2></header><section><p>检测到旧目录：<code>{legacy.directory}</code></p><ul>{legacy.profiles.map((profile) => <li key={profile.sourceId}>{profile.name}：{Number(profile.quantity).toLocaleString()}股，现金 HK${profile.cash}{profile.migrated ? "（已迁移）" : ""}</li>)}</ul><button type="button" onClick={() => void migrateLegacyProfiles()}>确认并重新加密迁移</button>{migrationNotice && <output aria-live="polite">{migrationNotice}</output>}</section></>}
      <header><p className="eyebrow">Argon2id + AES-256-GCM</p><h2>跨平台加密备份</h2></header>
      <form onSubmit={exportBackup}>
        <label>独立备份口令<input aria-label="备份导出口令" type="password" autoComplete="new-password" value={backupPassword} onChange={(event) => setBackupPassword(event.target.value)} disabled={bridge.mode !== "http"} /></label>
        <button type="submit" disabled={bridge.mode !== "http" || !backupPassword}>下载当前档案备份</button>
      </form>
      <form onSubmit={importBackup}>
        <label>备份文件<input aria-label="备份导入文件" type="file" accept=".fin-alfred-backup" onChange={(event) => setRestoreFile(event.target.files?.[0])} disabled={bridge.mode !== "http"} /></label>
        <label>备份口令<input aria-label="备份导入口令" type="password" autoComplete="current-password" value={restorePassword} onChange={(event) => setRestorePassword(event.target.value)} disabled={bridge.mode !== "http"} /></label>
        <p>恢复会生成新的本机数据库密钥，并将其绑定到当前操作系统安全存储；不会覆盖现有档案。</p>
        <button type="submit" disabled={bridge.mode !== "http" || !restoreFile || !restorePassword}>恢复为隔离档案</button>
        {backupNotice && <output aria-live="polite">{backupNotice}</output>}
      </form>
    </section>
  );
}
