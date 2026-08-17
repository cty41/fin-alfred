# fin-alfred

本地优先、可审计、幂等的价值投资研究与决策助手。当前版本从源码启动 Windows 本地 Gateway，并在浏览器中使用；npm 全局分发留待功能闭环稳定后处理。LLM 采用 BYOK，权限固定为读取、分析和创建草稿，不能修改正式状态或执行交易。

## 开发

工具链固定为 Node.js 24.19.0、pnpm 11.19.0、Rust 1.97.1。Windows 构建还需要 Visual Studio Build Tools（Desktop development with C++）与 Strawberry Perl（编译 vendored OpenSSL/SQLCipher）。

```powershell
pnpm install --frozen-lockfile
pnpm dev
pnpm gateway:dev
pnpm gateway:run
pnpm typecheck
pnpm lint
pnpm test
pnpm test:e2e
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

`pnpm dev` 只使用 `MockAppBridge`，不会读取真实账本或密钥。`pnpm gateway:dev` 启动 Vite 与本地 Rust Gateway；`pnpm gateway:run` 构建静态页面后由 Gateway 直接提供，不依赖 Vite。

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
