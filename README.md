# fin-alfred

本地优先的价值投资研究助手。当前第一原型以 Watchlist 为入口，提供 Summary、年度 Financials、DCF Valuation 与 Relative Valuation 四个个股页面。AI、策略、决策与交易界面暂时隐藏，已有后端数据和权限边界继续保留。

正式数据只经本机 Rust Gateway 访问；行情以及港股 P/E、P/CF 历史由锁定版本的 AKShare 适配器按用户操作刷新。上游失败不会清空已有缓存。

## Windows 一键安装

```powershell
irm https://raw.githubusercontent.com/cty41/fin-alfred/main/scripts/install.ps1 | iex
```

安装器会检查并通过 `winget` 补齐 Node、Rust、uv、C++ Build Tools 和 Strawberry Perl，从确定的 Git 提交构建程序，同步隔离的 Python 3.12 + AKShare 环境，然后创建 `fin-alfred` 命令。首次构建可能较慢并请求管理员权限；安装后新开 PowerShell，运行 `fin-alfred` 即可启动。程序位于 `%LOCALAPPDATA%\Programs\fin-alfred`，加密档案独立保存在 `%LOCALAPPDATA%\fin-alfred`。

审阅脚本后安装：

```powershell
irm https://raw.githubusercontent.com/cty41/fin-alfred/main/scripts/install.ps1 -OutFile install.ps1
notepad install.ps1
.\install.ps1
```

卸载程序但保留投资档案：

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/cty41/fin-alfred/main/scripts/install.ps1))) -Uninstall
```

## 开发

工具链固定为 Node.js 24.19.x、npm、Rust 1.97.1 和 uv 0.12.2。uv 按 `data-provider/uv.lock` 管理独立 Python 3.12 与 AKShare，不读取或污染用户已有的 Python。Windows 构建还需要 Visual Studio Build Tools（Desktop development with C++）与 Strawberry Perl（编译 vendored OpenSSL/SQLCipher）。

```powershell
npm ci
uv sync --frozen --project data-provider
npm run dev
npm run gateway:dev
npm run gateway:run
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm run test:e2e:gateway
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

`npm run dev` 只使用 `MockAppBridge`，不会读取真实账本、密钥或联网行情。`npm run gateway:dev` 会先校验锁定的 AKShare 环境，再启动 Vite 与本地 Rust Gateway并打开浏览器；`npm run gateway:run` 构建静态页面后由 Gateway 直接提供，不依赖 Vite。

## 第一原型的数据口径

- Watchlist：单档案一个列表；行情只在点击 `Refresh Prices` 后刷新，支持人工价格覆盖。
- Financials：年度数据手工维护；`FCF Proxy = Operating Cash Flow - Capex`，仅作简化历史参考。
- DCF：五年 FCFE Proxy、利润率线性过渡和 Exit P/E 终值，Bear/Base/Bull 假设分别保存。
- Relative：P/E 与 P/CF 的 3Y、5Y及同行中位数参照；当前倍数只比较，不参与最终估值。
- 小米真实持仓、现金与 Stage 1 完成状态只读展示，刷新研究数据不会修改账本。

## 安全边界

- 每个投资档案独立数据库；正式目标使用 SQLCipher。
- Windows 密钥进入系统凭据存储；平台接口为未来的 macOS Keychain 适配保留边界。普通导出不包含 BYOK 密钥。
- 跨平台备份以 Argon2id 派生密钥，使用 AES-256-GCM 加密，恢复时重新绑定本机密钥。
- “接受建议”与“登记成交”是不同状态转换；LLM 两者均无权调用。
- 人工行情默认24小时失效；基本面与SOTP必须带来源、有效期和内容哈希。缺失或过期数据不能通过勾选检查表绕过。
- 在线行情适配器默认未配置，支持每档案独立的 HTTPS JSON 端点与可选 Bearer 密钥；密钥仅在系统密钥库。提供器失败时不覆盖快照，可继续使用人工兜底。
- 审计事件按档案显式隔离；卖出现金不会自动再部署。
- 新建家人档案可建立一次性、经用户核验的持仓/现金基线，并登记已经发生的券商成交。系统不会连接券商；成交费用修订保持原幂等键和持股不变，只原子调整现金差额并写审计。
- 策略 DSL 只允许类型化指标、比较/布尔/时间条件、区间、组合约束、有限状态机、人工检查表和建议元数据，不包含任意代码、网络、文件系统、无限循环或动态库能力。
- 策略正式生命周期固定为 `DRAFT → VALIDATED → PUBLISHED → SUPERSEDED`：相同版本不可静默覆盖；每个待校验版本必须带可确定性重放且全部通过的测试场景；LLM 只能创建草稿，校验和发布必须由本机用户分别确认。
- 专家 MCP 默认关闭；设置页生成只显示一次的令牌。工具面只允许读取、分析和创建草稿，危险能力不进入 MCP 路由。

架构、威胁模型与发布验收详见 [docs/architecture.md](docs/architecture.md)、[docs/security-model.md](docs/security-model.md) 和 [docs/release.md](docs/release.md)。

## 许可证

Apache-2.0。投资研究软件不构成投资建议，交易决定与风险由使用者独立承担。
