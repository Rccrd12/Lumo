// An agent's MCP client: lumo-hook.exe run with --mcp, as Claude Code starts
// the island chat's `lumo` server (claude_code.rs mcp_config), one JSON-RPC
// message per line on its stdin and one answer per line on its stdout. It
// stays up for many calls, unlike runHook's one event. No dependency, and
// nothing Windows-only in it: a fake server can stand in for the relay.

import { spawn } from "node:child_process";

/**
 * Starts `exe --mcp --tools=<tools>` with `env` (the profile's), as the chat
 * `chat` would. Every call is answered, or fails after its `ms`, or fails at
 * once when the process is gone: a flow never waits on a dead relay.
 */
export function mcpClient(exe, { tools = "browser", env = process.env, chat = "e2e-browser", args = null } = {}) {
  const p = spawn(exe, args ?? ["--mcp", `--tools=${tools}`], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...env, LUMO_ISLAND_RUN: "1", LUMO_CHAT_ID: chat },
  });
  const waiting = new Map();
  let next = 0;
  let gone = null;
  let stderr = "";
  let buf = "";

  // Whole characters only: a chunk may end inside one.
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0; ) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        console.log(`    · lumo-hook --mcp wrote a line that is not JSON: ${line.slice(0, 200)}`);
        continue;
      }
      // A notification, or the answer to a call that already gave up.
      waiting.get(m.id)?.(m);
    }
  });
  p.stderr.setEncoding("utf8");
  p.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4_000)));
  // Writing to a relay that just exited: the exit below says why.
  p.stdin.on("error", () => {});

  const fail = (why) => {
    if (gone) return;
    gone = why;
    for (const done of waiting.values()) done({ error: { message: why } });
    waiting.clear();
  };
  p.on("error", (err) => fail(`lumo-hook --mcp could not run: ${err.message}`));
  // On close, not exit: by then its stderr has been read to the end, and says why.
  const exited = new Promise((resolve) => p.on("close", resolve));
  p.on("close", (code, signal) => {
    const tail = stderr.trim() ? `: ${stderr.trim().slice(-500)}` : "";
    fail(`lumo-hook --mcp exited (${signal ?? `code ${code}`})${tail}`);
  });

  /** One request: its `result`, or an error with the server's message. */
  const rpc = (method, params, ms = 30_000) =>
    new Promise((resolve, reject) => {
      if (gone) return reject(new Error(`${method}: ${gone}`));
      const id = ++next;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`${method} still waiting after ${ms} ms`));
      }, ms);
      waiting.set(id, (m) => {
        clearTimeout(timer);
        waiting.delete(id);
        if (m.error) {
          const err = new Error(`${method}: ${m.error.message ?? JSON.stringify(m.error)}`);
          err.code = m.error.code;
          reject(err);
        } else resolve(m.result);
      });
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }) + "\n");
    });

  return {
    process: p,
    rpc,
    /** The handshake Claude Code makes first: what the server answered. */
    async init(ms = 10_000) {
      const r = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "lumo-e2e", version: "1" } }, ms);
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      return r;
    },
    /** The tools the server offers. */
    async list(ms = 10_000) {
      return (await rpc("tools/list", {}, ms)).tools;
    },
    /** A tool call's result: `content` and, when it failed, `isError`. */
    call(name, args = {}, ms = 30_000) {
      return rpc("tools/call", { name, arguments: args }, ms);
    },
    /** Ends the relay as Claude Code does (stdin closed), the hard way after `ms`. */
    async close(ms = 5_000) {
      p.stdin.end();
      let timer;
      const late = new Promise((resolve) => (timer = setTimeout(() => resolve("late"), ms)));
      if ((await Promise.race([exited, late])) === "late" && p.exitCode === null && p.signalCode === null) {
        p.kill();
        await exited;
      }
      clearTimeout(timer);
    },
  };
}

/** A tool result's text, its parts joined. */
export const textOf = (r) =>
  (r?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");

/** A tool result's image, `{ data, mimeType }`, or null. */
export const imageOf = (r) => (r?.content ?? []).find((c) => c.type === "image") ?? null;
