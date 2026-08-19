# 发布验收

当前阶段通过 PowerShell 引导脚本从确定 Git 提交构建 Windows 本地 Gateway，不生成原生安装程序或 npm 包。CI 运行前端、浏览器 E2E、Rust 门禁和一键源码安装测试。

本地功能验收命令：

```powershell
npm run gateway:run
```

当前 CI 和功能验收仅覆盖 Windows PC。预编译二进制分发、签名、SBOM和正式 Release 均延期到 Gateway 功能等价之后。一键脚本只删除程序目录，用户档案和凭据不属于卸载范围。

功能验证记录必须附：测试报告、已知限制、数据迁移版本和备份兼容范围。
