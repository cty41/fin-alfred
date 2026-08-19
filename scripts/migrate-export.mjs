import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const localDir = path.join(process.env.LOCALAPPDATA ?? "", "fin-alfred");
const catalogPath = path.join(localDir, "alfred.db");

function exportCatalog() {
  if (!fs.existsSync(catalogPath)) return [];
  try {
    const db = new DatabaseSync(catalogPath, { readOnly: true });
    const watchlist = db.prepare("SELECT instrument_id, symbol, name, currency FROM watchlist").all();
    db.close();
    return watchlist;
  } catch {
    return [];
  }
}

const XIAOMI_FIXTURE = {
  instrumentId: "HKEX:1810",
  symbol: "1810.HK",
  name: "Xiaomi-W",
  currency: "HKD",
  position: { quantity: "225600", cash: "87889" },
  executions: [
    {
      side: "sell",
      tradedAt: "2026-08-14",
      quantity: "12000",
      price: "25.62",
      fees: { stampDuty: "270", clearingFee: "22", transferFee: "11", commission: "26" },
    },
  ],
  strategy: {
    side: "reduce",
    baselineQuantity: "225600",
    stages: [
      { stage: 1, cumulativeTarget: "11280", zones: [{ low: "0", high: "99999" }], confirmations: [], rationale: "Unconditional insurance sale (5%)" },
      { stage: 2, cumulativeTarget: "22560", zones: [{ low: "28.8", high: "29.3" }], confirmations: [{ kind: "consecutive_closes_above_zone_low", count: 2 }], rationale: "Concentration management at July price recovery zone" },
      { stage: 3, cumulativeTarget: "33840", zones: [{ low: "31", high: "32" }], confirmations: [], catalysts: [{ id: "ev_orders", label: "Pengcheng new model orders", dueDate: "2026-09-08", confirmed: false, blocking: true }], rationale: "Post-results valuation zone" },
      { stage: 4, cumulativeTarget: "45120", zones: [{ low: "35", high: "99999" }], confirmations: [], rationale: "Comprehensive risk review zone" },
    ],
  },
};

const output = {
  exportedAt: new Date().toISOString(),
  source: "fin-alfred-legacy",
  watchlist: exportCatalog(),
  profiles: [XIAOMI_FIXTURE],
};

const outPath = process.argv[2] ?? path.join(localDir, "migration-export.json");
fs.writeFileSync(outPath, JSON.stringify(output, null, 2), "utf-8");
console.log("Migration export written to:", outPath);
console.log("Watchlist entries:", output.watchlist.length);
console.log("Profiles:", output.profiles.length);
