# 发布验收

Windows 发布流水线先运行前端、浏览器E2E和 Rust 门禁，再生成 NSIS、执行隔离安装/启动/卸载/数据保留测试，并生成 SHA-256、SPDX SBOM、Rust与前端第三方许可证清单。Release 默认是草稿，人工确认签名状态和干净机验收后才发布。

本地包验收命令：

```powershell
./scripts/Test-WindowsPackage.ps1 -InstallerPath './target/release/bundle/nsis/fin-alfred_0.1.0_x64-setup.exe'
```

当前 CI、构建和发布验收仅覆盖 Windows PC。macOS 不运行 CI、不生成 `.app` 或 DMG，也不是 `v0.1.0` 的完成条件；代码继续通过平台接口隔离操作系统能力，为未来移植保留源码层兼容性。

每次发布必须附：测试报告、已知限制、签名状态、数据迁移版本和备份兼容范围。
