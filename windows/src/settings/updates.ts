// Settings → Updates: this build's version, and a newer one from GitHub when
// there is one. GitHub is asked when the button is clicked, and once when
// Lumo opens unless that is turned off (core/update-check.ts, which leaves
// what it found here); only "Update now" downloads and runs the installer
// (src-tauri/src/updater.rs), which then replaces Lumo without a window and
// opens it again. Under it, the
// changelog built into the app (./changelog.ts).
//
// Beta versions (off unless turned on) adds the beta channel's build, main
// with every open pull request (.github/workflows/windows-beta.yml), with the
// list of what is in it and Install the beta. On a beta, Back to the release
// reinstalls the latest release.

import CHANGELOG from "virtual:lumo-changelog";
import { Bridge, onEvent, type BetaInfo, type UpdateInfo } from "../core/bridge";
import { isBetaVersion, pullRow } from "./beta";
import { foundFor, rememberFound } from "../core/update-check";
import { clear, h } from "../views/dom";
import { errorText, sectionHead, setting } from "./parts";
import { changelogList, parseChangelog } from "./changelog";
import { t } from "../i18n/i18n";

const TEXT = {
  get title() { return t("Updates"); },
  get version() { return t("Version"); },
  get check() { return t("Check for updates"); },
  get checking() { return t("Checking…"); },
  get upToDate() { return t("Lumo is up to date."); },
  available: (version: string) => t("Version {version} is available.", { version }),
  noInstaller: (version: string) =>
    t("Version {version} is out, but its installer isn't there yet. Try again later.", { version }),
  get notes() { return t("What's new"); },
  get updateNow() { return t("Update now"); },
  get updateHint() { return t("Lumo downloads the update, installs it by itself and opens again."); },
  get downloading() { return t("Downloading the update…"); },
  get launching() { return t("Installing the update: Lumo closes and opens again by itself in a few seconds."); },
  get changelog() { return t("Changelog"); },
  get changelogIntro() { return t("What changed in each version of Lumo."); },
  get installed() { return t("Installed"); },
  get noTelemetry() { return t("No telemetry. Network requests only go to the services you configure yourself."); },
  get betaTag() { return t("beta"); },
  betaAvailable: (version: string) => t("Beta {version} is available, with the changes below not released yet.", { version }),
  newerBeta: (version: string) => t("A newer beta is available: {version}.", { version }),
  get latestBeta() { return t("You have the latest beta."); },
  get noBeta() { return t("No beta has been published yet."); },
  get inThisBeta() { return t("In this beta"); },
  get onlyMain() { return t("No pull request is open: this beta is main, with what has not been released yet."); },
  get installBeta() { return t("Install the beta"); },
  get updateBeta() { return t("Update the beta"); },
  get betaHint() { return t("Lumo downloads the beta, installs it by itself and opens again."); },
  backToRelease: (version: string) => t("Back to the release {version}", { version }),
  get backHint() { return t("Reinstalls the latest public version. Your settings stay."); },
};

type Phase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "checked"; info: UpdateInfo }
  | { kind: "failed"; error: string; info: UpdateInfo | null }
  | { kind: "downloading"; info: UpdateInfo; received: number; total: number }
  | { kind: "launching"; info: UpdateInfo };

// Kept across redraws of the window (language change, settings changes), so a
// check's result or a download in progress stays on screen.
let phase: Phase = { kind: "idle" };
let redraw: (() => void) | null = null;
let listening = false;
/** Settings → Updates → Beta versions, as settings/main.ts keeps it. */
let betaOn: () => boolean = () => false;

function set(next: Phase) {
  phase = next;
  redraw?.();
}

function lastInfo(): UpdateInfo | null {
  return "info" in phase ? phase.info : null;
}

/** Checks asked so far: only the last one's answer is shown. */
let checks = 0;

async function check() {
  const mine = ++checks;
  set({ kind: "checking" });
  // Beta versions turned on and off quickly: the first answer may come last,
  // with the other channel's version. A download started meanwhile stays on screen.
  const current = () => mine === checks && phase.kind !== "downloading" && phase.kind !== "launching";
  try {
    const info = await Bridge.updateCheck(betaOn());
    if (!current()) return;
    rememberFound(info);
    set({ kind: "checked", info });
  } catch (err) {
    if (current()) set({ kind: "failed", error: errorText(err), info: null });
  }
}

/** Installs `url`: the release's installer, unless another (the beta's) is given. */
async function install(info: UpdateInfo, url = info.assetUrl) {
  if (!url) return;
  set({ kind: "downloading", info, received: 0, total: 0 });
  try {
    await Bridge.updateInstall(url);
    set({ kind: "launching", info });
  } catch (err) {
    set({ kind: "failed", error: errorText(err), info });
  }
}

/** Beta versions was just turned on or off: look again, with or without the beta. */
export function betaChanged() {
  if (phase.kind === "downloading" || phase.kind === "launching") return;
  void check();
}

/**
 * `checkOnOpen` is Settings → Updates → Check when Lumo opens, and `beta` Beta
 * versions, as rows settings/main.ts builds with their switches; `isBetaOn`
 * reads that switch.
 */
