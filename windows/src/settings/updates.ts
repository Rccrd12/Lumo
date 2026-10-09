// Settings → Updates: this build's version, and a newer one from GitHub when
// there is one. Nothing is checked in the background: only the button asks
// (src-tauri/src/updater.rs), and only "Update now" downloads and runs the
// installer, which then replaces Lumo.

import { Bridge, onEvent, type UpdateInfo } from "../core/bridge";
import { clear, h } from "../views/dom";
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
  get updateHint() { return t("The installer opens and Lumo closes while it runs."); },
  get downloading() { return t("Downloading the installer…"); },
  get launching() { return t("The installer is starting. Lumo closes now so it can be updated."); },
  get onClick() { return t("Lumo only looks for updates when you click: nothing is checked in the background."); },
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

function errorText(err: unknown): string {
  return String(err).replace(/^Error:\s*/, "");
}

function lastInfo(): UpdateInfo | null {
  return "info" in phase ? phase.info : null;
}

async function check() {
  set({ kind: "checking" });
  try {
    set({ kind: "checked", info: await Bridge.updateCheck() });
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

export function updatesSection(version: string): HTMLElement {
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
      h("div", { class: "row" },
        h("label", { text: TEXT.version }),
        h("span", { class: "version-number", text: info?.current || version || "—" }),
        h("span", { class: "spacer" }),
        checkBtn,
      ),
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

    body.append(
      h("div", { class: "hint", text: TEXT.onClick }),
      h("div", { class: "hint", text: TEXT.noTelemetry }),
    );
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
  return h("section", {}, h("h2", {}, h("span", { text: TEXT.title })), body);
}
