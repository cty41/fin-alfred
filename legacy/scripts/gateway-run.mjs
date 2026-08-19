import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const cargoCandidate = join(process.env.USERPROFILE ?? "", ".cargo", "bin", "cargo.exe");
const cargo = process.platform === "win32" && existsSync(cargoCandidate) ? cargoCandidate : "cargo";
process.env.UV_DEFAULT_INDEX = "https://pypi.org/simple";
const uvCheck = spawnSync("uv", ["sync", "--frozen", "--project", "data-provider"], { stdio: "inherit" });
if (uvCheck.status !== 0) throw new Error("AKShare 环境初始化失败。请安装 uv 后重试。");
process.env.FIN_ALFRED_PROJECT_ROOT = process.cwd();
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
