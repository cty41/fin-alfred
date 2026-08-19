import http from "node:http";
import { randomUUID } from "node:crypto";
import { openDatabase, createSession, addSessionMessage, getSessionMessages, listSessions } from "./db.js";
import { executeCommand } from "./engine.js";
import { AgentSession, agentResultToCommandResult } from "./agent.js";

const PORT = Number(process.env.ALFRED_PORT ?? 43117);
const HOST = "127.0.0.1";

const db = openDatabase();
const agent = new AgentSession(db);

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  const p = url.pathname;

  // CORS for local dev
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (p === "/health") {
      return json(res, 200, { ok: true, service: "fin-alfred-gateway" });
    }

    // Serve UI
    if (p === "/" || p === "/index.html") {
      const { readFileSync, existsSync } = await import("node:fs");
      const { join, dirname } = await import("node:path");
      const uiPath = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "..", "..", "ui", "src", "index.html");
      if (existsSync(uiPath)) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(readFileSync(uiPath, "utf-8"));
      } else {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("UI not found");
      }
      return;
    }

    if (p === "/api/v1/exec" && req.method === "POST") {
      const body = await readBody(req);
      const sessionId = body.sessionId as string | undefined;
      const command = body.command as string ?? "";
      const result = executeCommand(db, command);
      if (sessionId) {
        addSessionMessage(db, sessionId, "user", command);
        addSessionMessage(db, sessionId, "alfred", result.message);
      }
      return json(res, 200, result);
    }

    if (p === "/api/v1/chat" && req.method === "POST") {
      const body = await readBody(req);
      const sessionId = body.sessionId as string | undefined;
      const input = String(body.input ?? body.command ?? "");
      const result = agentResultToCommandResult(await agent.process(input));
      if (sessionId) {
        addSessionMessage(db, sessionId, "user", input);
        addSessionMessage(db, sessionId, "alfred", result.message);
      }
      return json(res, 200, result);
    }

    if (p === "/api/v1/sessions" && req.method === "GET") {
      return json(res, 200, { sessions: listSessions(db) });
    }

    if (p === "/api/v1/sessions" && req.method === "POST") {
      const body = await readBody(req);
      const id = (body.id as string) ?? randomUUID();
      const title = (body.title as string) ?? "";
      createSession(db, id, title);
      return json(res, 200, { id });
    }

    if (p.startsWith("/api/v1/sessions/") && p.endsWith("/messages") && req.method === "GET") {
      const sessionId = p.split("/")[3];
      return json(res, 200, { messages: getSessionMessages(db, sessionId) });
    }

    return json(res, 404, { ok: false, message: "not found" });
  } catch (err: any) {
    return json(res, 500, { ok: false, message: err?.message ?? "internal error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`fin-alfred gateway listening on http://${HOST}:${PORT}`);
});

