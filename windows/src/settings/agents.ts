// Settings → Agents: one section for every agent other than Claude Code, all
// going through the same steps — preview the exact diff, click to confirm, and
// only then does agents.rs back the file up and write it.

import { Bridge, type AgentHookStatus } from "../core/bridge";
import { clear, h } from "../views/dom";
import { renderDiff, sectionHead, setting, statusDot } from "./parts";
import { t } from "../i18n/i18n";

/** In the current language (src/i18n); the settings window redraws on a change. */
const TEXT = {
  get title() { return t("Agents"); },
  get intro() {
    return t("Show other coding agents in the island. Lumo adds its entries to each agent's own config: you see the exact change and where the backup goes before anything is written, and uninstalling removes only what Lumo added.");
  },
  get none() { return t("Lumo could not list the agents."); },
  get approvals() { return t("Sessions, and Allow / Deny from the island"); },
  get displayOnly() { return t("Sessions — approvals stay in the agent"); },
  get install() { return t("Install…"); },
  get reinstall() { return t("Reinstall…"); },
  get uninstall() { return t("Uninstall…"); },
  get relayMissing() { return t("The relay isn't installed yet. Restart Lumo."); },
  get geminiRetired() {
    return t("Google replaced Gemini CLI with Antigravity CLI, which reads the Antigravity hooks above. Lumo no longer installs these: they were added before, and can be removed.");
  },
  get antigravityBoth() { return t("For the Antigravity app and for Antigravity CLI (agy): both read these hooks."); },
  get retired() { return t("Retired"); },
  previewInstall: (name: string) => t("This is exactly what changes for {name}. Nothing else is touched.", { name }),
  get previewRemove() { return t("This removes Lumo's entries only. Everything else stays."); },
  backup: (to: string) => (to ? t("Backup → {path}", { path: to }) : t("No existing file — nothing to back up.")),
  get confirmInstall() { return t("Back up and write"); },
  get confirmRemove() { return t("Back up and remove"); },
  get cancel() { return t("Cancel"); },
  get back() { return t("Back"); },
  done: (backups: string, note: string) => {
    const saved = backups
      ? t("Done. Previous version saved as {paths}.", { paths: backups.split("\n").join(", ") })
      : t("Done.");
    return `${saved} ${note}`;
  },
  failed: (err: unknown) => t("Could not write: {error}", { error: errorText(err) }),
};

function errorText(err: unknown): string {
  return String(err).replace(/^Error:\s*/, "");
}

export function agentsSection(list: AgentHookStatus[] | null): HTMLElement {
  const blocks = h("div", { class: "setting-list" });
  if (!list || list.length === 0) {
    blocks.append(h("div", { class: "hint", text: TEXT.none }));
  }
  // Gemini CLI, retired, comes last: it is only there to be removed.
  const ordered = [...(list ?? [])].sort((a, b) => Number(a.id === "gemini") - Number(b.id === "gemini"));
  for (const status of ordered) blocks.append(agentBlock(status));
  return h(
    "section",
    {},
    ...sectionHead(TEXT.title, TEXT.intro),
    blocks,
  );
}

function agentBlock(initial: AgentHookStatus): HTMLElement {
  let status = initial;
  const head = h("div", {});
  const body = h("div", { class: "setting-block" });
  const block = h("div", { class: "setting-block" }, head, body);

  async function refresh() {
    const fresh = (await Bridge.agentHooksList())?.find((a) => a.id === status.id);
    if (fresh) status = fresh;
    draw();
  }

  function draw() {
    clear(head);
    clear(body);
    const install = h("button", {
      class: "primary",
      text: status.installed ? TEXT.reinstall : TEXT.install,
      onclick: () => void showPreview(true),
    });
    // A hook pointing at a relay that isn't there would break the agent's hooks.
    if (!status.hookReady) {
      install.disabled = true;
      install.title = TEXT.relayMissing;
    }
    // Gemini CLI is retired: its hooks can only be taken out.
    const retired = status.id === "gemini";
    const buttons: HTMLElement[] = [];
    if (!retired) buttons.push(install);
    if (status.installed) {
      buttons.push(h("button", {
        class: retired ? "primary" : "danger",
        text: TEXT.uninstall,
        onclick: () => void showPreview(false),
      }));
    }
    const what = retired ? TEXT.geminiRetired
      : [status.approvals ? TEXT.approvals : TEXT.displayOnly, status.id === "antigravity" ? TEXT.antigravityBoth : ""].filter(Boolean).join(" · ");
    head.append(setting(
      h("span", { class: "with-dot" }, statusDot(status.installed), status.name, retired ? h("span", { class: "tag warn", text: TEXT.retired }) : null),
      h("span", {}, what, h("br"), h("span", { class: "path", text: status.path })),
      ...buttons,
    ));
  }

  async function showPreview(install: boolean) {
    let plan;
    try {
      plan = await Bridge.agentHooksPreview(status.id, install);
    } catch (err) {
      // An unreadable or unexpected config stops here rather than being
      // treated as empty and written over.
      clear(body);
      body.append(
        h("div", { class: "notice err", text: errorText(err) }),
        h("div", { class: "row" }, h("button", { text: TEXT.back, onclick: draw })),
      );
      return;
    }
    clear(body);
    body.append(
      h("div", { class: "hint", text: install ? TEXT.previewInstall(status.name) : TEXT.previewRemove }),
      renderDiff(plan.diff),
      h("div", { class: "row" }, h("span", { class: "path", text: TEXT.backup(plan.backup) })),
    );
    const confirm = h("button", {
      class: install ? "primary" : "danger",
      text: install ? TEXT.confirmInstall : TEXT.confirmRemove,
    });
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      try {
        const backups = await Bridge.agentHooksApply(status.id, install, plan.fingerprint);
        clear(body);
        body.append(h("div", { class: "notice ok", text: TEXT.done(backups, install ? status.note : "") }));
        window.setTimeout(() => void refresh(), 2600);
      } catch (err) {
        confirm.disabled = false;
        body.append(h("div", { class: "notice err", text: TEXT.failed(err) }));
      }
    });
    body.append(h("div", { class: "row" }, confirm, h("button", { text: TEXT.cancel, onclick: draw })));
  }

  draw();
  return block;
}
