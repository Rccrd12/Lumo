// Turns e2e-out/results.jsonl into the run's summary (GITHUB_STEP_SUMMARY on
// GitHub Actions, the terminal otherwise). Fails when a flow failed, so the
// workflow can stop on it after the summary and the screenshots are kept.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const OUT = process.env.LUMO_E2E_OUT ?? "e2e-out";
const file = join(OUT, "results.jsonl");
const results = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

const count = (s) => results.filter((r) => r.status === s).length;
const mark = { passed: "✅", failed: "❌", known: "🟡" };
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");

let md = `## End-to-end (Windows): ${count("passed")} passed, ${count("failed")} failed`;
if (count("known")) md += `, ${count("known")} known bug${count("known") > 1 ? "s" : ""}`;
md += "\n\n";
if (!results.length) md += "No flow ran: see the job's log.\n";
else {
  md += "| | Group | Flow | Time |\n| --- | --- | --- | --- |\n";
  for (const r of results) md += `| ${mark[r.status]} | ${esc(r.group)} | ${esc(r.name)} | ${secs(r.ms)} |\n`;
}
for (const r of results.filter((r) => r.status !== "passed")) {
  md += `\n### ${mark[r.status]} ${esc(r.group)}: ${esc(r.name)}\n\n`;
  if (r.todo) md += `Known bug: ${r.todo}\n\n`;
  md += "```\n" + [...r.steps.map((s) => `· ${s}`), `✗ ${r.error}`].join("\n") + "\n```\n";
  if (r.shots.length) md += `\nScreenshots in the run's \`e2e\` artifact: ${r.shots.map((s) => `\`shots/${s}\``).join(", ")}\n`;
}

if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
console.log(md);
process.exit(count("failed") || !results.length ? 1 : 0);
