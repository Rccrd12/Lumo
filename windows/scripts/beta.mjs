// The beta channel (Settings → Updates → Beta versions): one build holding
// every change not released yet, so it can be tried with a click instead of a
// terminal. The "Windows beta" workflow (.github/workflows/windows-beta.yml)
// runs it in three steps:
//
//   node scripts/beta.mjs merge <state.json>
//       main, then every open pull request of this repository merged into it
//       one at a time, oldest first. Only those whose own Windows CI passed on
//       their latest commit (or that it does not run on) go in: one whose
//       checks fail or are still running is left out this time, with why. One
//       that does not merge is left out and the state says what it conflicts
//       with (main, another pull request, or the other changes together).
//       Pull requests from forks never take part, nor those that change nothing
//       in the app (only its tests, screenshots or notes). When nothing is
//       left that the release does not have, the step says so (`changes`) and
//       the workflow takes the beta down instead of publishing one.
//   node scripts/beta.mjs version <run number>
//       the beta's version, the next patch with the run as its pre-release
//       (0.18.0 → 0.18.1-312), or main's own while it is not released yet
//       (0.19.1 before its tag → 0.19.1-312), written in the three files that carry it. The
//       pre-release is a number only: the .msi takes nothing else.
//   node scripts/beta.mjs notes <state.json> <version>
//       the release's notes: a list people read on GitHub, and the same list
//       for Lumo in a comment, which src-tauri/src/updater.rs reads.
//
// The pull requests' titles are only ever shown as text in Lumo.

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Where Lumo finds the list in the release's notes (updater.rs BETA_MARK). */
export const BETA_MARK = "<!-- lumo-beta ";

/** The .msi's version holds a number up to this as its fourth part. */
const MAX_RUN = 65535;

/** The workflow whose result decides whether a pull request goes in (windows-ci.yml). */
export const CI_WORKFLOW = "Windows CI";

/**
 * What makes up the installed app, as paths under windows/: everything but the
 * tests, the screenshots, the notes and this script. A change outside it is
 * not a reason for a beta.
 */
export const APP_PATHS = [
  ".",
  ":(exclude)tests",
  ":(exclude)screenshots",
  ":(exclude,glob)**/*.md",
  ":(exclude)scripts/beta.mjs",
];

/** Titles longer than this are cut. */
const MAX_TITLE = 200;

/**
 * The beta's version: the next patch after `base`, `run` as its pre-release.
 * When `base` is not released yet (main already says 0.19.1 and its tag is
 * still to come), `base` itself with `run`: 0.19.1-312 is older than 0.19.1, so
 * the release still comes as an update to whoever installed the beta.
 */
export function betaVersion(base, run, released = true) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(base).trim());
  if (!m) throw new Error(`not a version: ${base}`);
  const n = Number(run);
  if (!Number.isInteger(n) || n < 1 || n > MAX_RUN) throw new Error(`run number out of range: ${run}`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + (released ? 1 : 0)}-${n}`;
}

/**
 * Whether a pull request's latest commit passed Windows CI, from GitHub's
 * statusCheckRollup: "pass" (passed, or the CI does not run on it), "fail",
 * or "pending".
 */
export function ciState(rollup) {
  const runs = (Array.isArray(rollup) ? rollup : []).filter((c) => c && c.workflowName === CI_WORKFLOW);
  if (runs.length === 0) return "pass";
  if (runs.some((c) => c.status !== "COMPLETED")) return "pending";
  const ok = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
  return runs.every((c) => ok.has(c.conclusion)) ? "pass" : "fail";
}

/** A title on one line, cut to a readable length. */
export function cleanTitle(title) {
  const one = String(title ?? "").replace(/\s+/g, " ").trim();
  return one.length > MAX_TITLE ? `${one.slice(0, MAX_TITLE - 1).trimEnd()}…` : one;
}

/**
 * The release's notes for `state` (what `merge` wrote) and `version`.
 * The list for Lumo is JSON with `<` and `>` escaped, so no title can end the
 * comment it sits in.
 */
export function renderNotes(state, version) {
  const line = (pr) => `- #${pr.number} ${cleanTitle(pr.title)}`;
  const why = (pr) => {
    if (pr.reason === "checks") return "its checks fail";
    if (pr.reason === "pending") return "its checks are still running";
    return `conflicts with ${pr.with === "main" ? "main" : pr.with ? `#${pr.with}` : "the other changes"}`;
  };
  const left = (pr) => `- #${pr.number} ${cleanTitle(pr.title)} (${why(pr)})`;
  const parts = [
    `Lumo for Windows beta ${version}: main with every open pull request, to try them before they are released.`,
    "Install it from Lumo: Settings → Updates → Beta versions.",
    "",
    state.included.length ? "In this beta:" : "No pull request is open: this is main, with what has not been released yet.",
    ...state.included.map(line),
  ];
  if (state.excluded.length) parts.push("", "Left out:", ...state.excluded.map(left));
  const manifest = {
    version,
    main: state.main,
    included: state.included.map((pr) => ({ number: pr.number, title: cleanTitle(pr.title), updatedAt: pr.updatedAt })),
    excluded: state.excluded.map((pr) => ({
      number: pr.number,
      title: cleanTitle(pr.title),
      updatedAt: pr.updatedAt,
      ...(pr.with ? { with: String(pr.with) } : {}),
      ...(pr.reason ? { reason: pr.reason } : {}),
    })),
  };
  const json = JSON.stringify(manifest).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  parts.push("", `${BETA_MARK}${json} -->`);
  return parts.join("\n");
}

