# DSH Alfred

[English](README.en.md) | 简体中文

面向港股价值投资者的本地优先、可审计 DeepSeek Harness 投研 Agent。DSH Alfred 把行情、估值、持仓上下文和价值策略接入 DSH，让模型负责组织证据和解释结论，而把数据边界、计算和账本写入留给确定性工具。

> 当前版本适合个人研究使用，不构成投资建议。它不会连接券商或自动下单；只有已经在券商真实成交的记录，才可能经过“预览 → 下一轮明确确认”写入本地账本。

## 它能做什么

- 查询并比较小米、腾讯和阿里巴巴港股的行情与相对估值。
- 按 Bear / Base / Bull 情景、安全边际和预期 IRR 整理价值分析。
- 读取本地持仓与既有策略，不虚构成本价或仓位。
- 生成建仓、等待、减仓或退出复核条件；结论是策略草案，不是交易指令。
- 在用户明确确认后，原子登记已经真实发生的成交或初始持仓。
- 在 DSH Web 中提供 Alfred preset、研究 Skill、自然语言工具调用和会话内帮助。

当前支持：

| 证券 | Instrument ID | 行情代码 |
| --- | --- | --- |
| 小米集团-W | `HKEX:1810` | `01810` |
| 腾讯控股 | `HKEX:0700` | `00700` |
| 阿里巴巴-W | `HKEX:9988` | `09988` |

## 快速开始：接入 DSH

### 1. 准备环境

需要 Windows、Git、Node.js 24+、Python 3.12 和 [uv](https://docs.astral.sh/uv/)。模型和 API Key 在 DSH 中配置，Alfred 不保存模型凭据。

```powershell
git clone https://github.com/cty41/fin-alfred.git
cd fin-alfred
npm ci
uv sync --frozen --project data-provider
npm run build
```

### 2. 将插件链接到 DSH Web profile

```powershell
npx --yes @deepseek-ai/dsh plugin --profile web add ./packages/dsh-alfred
powershell -ExecutionPolicy Bypass -File ./packages/dsh-alfred/scripts/install-preset.ps1
```

如需无界面运行，也可链接到 headless profile：

```powershell
npx --yes @deepseek-ai/dsh plugin --profile headless add ./packages/dsh-alfred
```

### 3. 配置本机数据路径

在 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` 中添加或更新：

```yaml
- id: dsh-alfred
  config:
    pythonPath: C:/path/to/fin-alfred/data-provider/.venv/Scripts/python.exe
    adapterPath: C:/path/to/fin-alfred/data-provider/akshare_adapter.py
    dbPath: C:/Users/<user>/AppData/Local/fin-alfred/alfred.db
    timeoutMs: 30000
    confirmationTtlMs: 600000
```

路径使用正斜杠。若使用 headless profile，把相同配置写入对应 profile 的 `cordis.patch.yml`。

### 4. 验证并启动

```powershell
npx --yes @deepseek-ai/dsh --profile web --dump-config
npx --yes @deepseek-ai/dsh web --port 3091
```

打开 `http://127.0.0.1:3091`，新建会话并选择 `alfred` preset。先尝试：

```text
查询 HKEX:1810 当前行情，并标注数据时间和来源。
```

更完整的插件配置、工具列表和排错说明见 [packages/dsh-alfred/README.md](packages/dsh-alfred/README.md)。

## 怎么使用

可以直接用自然语言开始研究：

```text
分析腾讯现在是否值得建仓，分别给出 Bear、Base、Bull 情景和需要继续核对的证据。

比较腾讯与阿里巴巴的安全边际，不要假设我已经持仓。

读取我的小米仓位，解释后续加仓、等待和减仓条件。
```

记录真实成交时，必须明确说明成交已经发生：

```text
我已经于 2026-08-20 卖出 1000 股小米，均价 30 港元，佣金 10 港元。请先预览登记结果。
```

Alfred 会返回预览和确认令牌并停止。只有下一轮明确确认，commit 工具才会写入 SQLite。计划买入、假设成交或模型建议都不能修改账本。

## 设计边界

- **本地优先**：持仓、策略和成交保存在 `%LOCALAPPDATA%\fin-alfred\alfred.db`。数据库是明文 SQLite，请自行保护和备份。
- **证据优先**：行情与估值结果应携带来源和观察时间；缺失数据必须明确暴露。
- **建议与执行分离**：策略只给研究结论；插件不连接券商、不发送订单。
- **确认写入**：确认令牌绑定 DSH 会话、默认十分钟过期且只能使用一次；成交和持仓更新位于同一 SQLite 事务。
- **模型不是事实源**：模型负责研究编排和表达，不能替代工具数据或凭空生成持仓。
- **有限覆盖**：当前只支持三只港股，也尚未提供完整财报建模、自动更新或组合级风险优化。

## 数据与故障边界

行情和相对估值由本地 Python 适配器调用 AKShare 及其上游公开接口。上游结构、限流或网络变化可能导致数据不可用；Alfred 会返回结构化错误或降级信息，而不是伪造行情。做出投资决策前，请用交易所公告、公司财报和券商成交记录复核。

## 独立确定性工具

仓库仍保留不依赖 DSH 的 CLI/Gateway，用于直接管理本地数据或运行确定性命令：

```powershell
npm run alfred
npm run gateway
npm run dashboard
```

常用命令包括 `watchlist`、`quote`、`position`、`trade log`、`strategy` 和 `migrate import`。这条路线是底层能力与备用界面；推荐的交互入口是 DSH Alfred。

## 开发与验证

```powershell
npm run typecheck
npm test
npm run build
uv run --frozen --project data-provider python -m unittest discover -s data-provider -p "test_*.py" -v
npm pack --workspace dsh-alfred --dry-run
```

修改 DSH 客户端后必须运行根 `npm run build`，确保 `dist/client.js` 仍以 `window.__ModuleLoader__.load(...)` 注册。开发约定见 [AGENTS.md](AGENTS.md)，产品与架构说明见 [docs/product.md](docs/product.md) 和 [docs/architecture.md](docs/architecture.md)。

## 当前分发状态

目前仅承诺从本仓库源码构建并通过本地路径链接。插件仍依赖 monorepo 中的 core 与 AKShare provider，因此暂不支持 npm 或 `github:cty41/fin-alfred` 一键安装。待插件成为自包含发布包后，再加入 `dsh-plugin` 目录发现标签。

DSH 的 bundle、profile 和 Git 安装约定见 [官方插件发布文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)。

## License

[Apache-2.0](LICENSE)
