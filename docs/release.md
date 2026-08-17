# 发布验收

当前阶段只验证从源码运行的 Windows 本地 Gateway，不生成安装程序或 npm 包。CI 运行前端、浏览器 E2E、Rust 门禁和 Gateway 构建。

本地功能验收命令：

```powershell
pnpm gateway:run
```

当前 CI 和功能验收仅覆盖 Windows PC。npm 全局安装、二进制分发、签名、SBOM和正式 Release 均延期到 Gateway 功能等价之后。

功能验证记录必须附：测试报告、已知限制、数据迁移版本和备份兼容范围。
