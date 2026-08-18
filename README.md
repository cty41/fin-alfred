# fin-alfred

fin-alfred 是一个本地优先的价值投资研究助手。第一原型从 Watchlist 出发，帮助你查看价格、维护年度财务数据，并用 DCF 与相对估值形成可复核的研究结论。

当前界面提供：

- Watchlist：自选股、最近价格、价格曲线、买入价和两类估值结果。
- Summary：价格与 Bear/Base/Bull 估值位置、数据新鲜度和小米只读持仓摘要。
- Financials：年度利润表、资产负债表和现金流；数据由用户维护。
- DCF Valuation：五年 FCFE Proxy 的 Bear/Base/Bull 场景估值。
- Relative Valuation：P/E、P/CF 的历史中位数与同行参照估值。

行情与港股 P/E、P/CF 历史只会在你点击刷新后，由本机 Rust Gateway 调用锁定版本的 AKShare 适配器获取。上游失败时，应用保留上一次有效缓存，不会清空已有价格或估值数据。

## Windows 一键安装与启动

```powershell
irm https://raw.githubusercontent.com/cty41/fin-alfred/main/scripts/install.ps1 | iex
```

安装器会通过 `winget` 检查并补齐 Node、Rust、uv、C++ Build Tools 与 Strawberry Perl，随后从确定的 Git 提交构建应用，并同步隔离的 Python 3.12 + AKShare 环境。首次构建可能较慢且会请求管理员权限。

完成后请新开 PowerShell，运行：

```powershell
fin-alfred
```

程序安装在 `%LOCALAPPDATA%\Programs\fin-alfred`；本地档案、日志和缓存位于 `%LOCALAPPDATA%\fin-alfred`。

如需先审阅安装脚本：

```powershell
irm https://raw.githubusercontent.com/cty41/fin-alfred/main/scripts/install.ps1 -OutFile install.ps1
notepad install.ps1
.\install.ps1
```

卸载程序但保留本地档案：

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/cty41/fin-alfred/main/scripts/install.ps1))) -Uninstall
```

## 源码开发

工具链固定为 Node.js 24.19.x、npm、Rust 1.97.1 和 uv 0.12.2。Windows 构建还需要 Visual Studio Build Tools（Desktop development with C++）与 Strawberry Perl，用于编译 vendored OpenSSL/SQLCipher。

```powershell
npm ci
uv sync --frozen --project data-provider
npm run gateway:dev
```

`uv` 根据提交的 `data-provider/uv.lock` 下载并维护独立 Python 3.12 与 AKShare，不读取或污染系统 Python。

### 三种运行方式

| 命令 | 用途 | 数据边界 |
| --- | --- | --- |
| `npm run dev` | 只开发 React 界面，带热更新 | 使用 Mock 数据；不读档案、不访问密钥、不联网 |
| `npm run gateway:dev` | 日常完整开发 | 启动本机 Gateway 与 Vite 热更新，并打开浏览器 |
| `npm run gateway:run` | 接近生产的本地验收 | 构建静态页面后由 Gateway 直接提供，无需 Vite |

常用检查：

```powershell
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm run test:e2e:gateway
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

## 数据口径与编辑方式

- Watchlist：每个档案一个默认列表。移除自选股不会删除研究、估值或账本记录；可手工覆盖错误价格。
- Financials：只支持年度数据；在页面的 `Add/Edit Year` 弹层维护来源 URL、币种和更新时间。
- 现金流参考：`FCF Proxy = Operating Cash Flow - Capex`，仅为简化研究口径。
- DCF：默认预测五年，使用收入增长、净利率、现金转化率、折现率和 Exit P/E；Bear、Base、Bull 独立保存。
- Relative：使用 P/E 与 P/CF 的 3Y、5Y 和同行中位数。当前倍数只用于比较，不直接计入最终估值。

刷新研究数据不会修改投资档案中的历史成交、持仓或现金。小米展示的持仓、现金与 Stage 1 状态目前为只读验收数据。

## 开发诊断

当刷新行情或页面操作失败时，打开“设置 → 开发诊断”。该页可筛选 Gateway、运行时、AKShare 与浏览器错误，按关联 ID 查看完整链路，并导出脱敏诊断包用于反馈问题。

诊断日志仅保存在本机，默认保留最近 7 天；导出的包不包含数据库、投资档案、密钥、Cookie、令牌或备份口令。

## 隐私与安全

- 正式会话只经本机回环 Gateway 访问；档案按 profile 隔离。
- 数据库使用 SQLCipher；Windows 密钥由系统凭据存储保护。
- 本地备份使用口令派生密钥加密，恢复时绑定目标机器的新本机密钥。
- 行情刷新失败时使用已验证的缓存；人工修订与外部快照分开保存。

AI、MCP、策略、决策与交易工作流属于后续演进方向，当前第一原型不在界面中提供它们。架构、威胁模型和发布说明见 [架构文档](docs/architecture.md)、[安全模型](docs/security-model.md) 与 [发布说明](docs/release.md)。

## 参与贡献

请先阅读 [贡献指南](CONTRIBUTING.md) 和 [安全策略](SECURITY.md)。

## 许可证与免责声明

本项目使用 [Apache-2.0](LICENSE) 许可证。它是研究软件，不构成投资建议；交易决定与风险由使用者独立承担。
