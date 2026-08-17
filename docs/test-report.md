# v0.1.0 本地验收记录

记录日期：2026-08-18（Asia/Shanghai）。

## 自动化门禁

- TypeScript 类型检查：通过。
- ESLint：通过，零告警。
- Vitest：7/7 通过。
- Playwright 浏览器模拟后端流程：6/6 通过。
- Rust 工作区：65/65 通过（application 9、domain 23、gateway 2、persistence 18、platform 5、runtime 8）。
- `cargo fmt --all --check`：通过。
- `cargo clippy --workspace --all-targets -- -D warnings`：通过。
- 生产前端模拟数据扫描：通过；正式 bundle 不包含 `MockAppBridge` 的成交、决策或档案夹具。
- npm 锁文件安装：`npm ci` 通过，审计结果为 0 个漏洞。
- PowerShell 一键源码安装：真实 Release 构建、静态页面、启动健康检查、重复安装和卸载流程通过。
- 一键卸载保留 `%LOCALAPPDATA%\fin-alfred` 数据夹具：通过。

## 已归档的桌面包证据

- 下列结果属于切换 Gateway 前的历史桌面包，不代表当前源码仍生成安装程序。
- 静默安装：通过。
- 首次启动及使用既有档案重启：通过。
- SQLCipher 档案不暴露明文 `SQLite format 3` 文件头：通过。
- 静默卸载：通过。
- 卸载后应用数据保留：通过。
- SHA-256：`0d812d92cfa0e2b24100cb4763e4b48cd4d7686556b0657f4f441b9926f00a20`。
- 当前本地包未签名；正式 Release 必须明确展示签名状态。

## Gateway 验收状态

- 真实 Gateway Playwright 流程：1/1 通过。
- `gateway:run` 静态页面、健康检查、一次性会话交换和正式账本读取：通过。
- 小米真实账本：持股 213,600 股、现金 HK$395,000、Stage 1 永久完成。
- 未认证写入、跨源会话、伪造 MCP 令牌和 MCP 正式成交越权：均被拒绝。
- 旧桌面档案重新加密迁移与重复迁移：自动测试通过，旧数据不删除。
- 当前不生成原生安装包、npm 包或 GitHub Release；PowerShell 引导脚本从确定的 Git 提交执行源码构建。
