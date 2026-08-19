import { spawn, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

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

const npmCli = process.env.npm_execpath;
const cargoCandidate = join(process.env.USERPROFILE ?? "", ".cargo", "bin", "cargo.exe");
const cargo = process.platform === "win32" && existsSync(cargoCandidate) ? cargoCandidate : "cargo";
const projectRoot = process.cwd();
if (process.env.FIN_ALFRED_RESET_TEST_DATA === "1") {
  const testDataDirectory = process.env.FIN_ALFRED_TEST_DATA_DIR;
  const expectedDirectory = resolve(projectRoot, "target", "gateway-e2e-data");
  if (!testDataDirectory || resolve(projectRoot, testDataDirectory) !== expectedDirectory) {
    throw new Error("FIN_ALFRED_RESET_TEST_DATA 只允许清理 target/gateway-e2e-data。");
  }
  rmSync(expectedDirectory, { recursive: true, force: true });
}
process.env.UV_DEFAULT_INDEX = "https://pypi.org/simple";
const uvCheck = spawnSync("uv", ["sync", "--frozen", "--project", "data-provider"], { stdio: "inherit" });
if (uvCheck.status !== 0) {
  throw new Error("AKShare 环境初始化失败。请安装 uv 后重试：https://docs.astral.sh/uv/");
}
process.env.FIN_ALFRED_PROJECT_ROOT = projectRoot;

if (!npmCli) throw new Error("无法定位 npm CLI；请通过 npm run gateway:dev 启动。");
start(process.execPath, [npmCli, "run", "gateway:ui"]);
setTimeout(() => {
  if (!stopping) {
    const args = ["run", "-p", "fin-alfred-gateway", "--", "--ui-url", "http://127.0.0.1:1420"];
    if (process.env.FIN_ALFRED_NO_OPEN === "1") args.push("--no-open");
    start(cargo, args);
  }
}, 1200);
