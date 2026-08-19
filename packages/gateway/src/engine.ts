import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Decimal, d, StagedStrategy, type StrategyStage, type MarketContext, runDcf, evaluate as evaluateAssessment, scoreTrack, qualityBand, htmlReport, sparkline, type ValueAssessment, type DcfInput } from "@fin-alfred/core";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { exec } from "node:child_process";
import * as db from "./db.js";
import { AkshareProvider } from "@fin-alfred/provider-akshare";

export interface CommandResult {
  ok: boolean;
  message: string;
  data?: unknown;
  table?: { headers: string[]; rows: string[][] };
}

const HELP_TEXT = `fin-alfred — 确定性价值投资助手 (无 LLM 内核)

数据管理:
  watchlist add|remove|list          自选列表
  quote <id> [--refresh]             价格 (AKShare)
  position <id> / position set <id> <qty> <cash>
  financials <id> show|add ...       年度财务数据

分析:
  dcf <id>                           Bear/Base/Bull DCF 估值
  summary <id>                       首屏摘要 (持仓+价格+策略状态)
  screen lilu|burry                  选股评分模板 (李录/Burry)

策略与交易:
  strategy new <id> <baseline> --preset xiaomi | --file <json>
  strategy status <id>               确定性策略评估
  trade log <id> buy|sell <date> <qty> <price> [fees...]
                                     记录真实成交 (幂等)

报告与迁移:
  report <id>|watchlist [--term]     生成 HTML 报告或终端输出
  migrate import <export.json>       导入旧版数据
  session list                       会话列表

输入 help 显示本帮助。`;