export function updatesSection(
  version: string,
  checkOnOpen: HTMLElement,
  beta: HTMLElement,
  isBetaOn: () => boolean,
): HTMLElement {
  betaOn = isBetaOn;
  // A newer release the island found when Lumo opened: shown at once, with Update now.
  if (phase.kind === "idle") {
    const found = foundFor(version);
    if (found) phase = { kind: "checked", info: found };
  }
  if (!listening) {
    listening = true;
    void onEvent<{ received: number; total: number }>("update-progress", (p) => {
      if (phase.kind === "downloading") set({ ...phase, received: p.received, total: p.total });
    });
  }

  const body = h("div", { style: "display:flex;flex-direction:column;gap:12px" });

  function draw() {
    clear(body);
    const busy = phase.kind === "checking" || phase.kind === "downloading" || phase.kind === "launching";
    const checkBtn = h("button", {
      text: phase.kind === "checking" ? TEXT.checking : TEXT.check,
      onclick: () => void check(),
    }) as HTMLButtonElement;
    checkBtn.disabled = busy;
    const info = lastInfo();
    const current = info?.current || version;
    const onBeta = info?.currentBeta ?? isBetaVersion(current);
    const label = h("span", { style: "display:inline-flex;gap:8px;align-items:center" },
      TEXT.version, " ", h("span", { class: "version-number", text: current || "—" }));
    if (onBeta) label.append(h("span", { class: "tag warn", text: TEXT.betaTag }));
    body.append(
      setting(label,
        TEXT.noTelemetry,
        checkBtn,
      ),
      checkOnOpen,
      beta,
    );

    switch (phase.kind) {
      case "checked":
        if (!phase.info.newer) {
          // Up to date, unless a beta is what there is to install.
          const betaOffered = betaOn() && phase.info.beta?.newer === true;
          if (!onBeta && !betaOffered) body.append(h("div", { class: "notice ok", text: TEXT.upToDate }));
        } else if (!phase.info.assetUrl) {
          body.append(h("div", { class: "notice warn", text: TEXT.noInstaller(phase.info.latest) }));
          notes(phase.info);
        } else {
          const target = phase.info;
          body.append(
            h("div", { class: "notice ok", text: TEXT.available(target.latest) }),
          );
          notes(target);
          body.append(
            h("div", { class: "row" },
              h("button", { class: "primary", text: TEXT.updateNow, onclick: () => void install(target) }),
              h("span", { class: "hint", text: TEXT.updateHint }),
            ),
          );
        }
        if (betaOn()) betaPart(phase.info, onBeta);
        if (onBeta) backToRelease(phase.info);
        break;
      case "downloading": {
        const pct = phase.total > 0 ? Math.min(100, Math.round((phase.received / phase.total) * 100)) : null;
        const bar = h("div", { class: pct === null ? "progress busy" : "progress" },
          h("i", { style: pct === null ? "" : `width:${pct}%` }),
        );
        body.append(
          h("div", { class: "row" },
            h("span", { class: "hint", text: TEXT.downloading }),
            h("span", { class: "spacer" }),
            h("span", { class: "hint", text: pct === null ? "" : `${pct}%` }),
          ),
          bar,
        );
        break;
      }
      case "launching":
        body.append(h("div", { class: "notice ok", text: TEXT.launching }));
        break;
      case "failed":
        body.append(h("div", { class: "notice err", text: phase.error }));
        if (phase.info?.newer && phase.info.assetUrl) {
          const target = phase.info;
          body.append(h("div", { class: "row" },
            h("button", { class: "primary", text: TEXT.updateNow, onclick: () => void install(target) }),
          ));
        }
        break;
      default:
        break;
    }

  }

  /** The beta's build: what is new, what is in it, Install the beta. */
  function betaPart(info: UpdateInfo, onBeta: boolean) {
    const b: BetaInfo | null | undefined = info.beta;
    if (!b) {
      body.append(h("div", { class: "notice warn", text: TEXT.noBeta }));
      return;
    }
    // Not newer than this build, or a release came out since: nothing to try.
    if (!b.newer && (!onBeta || info.newer)) return;
    if (b.newer && !b.assetUrl) {
      body.append(h("div", { class: "notice warn", text: TEXT.noInstaller(b.version) }));
    } else if (b.newer) {
      body.append(h("div", { class: "notice ok", text: onBeta ? TEXT.newerBeta(b.version) : TEXT.betaAvailable(b.version) }));
    } else {
      body.append(h("div", { class: "notice ok", text: TEXT.latestBeta }));
    }
    body.append(h("div", { class: "subhead", text: TEXT.inThisBeta }));
    const list = h("div", { style: "display:flex;flex-direction:column;gap:7px" });
    for (const pr of b.included) list.append(pullRow(pr, false));
    for (const pr of b.excluded) list.append(pullRow(pr, true));
    if (!b.included.length) list.prepend(h("span", { class: "hint", text: TEXT.onlyMain }));
    body.append(list);
    if (b.newer && b.assetUrl) {
      const url = b.assetUrl;
      body.append(h("div", { class: "row" },
        h("button", { class: "primary", text: onBeta ? TEXT.updateBeta : TEXT.installBeta, onclick: () => void install(info, url) }),
        h("span", { class: "hint", text: TEXT.betaHint }),
      ));
    }
  }

  /** On a beta: back to the latest release, unless a newer one is offered above. */
  function backToRelease(info: UpdateInfo) {
    if (info.newer || !info.assetUrl) return;
    body.append(h("div", { class: "row" },
      h("button", { text: TEXT.backToRelease(info.latest), onclick: () => void install(info) }),
      h("span", { class: "hint", text: TEXT.backHint }),
    ));
  }

  function notes(info: UpdateInfo) {
    if (!info.notes) return;
    body.append(
      h("div", { class: "subhead", text: TEXT.notes }),
      h("div", { class: "release-notes", text: info.notes }),
    );
  }

  redraw = draw;
  draw();
  return h("section", {}, ...sectionHead(TEXT.title), body);
}

/** The changelog built into the app, the installed version marked. */
export function changelogSection(version: string): HTMLElement {
  const entries = parseChangelog(CHANGELOG);
  return h("section", {},
    ...sectionHead(TEXT.changelog, TEXT.changelogIntro),
    changelogList(entries, version, TEXT.installed),
  );
}
