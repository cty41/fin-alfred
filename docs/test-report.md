# v0.1.0 本地验收记录

记录日期：2026-08-17（Asia/Shanghai）。

## 自动化门禁

- TypeScript 类型检查：通过。
- ESLint：通过，零告警。
- Vitest：7/7 通过。
- Playwright 浏览器模拟后端流程：6/6 通过。
- Rust 工作区：62/62 通过（application 9、desktop 7、domain 23、persistence 18、platform 5）。
- `cargo fmt --all --check`：通过。
- `cargo clippy --workspace --all-targets -- -D warnings`：通过。
- 生产前端模拟数据扫描：通过；正式 bundle 不包含 `MockAppBridge` 的成交、决策或档案夹具。

## Windows 安装包

- 当前源码成功生成 `fin-alfred_0.1.0_x64-setup.exe`。
- 静默安装：通过。
- 首次启动及使用既有档案重启：通过。
- SQLCipher 档案不暴露明文 `SQLite format 3` 文件头：通过。
- 静默卸载：通过。
- 卸载后应用数据保留：通过。
- SHA-256：`0d812d92cfa0e2b24100cb4763e4b48cd4d7686556b0657f4f441b9926f00a20`。
- 当前本地包未签名；正式 Release 必须明确展示签名状态。

## 远程发布状态

源码已推送到 `cty41/fin-alfred`。GitHub Actions 仅使用 Windows runner；macOS 不属于当前构建或验收范围。GitHub Release 的 SBOM、第三方许可证清单和草稿上传仍须由发布工作流给出独立证据，不能以本地 Windows 结果冒充。
