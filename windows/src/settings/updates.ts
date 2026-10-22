// Settings → Updates: this build's version, and a newer one from GitHub when
// there is one. GitHub is asked when the button is clicked, and once when
// Lumo opens unless that is turned off (core/update-check.ts, which leaves
// what it found here); only "Update now" downloads and runs the installer
// (src-tauri/src/updater.rs), which then replaces Lumo without a window and
// opens it again. Under it, the
// changelog built into the app (./changelog.ts).

import CHANGELOG from "virtual:lumo-changelog";
import { Bridge, onEvent, type UpdateInfo } from "../core/bridge";
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

function set(next: Phase) {
  phase = next;
  redraw?.();
}

function lastInfo(): UpdateInfo | null {
  return "info" in phase ? phase.info : null;
}

async function check() {
  set({ kind: "checking" });
  try {
    const info = await Bridge.updateCheck();
    rememberFound(info);
    set({ kind: "checked", info });
  } catch (err) {
    set({ kind: "failed", error: errorText(err), info: null });
  }
}

async function install(info: UpdateInfo) {
  if (!info.assetUrl) return;
  set({ kind: "downloading", info, received: 0, total: 0 });
  try {
    await Bridge.updateInstall(info.assetUrl);
    set({ kind: "launching", info });
  } catch (err) {
    set({ kind: "failed", error: errorText(err), info });
  }
}

/**
 * `checkOnOpen` is Settings → Updates → Check when Lumo opens, as a row
 * settings/main.ts builds with its switch.
 */
export function updatesSection(version: string, checkOnOpen: HTMLElement): HTMLElement {
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
    body.append(
      setting(h("span", {}, TEXT.version, " ", h("span", { class: "version-number", text: info?.current || version || "—" })),
        TEXT.noTelemetry,
        checkBtn,
      ),
      checkOnOpen,
    );

    switch (phase.kind) {
      case "checked":
        if (!phase.info.newer) {
          body.append(h("div", { class: "notice ok", text: TEXT.upToDate }));
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
