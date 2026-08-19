import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Decimal, d, StagedStrategy, type StrategyStage, type MarketContext } from "@fin-alfred/core";
import * as db from "./db.js";
import { AkshareProvider } from "@fin-alfred/provider-akshare";

export interface CommandResult {
  ok: boolean;
  message: string;
  data?: unknown;
  table?: { headers: string[]; rows: string[][] };
}

const HELP_TEXT = `fin-alfred — 价值投资助手 (无 LLM 确定性内核)

可用命令:
  guide                    首次使用引导
  watchlist add <id> <symbol> <name>   添加自选
  watchlist remove <id>    移除自选
  watchlist list           查看自选列表
  quote <id>               查看最新价格(缓存)
  position <id>            持仓状态
  trade log <id> sell <date> <qty> <price> [stamp] [clear] [transfer] [comm]
                           记录真实成交(幂等)
  strategy status <id>     策略状态评估
  session list             会话列表

输入 help <command> 查看具体用法。`;

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