export function executeCommand(dbConn: DatabaseSync, input: string): CommandResult {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

  switch (cmd) {
    case "help":
    case "guide":
      return { ok: true, message: HELP_TEXT };

    case "watchlist": {
      const sub = parts[1]?.toLowerCase();
      if (sub === "add") {
        const [instrumentId, symbol, ...nameParts] = parts.slice(2);
        if (!instrumentId || !symbol) return { ok: false, message: "用法: watchlist add <instrument_id> <symbol> <name>" };
        const name = nameParts.join(" ") || symbol;
        db.watchlistAdd(dbConn, instrumentId, symbol, name);
        return { ok: true, message: `已添加 ${name} (${instrumentId}) 到自选列表` };
      }
      if (sub === "remove") {
        db.watchlistRemove(dbConn, parts[2] ?? "");
        return { ok: true, message: `已从自选列表移除 ${parts[2]}` };
      }
      if (sub === "list") {
        const items = db.watchlistList(dbConn);
        if (items.length === 0) return { ok: true, message: "自选列表为空。用 watchlist add <id> <symbol> <name> 添加。" };
        return {
          ok: true,
          message: `自选列表 (${items.length} 项):`,
          table: {
            headers: ["代码", "名称", "币种"],
            rows: items.map((i) => [i.instrumentId, i.name, i.currency]),
          },
        };
      }
      return { ok: false, message: "用法: watchlist add|remove|list ..." };
    }

    case "quote": {
      const instrumentId = parts[1];
      if (!instrumentId) return { ok: false, message: "用法: quote <instrument_id> [--refresh]" };
      const refresh = parts.includes("--refresh");
      if (refresh) {
        return { ok: true, message: `正在获取 ${instrumentId} 实时行情...`, data: { async: "quote", instrumentId } };
      }
      const cached = db.getLatestPrice(dbConn, instrumentId);
      if (!cached) return { ok: true, message: `${instrumentId} 暂无价格缓存。运行 quote <id> --refresh 获取。` };
      return {
        ok: true,
        message: `${instrumentId} 最新价: ${cached.price} (来源: ${cached.source}, 时间: ${cached.observedAt})`,
        data: cached,
      };
    }

    case "position": {
      const instrumentId = parts[1];
      if (!instrumentId) return { ok: false, message: "用法: position <instrument_id> | position set <instrument_id> <qty> <cash>" };
      if (parts[1] === "set") {
        const id = parts[2];
        const qty = parts[3];
        const cash = parts[4] ?? "0";
        if (!id || !qty) return { ok: false, message: "用法: position set <instrument_id> <qty> [cash]" };
        db.getOrCreatePosition(dbConn, "default", id, qty, cash);
        db.updatePosition(dbConn, "default", id, qty, cash);
        return { ok: true, message: `已设置 ${id} 初始持仓: ${qty} 股, 现金: ${cash}` };
      }
      const pos = db.getOrCreatePosition(dbConn, "default", instrumentId);
      return {
        ok: true,
        message: `${instrumentId} 持仓: ${pos.quantity} 股, 现金: ${pos.cash}`,
        data: pos,
      };
    }

    case "trade": {
      if (parts[1] === "log") {
        const [instrumentId, side, date, qty, price, ...feeParts] = parts.slice(2);
        if (!instrumentId || !side || !date || !qty || !price) {
          return { ok: false, message: "用法: trade log <id> buy|sell <date> <qty> <price> [stamp] [clearing] [transfer] [commission]" };
        }
        const fees = {
          stampDuty: feeParts[0] ?? "0",
          clearingFee: feeParts[1] ?? "0",
          transferFee: feeParts[2] ?? "0",
          commission: feeParts[3] ?? "0",
        };
        const result = db.recordExecution(dbConn, "default", instrumentId, side, date, qty, price, fees, null);
        if (result === "duplicate") {
          return { ok: true, message: `该成交已记录(幂等去重)，不重复入账。` };
        }
        // Update position
        const pos = db.getOrCreatePosition(dbConn, "default", instrumentId);
        let newQty = d(pos.quantity);
        let newCash = d(pos.cash);
        const q = d(qty);
        const p = d(price);
        const totalFees = d(fees.stampDuty).add(d(fees.clearingFee)).add(d(fees.transferFee)).add(d(fees.commission));
        if (side === "sell") {
          if (q.gt(newQty)) {
            return { ok: false, message: `卖出数量 ${qty} 超过当前持仓 ${newQty.toString()}，拒绝入账。` };
          }
          newQty = newQty.sub(q);
          newCash = newCash.add(q.mul(p).sub(totalFees));
        } else {
          newQty = newQty.add(q);
          newCash = newCash.sub(q.mul(p).add(totalFees));
        }
        db.updatePosition(dbConn, "default", instrumentId, newQty.toString(), newCash.toString());
        return {
          ok: true,
          message: `成交已记录: ${side} ${qty} ${instrumentId} @ ${price}\n持仓更新: ${newQty.toString()} 股, 现金: ${newCash.toString()}`,
        };
      }
      return { ok: false, message: "用法: trade log ..." };
    }

    case "strategy": {
      if (parts[1] === "status") {
        const instrumentId = parts[2];
        if (!instrumentId) return { ok: false, message: "用法: strategy status <instrument_id>" };
        const strat = db.getActiveStrategy(dbConn, instrumentId);
        if (!strat) return { ok: true, message: `${instrumentId} 暂无活跃策略。用 strategy new 创建。` };
        const rawStages = JSON.parse(strat.stages_json) as any[];
        const stages: StrategyStage[] = rawStages.map((s: any) => ({
          ...s,
          cumulativeTarget: d(s.cumulativeTarget),
          zones: s.zones.map((z: any) => ({ low: d(z.low), high: d(z.high) })),
        }));
        const strategy = new StagedStrategy(instrumentId, d(strat.baseline_quantity), stages);
        const pos = db.getOrCreatePosition(dbConn, "default", instrumentId);
        const cumulativeSold = d(strat.baseline_quantity).sub(d(pos.quantity));
        const price = db.getLatestPrice(dbConn, instrumentId);
        const market: MarketContext = {
          price: price ? d(price.price) : d("0"),
          dailyCloses: price ? [d(price.price)] : [],
          asOf: new Date().toISOString().slice(0, 10),
        };
        const outcome = strategy.evaluate(market, cumulativeSold);
        if (outcome.outcome === "wait") {
          return {
            ok: true,
            message: `策略状态: 等待\n原因: ${outcome.reasonCode}\n${outcome.detail ?? ""}\n缺失检查:\n${outcome.missingChecks.map((c) => `  - ${c}`).join("\n") || "  (无)"}`,
            data: outcome,
          };
        }
        if (outcome.outcome === "propose_sell") {
          return {
            ok: true,
            message: `策略建议: Stage ${outcome.stage} 可执行\n卖出数量: ${outcome.quantity.toString()} 股\n执行区: ${outcome.zone.low.toString()}–${outcome.zone.high.toString()}\n原因: ${outcome.reasonCode}`,
            data: outcome,
          };
        }
        return { ok: true, message: `策略状态: ${outcome.outcome}`, data: outcome };
      }
      if (parts[1] === "new") {
        const instrumentId = parts[2];
        const baseline = parts[3];
        if (!instrumentId || !baseline) {
          return { ok: false, message: "用法: strategy new <instrument_id> <baseline_qty> [--file <stages.json>]\n或: strategy new <instrument_id> <baseline_qty> --preset xiaomi" };
        }
        const fileIdx = parts.indexOf("--file");
        if (fileIdx !== -1 && parts[fileIdx + 1]) {
          try {
            const stagesJson = readFileSync(parts[fileIdx + 1], "utf-8");
            JSON.parse(stagesJson); // validate
            const id = db.saveStrategy(dbConn, instrumentId, "reduce", baseline, stagesJson);
            return { ok: true, message: `策略已创建 (id=${id}): ${instrumentId}, 基准 ${baseline} 股` };
          } catch (e: any) {
            return { ok: false, message: `策略文件读取失败: ${e.message}` };
          }
        }
        if (parts.includes("--preset") && parts[parts.indexOf("--preset") + 1] === "xiaomi") {
          const stages = [
            { stage: 1, cumulativeTarget: d(baseline).mul(d("0.05")).toString(), zones: [{ low: "0", high: "99999" }], confirmations: [], rationale: "Unconditional insurance" },
            { stage: 2, cumulativeTarget: d(baseline).mul(d("0.10")).toString(), zones: [{ low: "28.8", high: "29.3" }], confirmations: [{ kind: "consecutive_closes_above_zone_low", count: 2 }], rationale: "Concentration management" },
            { stage: 3, cumulativeTarget: d(baseline).mul(d("0.15")).toString(), zones: [{ low: "31", high: "32" }], confirmations: [], catalysts: [{ id: "ev_orders", label: "New model orders", dueDate: "2026-09-08", confirmed: false, blocking: true }], rationale: "Post-results zone" },
            { stage: 4, cumulativeTarget: d(baseline).mul(d("0.20")).toString(), zones: [{ low: "35", high: "99999" }], confirmations: [], rationale: "Comprehensive risk zone" },
          ];
          const id = db.saveStrategy(dbConn, instrumentId, "reduce", baseline, JSON.stringify(stages));
          return { ok: true, message: `小米式四阶段减仓策略已创建 (id=${id}): ${instrumentId}, 基准 ${baseline} 股` };
        }
        return { ok: false, message: "用法: strategy new <id> <baseline> --file <json> | --preset xiaomi" };
      }
      return { ok: false, message: "用法: strategy status|new ..." };
    }

    case "financials": {
      const instrumentId = parts[1];
      if (!instrumentId) return { ok: false, message: "用法: financials <id> show | financials <id> add <year> <currency> <revenue> <netIncome> <cash> <debt> <equity> <ocf> <capex> [sourceUrl]" };
      const sub = parts[2]?.toLowerCase();
      if (sub === "show") {
        const fins = db.getFinancials(dbConn, instrumentId);
        if (fins.length === 0) return { ok: true, message: `${instrumentId} 暂无财务数据。` };
        return {
          ok: true,
          message: `${instrumentId} 年度财务数据 (${fins.length} 年):`,
          table: {
            headers: ["年份", "收入", "净利润", "现金", "负债", "OCF", "CapEx"],
            rows: fins.map((f: any) => [f.year, f.revenue, f.net_income, f.cash, f.debt, f.operating_cash_flow, f.capex]),
          },
        };
      }
      if (sub === "add") {
        const [year, currency, revenue, netIncome, cash, debt, equity, ocf, capex, sourceUrl] = parts.slice(3);
        if (!year || !revenue) return { ok: false, message: "用法: financials <id> add <year> <currency> <revenue> <netIncome> <cash> <debt> <equity> <ocf> <capex> [sourceUrl]" };
        db.upsertFinancials(dbConn, { instrumentId, year: Number(year), currency: currency ?? "HKD", revenue, netIncome: netIncome ?? "0", cash: cash ?? "0", debt: debt ?? "0", equity: equity ?? "0", operatingCashFlow: ocf ?? "0", capex: capex ?? "0", sourceUrl: sourceUrl ?? "" });
        return { ok: true, message: `已录入 ${instrumentId} ${year} 年财务数据` };
      }
      return { ok: false, message: "用法: financials <id> show|add ..." };
    }

    case "dcf": {
      const instrumentId = parts[1];
      if (!instrumentId) return { ok: false, message: "用法: dcf <instrument_id>" };
      const fins = db.getFinancials(dbConn, instrumentId);
      if (fins.length === 0) return { ok: false, message: `${instrumentId} 无财务数据，请先用 financials <id> add 录入至少一年数据。` };
      const latest = fins[0] as any;
      const revenue = d(latest.revenue);
      const netMargin = revenue.isZero() ? Decimal.zero() : d(latest.net_income).div(revenue);
      const shares = d(latest.diluted_shares ?? "25000000000"); // default Xiaomi diluted shares
      const input: DcfInput = {
        instrumentId,
        startingRevenue: revenue,
        startingNetMargin: netMargin,
        dilutedShares: shares,
        forecastYears: 5,
        bear: { revenueGrowth: d("-0.05"), endingNetMargin: netMargin.mul(d("0.7")), cashConversion: d("0.8"), discountRate: d("0.12"), exitPe: d("12") },
        base: { revenueGrowth: d("0.08"), endingNetMargin: netMargin.mul(d("1.0")), cashConversion: d("0.9"), discountRate: d("0.10"), exitPe: d("18") },
        bull: { revenueGrowth: d("0.15"), endingNetMargin: netMargin.mul(d("1.3")), cashConversion: d("1.0"), discountRate: d("0.09"), exitPe: d("25") },
        asOf: new Date().toISOString().slice(0, 10),
      };
      const result = runDcf(input);
      return {
        ok: true,
        message: `${instrumentId} DCF 估值 (5年 FCFE Proxy):\n  Bear: ${result.bear.valuePerShare.toFixed(2)}\n  Base: ${result.base.valuePerShare.toFixed(2)}\n  Bull: ${result.bull.valuePerShare.toFixed(2)}\n  终端价值占比(Base): ${(result.base.terminalValueShare.mul(d("100"))).toFixed(1)}%`,
        data: { bear: result.bear.valuePerShare.toString(), base: result.base.valuePerShare.toString(), bull: result.bull.valuePerShare.toString() },
      };
    }

    case "summary": {
      const instrumentId = parts[1];
      if (!instrumentId) return { ok: false, message: "用法: summary <instrument_id>" };
      const pos = db.getOrCreatePosition(dbConn, "default", instrumentId);
      const price = db.getLatestPrice(dbConn, instrumentId);
      const strat = db.getActiveStrategy(dbConn, instrumentId);
      const lines: string[] = [`${instrumentId} Summary`];
      lines.push(`持仓: ${pos.quantity} 股 | 现金: ${pos.cash}`);
      lines.push(price ? `最新价: ${price.price} (${price.observedAt})` : "最新价: 无缓存 (quote <id> --refresh)");
      if (strat) {
        const rawStages = JSON.parse(strat.stages_json) as any[];
        const stages: StrategyStage[] = rawStages.map((s: any) => ({ ...s, cumulativeTarget: d(s.cumulativeTarget), zones: s.zones.map((z: any) => ({ low: d(z.low), high: d(z.high) })) }));
        const strategy = new StagedStrategy(instrumentId, d(strat.baseline_quantity), stages);
        const cumulativeSold = d(strat.baseline_quantity).sub(d(pos.quantity));
        const market: MarketContext = { price: price ? d(price.price) : d("0"), dailyCloses: price ? [d(price.price)] : [], asOf: new Date().toISOString().slice(0, 10) };
        const outcome = strategy.evaluate(market, cumulativeSold);
        if (outcome.outcome === "propose_sell") {
          lines.push(`策略: Stage ${outcome.stage} 可执行, 卖出 ${outcome.quantity.toString()} 股`);
        } else if (outcome.outcome === "wait") {
          lines.push(`策略: 等待 (${outcome.reasonCode})`);
        } else if (outcome.outcome === "completed") {
          lines.push("策略: 全部阶段已完成");
        }
      } else {
        lines.push("策略: 未配置");
      }
      return { ok: true, message: lines.join("\n") };
    }

    case "screen": {
      const method = parts[1]?.toLowerCase();
      if (!method || !["lilu", "burry"].includes(method)) {
        return { ok: false, message: "用法: screen lilu|burry [instrument_id]\n评分为手工录入，此命令展示评分模板。" };
      }
      const template = method === "lilu"
        ? "李录选股清单 (权重):\n  护城河 moat: 25% (关键)\n  增量 ROIC: 25% (关键)\n  现金转化: 15%\n  管理层配置: 15% (关键)\n  资产负债表: 10% (关键)\n  成长空间: 10%"
        : "Burry 选股清单 (权重):\n  估值折价: 25% (关键)\n  Bear 保护: 25% (关键)\n  资产负债表: 15% (关键)\n  正常化 FCF: 15% (关键)\n  预期差: 10%\n  催化剂: 10%";
      return { ok: true, message: template };
    }

    case "report": {
      const target = parts[1];
      if (!target) return { ok: false, message: "用法: report <instrument_id>|watchlist [--term]" };
      const termOnly = parts.includes("--term");
      if (target === "watchlist") {
        const items = db.watchlistList(dbConn);
        const sections = items.map((item) => {
          const pos = db.getOrCreatePosition(dbConn, "default", item.instrumentId);
          const price = db.getLatestPrice(dbConn, item.instrumentId);
          return {
            heading: `${item.name} (${item.instrumentId})`,
            text: `持仓: ${pos.quantity} 股\n现金: ${pos.cash}\n最新价: ${price?.price ?? "无"}`,
          };
        });
        const html = htmlReport("fin-alfred Watchlist 报告", sections);
        if (termOnly) {
          return { ok: true, message: sections.map((s) => `${s.heading}\n${s.text}`).join("\n\n") };
        }
        const outDir = join(process.env.LOCALAPPDATA ?? ".", "fin-alfred", "reports");
        mkdirSync(outDir, { recursive: true });
        const outPath = join(outDir, `watchlist-${new Date().toISOString().slice(0, 10)}.html`);
        writeFileSync(outPath, html, "utf-8");
        exec(`start "" "${outPath}"`);
        return { ok: true, message: `报告已生成并打开: ${outPath}` };
      }
      // Single instrument report
      const instrumentId = target;
      const pos = db.getOrCreatePosition(dbConn, "default", instrumentId);
      const price = db.getLatestPrice(dbConn, instrumentId);
      const strat = db.getActiveStrategy(dbConn, instrumentId);
      const sections: import("@fin-alfred/core").ReportSection[] = [
        { heading: "持仓", text: `数量: ${pos.quantity}\n现金: ${pos.cash}` },
        { heading: "价格", text: price ? `${price.price} (${price.observedAt}, ${price.source})` : "无缓存" },
      ];
      if (strat) {
        const rawStages = JSON.parse(strat.stages_json) as any[];
        sections.push({
          heading: "策略阶段",
          table: {
            headers: ["Stage", "累计目标", "执行区", "状态"],
            rows: rawStages.map((s: any) => [
              String(s.stage),
              s.cumulativeTarget,
              s.zones.map((z: any) => `${z.low}–${z.high}`).join(", "),
              d(s.cumulativeTarget).lte(d(strat.baseline_quantity).sub(d(pos.quantity))) ? "已完成" : "待执行",
            ]),
          },
        });
      }
      const html = htmlReport(`fin-alfred 报告: ${instrumentId}`, sections);
      if (termOnly) {
        return { ok: true, message: sections.map((s: any) => `${s.heading}: ${s.text ?? JSON.stringify(s.table)}`).join("\n") };
      }
      const outDir = join(process.env.LOCALAPPDATA ?? ".", "fin-alfred", "reports");
      mkdirSync(outDir, { recursive: true });
      const outPath = join(outDir, `${instrumentId.replace(/:/g, "-")}-${new Date().toISOString().slice(0, 10)}.html`);
      writeFileSync(outPath, html, "utf-8");
      exec(`start "" "${outPath}"`);
      return { ok: true, message: `报告已生成并打开: ${outPath}` };
    }

    case "migrate": {
      if (parts[1] === "import") {
        const filePath = parts[2];
        if (!filePath) return { ok: false, message: "用法: migrate import <export.json>" };
        try {
          const raw = readFileSync(filePath, "utf-8");
          const data = JSON.parse(raw);
          let watchlistCount = 0;
          let executionCount = 0;
          let strategyCount = 0;
          for (const item of data.watchlist ?? []) {
            db.watchlistAdd(dbConn, item.instrument_id ?? item.instrumentId, item.symbol, item.name, item.currency ?? "HKD");
            watchlistCount++;
          }
          for (const profile of data.profiles ?? []) {
            const iid = profile.instrumentId;
            db.watchlistAdd(dbConn, iid, profile.symbol, profile.name, profile.currency ?? "HKD");
            db.getOrCreatePosition(dbConn, "default", iid, profile.position.quantity, profile.position.cash);
            for (const exec of profile.executions ?? []) {
              const result = db.recordExecution(dbConn, "default", iid, exec.side, exec.tradedAt, exec.quantity, exec.price, exec.fees, exec.externalId ?? null);
              if (result === "applied") {
                const pos = db.getOrCreatePosition(dbConn, "default", iid);
                let qty = d(pos.quantity);
                let cash = d(pos.cash);
                const q = d(exec.quantity);
                const p = d(exec.price);
                const fees = d(exec.fees.stampDuty ?? "0").add(d(exec.fees.clearingFee ?? "0")).add(d(exec.fees.transferFee ?? "0")).add(d(exec.fees.commission ?? "0"));
                if (exec.side === "sell") {
                  qty = qty.sub(q);
                  cash = cash.add(q.mul(p).sub(fees));
                } else {
                  qty = qty.add(q);
                  cash = cash.sub(q.mul(p).add(fees));
                }
                db.updatePosition(dbConn, "default", iid, qty.toString(), cash.toString());
                executionCount++;
              }
            }
            if (profile.strategy) {
              db.saveStrategy(dbConn, iid, profile.strategy.side, profile.strategy.baselineQuantity, JSON.stringify(profile.strategy.stages));
              strategyCount++;
            }
          }
          return {
            ok: true,
            message: `迁移导入完成:\n  自选: ${watchlistCount} 项\n  成交: ${executionCount} 笔\n  策略: ${strategyCount} 个`,
          };
        } catch (e: any) {
          return { ok: false, message: `迁移导入失败: ${e.message}` };
        }
      }
      return { ok: false, message: "用法: migrate import <export.json>" };
    }

    case "session": {
      if (parts[1] === "list") {
        const sessions = db.listSessions(dbConn);
        return {
          ok: true,
          message: `会话列表 (${sessions.length}):`,
          table: {
            headers: ["ID", "标题", "更新时间"],
            rows: sessions.map((s: any) => [s.id.slice(0, 8), s.title, s.updated_at]),
          },
        };
      }
      return { ok: false, message: "用法: session list" };
    }

    default:
      return {
        ok: false,
        message: `未知命令: "${cmd}"。输入 help 查看可用命令。`,
      };
  }
}







