# dsh-alfred 插件

[English](README.en.md) | 简体中文

`dsh-alfred` 是 [DSH Alfred](../../README.md) 的 DeepSeek Harness bundle。它把港股行情、相对估值、本地持仓、价值策略和经过确认的账本写入注册为 DSH 工具，并提供 Alfred agent preset、投资研究 Skill 与 Web 会话帮助。

当前支持 `HKEX:1810` 小米、`HKEX:0700` 腾讯和 `HKEX:9988` 阿里巴巴。

## 能力与边界

| 能力 | 行为 |
| --- | --- |
| 行情与估值 | 只读调用本地 AKShare adapter，返回来源、时间或结构化错误 |
| 持仓上下文 | 只读打开本地 Alfred SQLite，不虚构缺失记录 |
| 价值策略 | 根据已核对的 Bear / Base / Bull、价格和 Base IRR 计算策略状态 |
| 成交登记 | 仅登记已在券商发生的成交；prepare 预览后必须下一轮确认 commit |
| 模型 | 完全由 DSH 配置；插件不提供 provider，也不保存 API Key |
| 券商 | 无连接、无下单、无自动交易能力 |

## 源码安装

当前插件是 monorepo 子包，依赖相邻的 `@fin-alfred/core` 和 `@fin-alfred/provider-akshare`。请从仓库源码构建并本地链接；暂不支持 npm 或 GitHub 一键安装。

### 前置条件

