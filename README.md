# fin-alfred

本地优先的确定性价值投资助手。以会话为中心，支持 CLI REPL 和 Web 会话页；可选接入本机 Ollama，提供只读对话并将数据请求翻译为严格白名单内的只读命令。

## 架构 (v2)

```
packages/
  core/               纯 TS 领域层：Decimal、账本(幂等)、决策、策略引擎、李录&Burry 评分、DCF
  provider-akshare/   AKShare Python 适配器桥接（行情数据源，可插拔）
  provider-llm/       可选 Ollama 适配器（结构化只读意图翻译）
  gateway/            本地 HTTP 服务 (127.0.0.1:43117) + SQLite 存储 + 命令执行器
  cli/                alfred 命令行 + REPL
  ui/                 Web 会话页（单文件 HTML，gateway 托管）
data-provider/        锁定版本的 AKShare Python 适配器
legacy/               v1 Rust+React 原型（归档，保留至迁移验收）
scripts/              迁移工具、安装器
```

## 快速开始

```powershell
npm install
npm run build
npm run alfred        # CLI REPL
```

启动 Gateway：

```powershell
fin-alfred gateway
# 源码目录内也可使用：npm run gateway
```

Gateway 运行后打开控制界面：

```powershell
fin-alfred dashboard
# 只显示地址，不打开浏览器：fin-alfred dashboard --no-open
# 源码目录内也可使用：npm run dashboard
```

### 可选：启用本地模型

默认不启用 LLM，所有确定性命令无需 Ollama 即可使用。安装 Ollama 并下载 `qwen3.5:2b` 后，在
`%LOCALAPPDATA%\fin-alfred\llm-config.json` 写入：

```json
{
  "provider": "ollama",
  "enabled": true,
  "model": "qwen3.5:2b",
  "baseUrl": "http://127.0.0.1:11434",
  "timeoutMs": 60000
}
```

重新启动 CLI 或 Gateway 后，可以正常问候、询问投资概念，也可用自然语言查询自选股、报价、摘要、DCF、筛选和策略状态。普通对话不会联网或读取未提供的数据；自然语言不能执行交易、修改持仓、创建策略或导入数据，这些操作仍只接受用户直接输入的确定性命令。

## 命令

```
help / guide                    引导
watchlist add|remove|list       自选管理
quote <id> [--refresh]          价格（AKShare）
position <id> / position set    持仓
trade log <id> buy|sell ...     记录真实成交（幂等 execution_key）
strategy new <id> <baseline> --preset xiaomi | --file <json>
strategy status <id>            策略评估（确定性）
migrate import <export.json>    导入旧数据
session list                    会话列表
```

## 核心设计原则

- **确定性**：同一输入永远给同一结论；每次建议带 decision_key 存档。
- **幂等账本**：execution_key 去重，重复录入不重复入账。
- **建议与执行分离**：策略引擎只给建议，`trade log` 才改账本。
- **LLM 不是控制器**：本地模型提供只读解释并翻译只读意图；确定性命令、参数白名单和账本边界由代码执行。
- **本地优先**：所有数据存 `%LOCALAPPDATA%\fin-alfred\alfred.db`（明文 SQLite）。

## 测试

```powershell
npm test              # vitest: core + gateway 集成
npm run typecheck     # tsc -b
```

## 迁移

从 v1 Rust 版迁移（含小米真实成交）：

```powershell
node scripts/migrate-export.mjs
node packages/cli/dist/main.js   # 然后: migrate import <export.json>
```

## License

Apache-2.0
