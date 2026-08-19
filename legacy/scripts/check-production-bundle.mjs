import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const banned = ["mock-stage-2-decision", "mock-manual-execution", "浏览器示例模式不能访问真实档案文件"];
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]))).flat();
}
for (const path of await files(fileURLToPath(new URL("../dist", import.meta.url)))) {
  const body = await readFile(path);
  const text = body.toString("utf8");
  const marker = banned.find((candidate) => text.includes(candidate));
  if (marker) throw new Error(`production bundle contains mock marker ${marker} in ${path}`);
}
console.log("production bundle mock scan passed");
