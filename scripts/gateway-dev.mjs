import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const children = [];
let stopping = false;

function start(command, args, shell = false) {
  const child = spawn(command, args, { stdio: "inherit", shell });
  children.push(child);
  child.on("exit", (code) => {
    if (!stopping) stop(code ?? 1);
  });
  return child;
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 250);
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const cargoCandidate = join(process.env.USERPROFILE ?? "", ".cargo", "bin", "cargo.exe");
const cargo = process.platform === "win32" && existsSync(cargoCandidate) ? cargoCandidate : "cargo";

start(pnpm, ["vite", "--mode", "gateway", "--config", "vite.gateway.config.ts"], process.platform === "win32");
setTimeout(() => {
  if (!stopping) {
    const args = ["run", "-p", "fin-alfred-gateway", "--", "--ui-url", "http://127.0.0.1:1420"];
    if (process.env.FIN_ALFRED_NO_OPEN === "1") args.push("--no-open");
    start(cargo, args);
  }
}, 1200);