- Windows
- Node.js 24+
- Python 3.12
- [uv](https://docs.astral.sh/uv/)
- 可运行的 DeepSeek Harness

```powershell
git clone https://github.com/cty41/fin-alfred.git
cd fin-alfred
npm ci
uv sync --frozen --project data-provider
npm run build
```

链接 Web profile 并安装 preset：

```powershell
npx --yes @deepseek-ai/dsh plugin --profile web add ./packages/dsh-alfred
powershell -ExecutionPolicy Bypass -File ./packages/dsh-alfred/scripts/install-preset.ps1
```

可选链接 headless profile：

```powershell
npx --yes @deepseek-ai/dsh plugin --profile headless add ./packages/dsh-alfred
```

DSH 的本地 bundle 安装与配置层规则见 [官方发布文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)。

## 配置

在 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` 中配置 bundle 行。该文件是 YAML 数组，不是以插件名为键的对象：

```yaml
- id: dsh-alfred
  config:
    pythonPath: C:/path/to/fin-alfred/data-provider/.venv/Scripts/python.exe
    adapterPath: C:/path/to/fin-alfred/data-provider/akshare_adapter.py
    dbPath: C:/Users/<user>/AppData/Local/fin-alfred/alfred.db
    timeoutMs: 30000
    confirmationTtlMs: 600000
```

也可通过 `FIN_ALFRED_PYTHON_PATH`、`FIN_ALFRED_AKSHARE_ADAPTER`、`FIN_ALFRED_DB_PATH` 和 `FIN_ALFRED_AKSHARE_TIMEOUT_MS` 提供默认值；profile 中的显式配置优先。

模型在 DSH Models 页面或 DSH profile overlay 中配置。DeepSeek、OpenRouter、Ollama 等 provider 的网络或密钥错误与 Alfred 插件无关。

## 启动与验收

先检查组合后的配置是否包含 `dsh-alfred`：

```powershell
npx --yes @deepseek-ai/dsh --profile web --dump-config
npx --yes @deepseek-ai/dsh web --port 3091
```

打开 `http://127.0.0.1:3091`，新建会话并选择 `alfred`。空白会话会显示帮助卡；示例按钮只填入输入框，不自动发送。建议依次验证：

```text
查询 HKEX:1810 当前行情，并只总结工具返回的数据时间、来源和价格。
分析腾讯现在是否值得建仓，列出缺失证据。
比较腾讯和阿里巴巴的安全边际，不要假设持仓。
```

## 注册的工具

| 工具 | 类型 | 用途 |
| --- | --- | --- |
| `alfred_stock_quote` | 只读 | 查询任意港股行情（代码或中文/英文名称） |
| `alfred_stock_fundamentals` | 只读 | 当前估值、历史分位摘要 |
| `alfred_financial_statements` | 只读 | 三大财务报表明细（资产负债表/利润表/现金流量表）与标准科目汇总（现金/投资/有息负债/少数股东权益等） |
| `alfred_portfolio_context` | 只读 | 查询本地持仓和策略上下文 |
| `alfred_value_strategy` | 纯计算 | 根据价值情景输出策略状态 |
| `alfred_prepare_execution` | 只读预览 | 预览真实成交登记并生成确认令牌 |
| `alfred_commit_execution` | 确认写入 | 原子登记已确认成交并更新持仓 |
| `alfred_prepare_initial_position` | 只读预览 | 预览首次初始持仓设置 |
| `alfred_commit_initial_position` | 确认写入 | 提交不存在历史记录的初始持仓 |

确认令牌默认十分钟过期、绑定当前 DSH session 且只能使用一次。commit 会重新检查现金、持仓和重复 execution key；失败事务不会留下半笔成交。

只读工具接受任意港股代码（`HKEX:0001`、`2020.HK`、`9633` 等）或名称（需先从缓存的全量港股列表解析；列表每 24 小时刷新一次，首次可能较慢）。三只锚点股（小米/腾讯/阿里）保留中文快捷别名。

### 财务报表明细的边界

`alfred_financial_statements` 的三大报表来自东方财富公开数据接口（`datacenter.eastmoney.com`，免费、无鉴权），是**二手汇总**，不是公司 IR 官网原文。注意：

- **币种**：三大报表均以**人民币（CNY）**列示，返回值中 `currency` 为「人民币」。
- **报告期**：`报告期` 返回各期（含季度），`年度` 仅返回财年 12-31；阿里以财年 3 月为年结，横向对比时需注意报告期对齐。
- **科目名非统一**：各公司科目名按各自财报归并，不一致；标准科目汇总（现金、投资、有息负债、少数股东权益、总资产、总负债、股东权益）由 `packages/core/src/financials.ts` 的**通用关键词映射层**产出，返回中 `mapping.heuristic=true` 标注其启发式性质，原始科目原样保留可审计。
- **拿不到的分部数据**：三大报表不含分部收入（腾讯的增值服务/网络广告/金融科技与企业服务拆分），需官方业绩公告 PDF，本期未接入。

## 使用示例

### 无持仓研究

```text
对腾讯做一次新建仓价值分析。先查工具，再分开写事实、假设、计算和策略草案。
```

### 已有持仓管理

```text
读取我的小米持仓，结合当前估值解释加仓、等待、减仓和退出复核条件。
```

### 登记真实成交

```text
我已经于 2026-08-20T10:00:00+08:00 卖出 1000 股小米，均价 30 港元，佣金 10 港元。请先预览，不要直接写入。
```

查看预览后，在下一轮明确回复确认。`tradedAt` 接受 `YYYY-MM-DD`，或带 `Z` / UTC 偏移的完整 ISO 时间；不接受没有时区的本地时间。

## 常见问题

### `EADDRINUSE: 3091`

3091 已有监听进程。先用 `Get-NetTCPConnection -LocalPort 3091 -State Listen` 查明 PID；确认它是旧 DSH 后再结束，或改用其他端口。不要盲目结束未知进程。

### 页面显示 `Failed to load plugins`

执行根目录 `npm run build`，确认 `packages/dsh-alfred/dist/client.js` 首行包含 `window.__ModuleLoader__.load`，然后重启 DSH。普通 `tsc` ESM 产物不能直接作为 DSH Web client bundle。

### Alfred preset 不存在

重新运行 `scripts/install-preset.ps1`，确认 `%USERPROFILE%\.dsh\.agent-presets\alfred\agent.cordis.yml` 存在，再重启 DSH 并新建会话。

### 模型配置提示 `Failed to fetch`

这是 DSH provider 到模型端点的连接问题。先在 DSH 中独立验证 base URL、API Key、代理和本地 Ollama 监听状态；Alfred 不接管模型请求。

### 行情或估值不可用

确认 `pythonPath`、`adapterPath` 和 uv 环境正确，并直接运行 adapter 测试。AKShare 上游公开接口仍可能因网络、限流或结构变化失败；插件不会用模型猜测缺失行情。

```powershell
uv run --frozen --project data-provider python -m unittest discover -s data-provider -p "test_*.py" -v
```

## 开发

```powershell
npm run typecheck
npm test
npm run build
npm pack --workspace dsh-alfred --dry-run
```

本地 `link` 安装在源码更新后无需重装，但必须重新 build 并重启 DSH。preset 文件变更后还需重新运行安装脚本。

## 分发状态

`package.json` 目前保持 `private: true`，workspace 依赖使用 `file:..`。在生成自包含发布包、预编译 server/client 产物并验证干净安装前，不添加 `dsh-plugin` topic，也不向社区目录宣称可一键安装。

## License

[Apache-2.0](../../LICENSE)
