# 发布验收

Windows 发布流水线先运行前端、浏览器E2E和 Rust 门禁，再生成 NSIS、执行隔离安装/启动/卸载/数据保留测试，并生成 SHA-256、SPDX SBOM、Rust与前端第三方许可证清单。Release 默认是草稿，人工确认签名状态和干净机验收后才发布。

本地包验收命令：

```powershell
./scripts/Test-WindowsPackage.ps1 -InstallerPath './target/release/bundle/nsis/Margin Safety_0.1.0_x64-setup.exe'
```

macOS 流水线检查Apple Silicon与Intel两个领域核心目标，并在runner原生架构编译前端和Tauri应用；不上传 `.app` 或 DMG，也不声明签名、公证与普通用户安装支持。

每次发布必须附：测试报告、已知限制、签名状态、数据迁移版本和备份兼容范围。
