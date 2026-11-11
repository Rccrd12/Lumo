// The agent's side: lumo-hook.exe run exactly as Claude Code runs it, the
// event JSON on stdin and the reply read from stdout.

import { spawn } from "node:child_process";

export function runHook(exe, payload, { args = [], env = process.env, cwd } = {}) {
  const t0 = Date.now();
  const p = spawn(exe, args, { stdio: ["pipe", "pipe", "pipe"], env, cwd });
  let stdout = "";
  let stderr = "";
  p.stdout.on("data", (d) => (stdout += d));
  p.stderr.on("data", (d) => (stderr += d));
  const run = { settled: false, process: p };
  run.done = new Promise((resolve) => {
    p.on("close", (code) => {
      run.settled = true;
      resolve({ code, stdout, stderr, ms: Date.now() - t0 });
    });
  });
  /** The reply, or an error after `ms`. */
  run.result = (ms = 10_000) =>
    Promise.race([
      run.done,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`lumo-hook still waiting after ${ms} ms`)), ms)),
    ]);
  run.kill = () => {
    if (!run.settled) p.kill();
  };
  p.stdin.end(JSON.stringify(payload));
  return run;
}

/** What Claude Code was told: "allow", "deny", or null for no decision. */
export function behavior(reply) {
  const line = reply.stdout.trim();
  if (!line) return null;
  try {
    return JSON.parse(line)?.hookSpecificOutput?.decision?.behavior ?? null;
  } catch {
    return null;
  }
}

/** The answers a question card handed back, if any. */
export function answers(reply) {
  try {
    return JSON.parse(reply.stdout.trim())?.hookSpecificOutput?.decision?.updatedInput?.answers ?? null;
  } catch {
    return null;
  }
}
