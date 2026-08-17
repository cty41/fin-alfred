import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const cargoCandidate = join(process.env.USERPROFILE ?? "", ".cargo", "bin", "cargo.exe");
const cargo = process.platform === "win32" && existsSync(cargoCandidate) ? cargoCandidate : "cargo";
const args = ["run", "-p", "fin-alfred-gateway", "--", "--static-dir", "dist"];
if (process.env.FIN_ALFRED_NO_OPEN === "1") args.push("--no-open");
const child = spawn(cargo, args, {
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