// ── The steps, run by the workflow ────────────────────────────────────────────

function git(args, opts = {}) {
  return execFileSync("git", ["-c", "user.name=Lumo beta", "-c", "user.email=beta@lumo.invalid", ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
}

function tryGit(args) {
  try {
    git(args);
    return true;
  } catch {
    return false;
  }
}

/** True when `range` (as git diff takes it) changes the app; true too when git cannot tell. */
function changesApp(range) {
  return !tryGit(["diff", "--quiet", ...range, "--", ...APP_PATHS]);
}

/** The version main carries, which is the last release or the one about to be. */
function mainVersion() {
  return JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")).version;
}

/** True when `a` and `b` merge without a conflict (nothing is checked out). */
function mergesCleanly(a, b) {
  return tryGit(["merge-tree", "--write-tree", "--quiet", a, b]);
}

function openPullRequests() {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error("GITHUB_REPOSITORY is not set");
  const out = execFileSync(
    "gh",
    ["pr", "list", "--repo", repo, "--base", "main", "--state", "open", "--limit", "100",
      "--json", "number,title,updatedAt,headRefOid,isCrossRepository,statusCheckRollup"],
    { encoding: "utf8" },
  );
  return JSON.parse(out)
    .filter((pr) => !pr.isCrossRepository)
    .sort((a, b) => a.number - b.number);
}

function merge(statePath) {
  const main = git(["rev-parse", "HEAD"]).trim();
  const included = [];
  const excluded = [];
  for (const pr of openPullRequests()) {
    const ref = `refs/beta/pr-${pr.number}`;
    git(["fetch", "--no-tags", "origin", `+refs/pull/${pr.number}/head:${ref}`]);
    const head = git(["rev-parse", ref]).trim();
    if (!changesApp([`${main}...${head}`])) {
      console.log(`#${pr.number} skipped (changes nothing in the app)`);
      continue;
    }
    const entry = { number: pr.number, title: pr.title, updatedAt: pr.updatedAt, head };
    const ci = ciState(pr.statusCheckRollup);
    if (ci !== "pass") {
      excluded.push({ ...entry, reason: ci === "fail" ? "checks" : "pending" });
      console.log(`#${pr.number} left out (Windows CI: ${ci})`);
      continue;
    }
    if (tryGit(["merge", "--no-ff", "--no-edit", "-m", `beta: #${pr.number}`, ref])) {
      included.push(entry);
      console.log(`#${pr.number} merged`);
      continue;
    }
    tryGit(["merge", "--abort"]);
    let withWhat = null;
    if (!mergesCleanly(main, head)) withWhat = "main";
    else withWhat = included.find((other) => !mergesCleanly(other.head, head))?.number ?? null;
    excluded.push({ ...entry, reason: "conflict", with: withWhat });
    console.log(`#${pr.number} left out (conflicts with ${withWhat ?? "the other changes"})`);
  }
  // Without a pull request, the beta is main: worth it only when main changed
  // the app since its release (a tag that does not exist yet counts as changed).
  const release = `windows-v${mainVersion()}`;
  const changes = included.length > 0 || changesApp([release, main]);
  if (!changes) console.log(`nothing the release ${release} does not have: no beta`);
  writeFileSync(statePath, JSON.stringify({ main, included, excluded, changes }, null, 2));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changes=${changes}\n`);
}

function setVersion(run) {
  const confPath = join(root, "src-tauri", "tauri.conf.json");
  const base = mainVersion();
  const released = tryGit(["rev-parse", "--verify", "--quiet", `refs/tags/windows-v${base}`]);
  const version = betaVersion(base, run, released);
  const swapJson = (path) => {
    const text = readFileSync(path, "utf8");
    writeFileSync(path, text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`));
  };
  swapJson(confPath);
  swapJson(join(root, "package.json"));
  const cargo = join(root, "Cargo.toml");
  writeFileSync(cargo, readFileSync(cargo, "utf8").replace(/^version\s*=\s*"[^"]*"/m, `version = "${version}"`));
  console.log(version);
}

function notes(statePath, version) {
  process.stdout.write(renderNotes(JSON.parse(readFileSync(statePath, "utf8")), version));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [step, ...args] = process.argv.slice(2);
  if (step === "merge" && args[0]) merge(args[0]);
  else if (step === "version" && args[0]) setVersion(args[0]);
  else if (step === "notes" && args[0] && args[1]) notes(args[0], args[1]);
  else {
    console.error("usage: beta.mjs merge <state.json> | version <run> | notes <state.json> <version>");
    process.exit(2);
  }
}
