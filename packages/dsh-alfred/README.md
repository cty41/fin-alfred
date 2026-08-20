# dsh-alfred

最小 DeepSeek Harness 港股投研插件原型。当前只支持：

- `HKEX:1810` 小米集团-W
- `HKEX:0700` 腾讯控股
- `HKEX:9988` 阿里巴巴-W

插件提供行情、估值/基本面、持仓上下文、动态价值策略，以及经过“预览 → 下一轮明确确认”的真实成交/初始持仓登记。它不连接券商、不自动下单，也不提供 Shell、文件编辑或模型 Provider。

## 在 DSH 中使用

安装后运行 preset 安装脚本：

```powershell
powershell -ExecutionPolicy Bypass -File D:/codes/fins-wts/dsh-alfred/packages/dsh-alfred/scripts/install-preset.ps1
```

重启 DSH Web，新建会话时选择 `alfred`。空白 Alfred 会话会显示使用指引；点击示例只会填入输入框，不会自动发送。可直接输入：

- `分析腾讯现在是否值得建仓`
- `比较腾讯和阿里巴巴的安全边际`
- `查看我的小米仓位和后续减仓条件`

Alfred Skill 会要求模型先查工具、标注数据日期，并区分事实、假设、计算和策略草案。腾讯和阿里在没有账本记录时按无持仓研究，不虚构成本价。

真实成交只用于登记已经在券商发生的结果。例如输入“我已经于2026-08-20卖出1000股小米，均价30港元”，Alfred 会先显示完整预览并停止；只有你在下一轮明确确认，才会调用 commit 工具写入本地账本。

## 开发配置

模型由 DeepSeek Harness 配置。插件只需要明确配置 Alfred 的 AKShare Python 适配器：

```yaml
- id: dsh-alfred
  config:
    pythonPath: D:/codes/fins/data-provider/.venv/Scripts/python.exe
    adapterPath: D:/codes/fins/data-provider/akshare_adapter.py
    dbPath: C:/Users/<user>/AppData/Local/fin-alfred/alfred.db
    timeoutMs: 30000
    confirmationTtlMs: 600000
```

也可以使用环境变量 `FIN_ALFRED_PYTHON_PATH`、`FIN_ALFRED_AKSHARE_ADAPTER` 和 `FIN_ALFRED_DB_PATH`。

## 本地验证

在 fin-alfred worktree 中：

```powershell
npm install
npm test
npm run build
```

## 集成到本地 DSH

当前原型与本机 DeepSeek Harness `0.1.0-rc.7` 对齐。先构建，再把同一个本地 checkout 链接到需要的 profile：

```powershell
npm run build
npx --yes @deepseek-ai/dsh plugin --profile web add link:D:/codes/fins-wts/dsh-alfred/packages/dsh-alfred
npx --yes @deepseek-ai/dsh plugin --profile headless add link:D:/codes/fins-wts/dsh-alfred/packages/dsh-alfred
```

在 `C:/Users/<user>/.dsh/profiles/web/cordis.patch.yml` 中配置本机路径：

```yaml
- id: dsh-alfred
  config:
    pythonPath: D:/codes/fins/data-provider/.venv/Scripts/python.exe
    adapterPath: D:/codes/fins/data-provider/akshare_adapter.py
    dbPath: C:/Users/<user>/AppData/Local/fin-alfred/alfred.db
    timeoutMs: 30000
```

若也使用 headless profile，将相同配置写入 `C:/Users/<user>/.dsh/profiles/headless/cordis.patch.yml`。模型继续在 DSH 的 Models 页面或 profile overlay 中配置，插件本身不保存模型或密钥。启动 Web：

```powershell
npx --yes @deepseek-ai/dsh web --port 3091
```

打开页面后选择 `alfred` preset，再用“查询 HKEX:1810 当前行情”验证 `alfred_stock_quote`。修改插件源码后执行 `npm run build` 并重启 DSH；link 安装不需要重复复制包。若修改了 preset 文件，再运行一次 `install-preset.ps1`。

注册的工具包括：

- `alfred_stock_quote`、`alfred_stock_fundamentals`、`alfred_portfolio_context`
- `alfred_value_strategy`
- `alfred_prepare_execution`、`alfred_commit_execution`
- `alfred_prepare_initial_position`、`alfred_commit_initial_position`

确认令牌默认十分钟过期、绑定当前 DSH 会话且只能使用一次。成交与持仓更新位于同一 SQLite 事务；校验失败不会留下半笔成交。

AKShare 上游公开接口可能失败；工具会返回 `source`、`observedAt`、`degraded` 或结构化错误，不会伪造行情。
