// Settings → Local models: Ollama, LM Studio, Unsloth Studio, Maya and a
// custom server, with their addresses, keys and the models they serve.

import { Bridge, type UnslothStudio } from "../../core/bridge";
import { CUSTOM_SERVER_KEY, UNSLOTH_SERVER_KEY, pickModel, providerDef, urlExposure } from "../../core/providers";
import { h, clear } from "../../views/dom";
import { accentDot, sectionHead, setting, statusDot, wideSetting } from "../parts";
import { localModelsBlock, type UnslothMemory } from "../local-models";
import { mayaBlock } from "../maya";
import { N_, t } from "../../i18n/i18n";
import { CHAT_STRINGS } from "./chat";
import { save, select, settings, toggle } from "../store";

// ── Local models section ──────────────────────────────────────────────────────

export type LocalId = "ollama" | "lmstudio" | "unsloth" | "custom";
/** The servers that take a key, and its credential store entry. */
const KEYED: Partial<Record<LocalId, string>> = { custom: CUSTOM_SERVER_KEY, unsloth: UNSLOTH_SERVER_KEY };

/** Redraws the local models section after a change made elsewhere (the island). */
export let localRedraw: (() => void) | null = null;

export function setLocalRedraw(redraw: (() => void) | null) {
  localRedraw = redraw;
}

/** Unsloth Studio's key field: its sk-unsloth key, from its Settings → API. */
const UNSLOTH_KEY_HINT = N_("Its key, sk-unsloth-… (Unsloth Studio → Settings → API)");

const LOCAL: Record<LocalId, { name: string; usual: string }> = {
  ollama: { name: "Ollama", usual: "http://127.0.0.1:11434" },
  lmstudio: { name: "LM Studio", usual: "http://127.0.0.1:1234" },
  // Its port is the one `unsloth run` prints: 8888, else 8000 (both are tried).
  unsloth: { name: "Unsloth Studio", usual: "http://127.0.0.1:8888" },
  // No usual address: any server that speaks the OpenAI API.
  custom: { name: N_("OpenAI-compatible"), usual: "" },
};

/** What an address means for the user's data, as a hint line. */
function exposureNotice(url: string, withKey: boolean): HTMLElement | null {
  switch (urlExposure(url)) {
    case "local":
      return h("div", { class: "hint", text: CHAT_STRINGS.localOnly });
    case "remote":
      return h("div", { class: "hint", text: CHAT_STRINGS.remote });
    case "remote-http":
      return withKey
        ? h("div", { class: "notice warn", text: CHAT_STRINGS.keyOverHttp })
        : h("div", { class: "hint", text: CHAT_STRINGS.remoteHttp });
    case "invalid":
      return url.trim() ? h("div", { class: "notice err", text: CHAT_STRINGS.invalid }) : null;
  }
}

/** A local model's chat compacted by itself when its context is nearly full (views/chat.ts). */
const AUTO_COMPACT = {
  get label() { return t("Compact by itself when the context is full"); },
  get hint() { return t("Over 80 %, before the question goes: the model starts again from a summary of the chat."); },
};

/** Unsloth Studio started and stopped by Lumo (unsloth_studio.rs). */
const UNSLOTH_START = {
  label: N_("Start and stop it by itself"),
  hint: N_("When you pick it in the chat, Lumo starts Unsloth Studio in the background, with no window."),
  notInstalled: N_("Not found on this computer: install Unsloth Studio first."),
  notHere: N_("Only for Unsloth Studio on this computer."),
  stopAfter: N_("Stop after"),
  stopAfterHint: N_("Only if Lumo started it: an Unsloth Studio you opened stays on."),
  minutes5: N_("5 minutes with no question"),
  minutes15: N_("15 minutes with no question"),
  hour: N_("1 hour with no question"),
  exit: N_("When Lumo quits"),
  never: N_("Never"),
  off: N_("Off: it starts when you use it in the chat."),
  offPlain: N_("Off."),
  start: N_("Start now"),
  stop: N_("Stop now"),
  starting: N_("Starting Unsloth Studio…"),
  seconds: N_("{seconds} s"),
  ownedAfter: N_("Started by Lumo: it stops after {minutes} minutes with no question."),
  ownedExit: N_("Started by Lumo: it stops when Lumo quits."),
  ownedNever: N_("Started by Lumo: it stays on."),
};

/** Unsloth Studio's address is this computer: the only one Lumo starts. */
function unslothHere(): boolean {
  return urlExposure(settings.unslothUrl) === "local";
}

/** "Start and stop it by itself" and "Stop after", under a connected Unsloth Studio. */
function unslothStartBlock(): HTMLElement {
  const block = h("div", {});
  const hint = h("span", { text: t(UNSLOTH_START.hint) });
  const stopAfter = select(
    [
      ["5", t(UNSLOTH_START.minutes5)],
      ["15", t(UNSLOTH_START.minutes15)],
      ["60", t(UNSLOTH_START.hour)],
      ["exit", t(UNSLOTH_START.exit)],
      ["never", t(UNSLOTH_START.never)],
    ],
    settings.unslothStopAfter || "15",
    (v) => { settings.unslothStopAfter = v; void save().then(() => unslothMemory.refresh()); },
  );
  block.append(
    setting(t(UNSLOTH_START.label), hint, toggle(settings.unslothAutoStart !== false, (on) => {
      settings.unslothAutoStart = on;
      void save().then(() => unslothMemory.refresh());
    })),
    setting(t(UNSLOTH_START.stopAfter), t(UNSLOTH_START.stopAfterHint), stopAfter),
  );
  // Not installed, or connected at another computer's address: said in place of the hint.
  if (!unslothHere()) hint.textContent = t(UNSLOTH_START.notHere);
  else void Bridge.unslothStudioStatus().then((s) => { if (s && !s.installed) hint.textContent = t(UNSLOTH_START.notInstalled); });
  return block;
}

/**
 * The In memory row of Unsloth Studio, while it is off, starting, or on and
 * started by Lumo (local-models.ts asks this for the words and the buttons).
 */
const unslothMemory: UnslothMemory = {
  refresh: () => {},
  async describe(reachable: boolean, live?: UnslothStudio) {
    const s = live ?? (await Bridge.unslothStudioStatus());
    if (!s) return null;
    if (s.state === "starting") {
      const seconds = s.seconds >= 2 ? t(UNSLOTH_START.seconds, { seconds: s.seconds }) : "";
      return { starting: t(UNSLOTH_START.starting), seconds };
    }
    if (reachable) {
      if (!s.owned) return null;
      const after = settings.unslothStopAfter || "15";
      const line = after === "exit" ? t(UNSLOTH_START.ownedExit)
        : after === "never" ? t(UNSLOTH_START.ownedNever)
        : t(UNSLOTH_START.ownedAfter, { minutes: after });
      return { line, stop: t(UNSLOTH_START.stop) };
    }
    // Off, and Lumo can start it: no error, only what happens next.
    if (!s.installed || !unslothHere()) return null;
    return { off: t(settings.unslothAutoStart !== false ? UNSLOTH_START.off : UNSLOTH_START.offPlain), start: t(UNSLOTH_START.start) };
  },
  start: () => Bridge.unslothStudioStart(),
  stop: () => Bridge.unslothStudioStop().then(() => {}),
};

export function localSection(keys: Partial<Record<LocalId, boolean>>): HTMLElement {
  const body = h("div", { class: "setting-list" });
  const section = h(
    "section",
    {},
    ...sectionHead(CHAT_STRINGS.localTitle, CHAT_STRINGS.localHint),
    body,
    h("div", { class: "setting-list" },
      setting(AUTO_COMPACT.label, AUTO_COMPACT.hint,
        toggle(settings.chatAutoCompact !== false, (on) => { settings.chatAutoCompact = on; void save(); }),
      ),
    ),
  );
  const redraw = () => {
    clear(body);
    for (const id of Object.keys(LOCAL) as LocalId[]) {
      body.append(serverBlock(id));
      // Maya, which Lumo starts from its folder (settings/maya.ts), after the other server it starts.
      if (id === "unsloth") body.append(mayaBlock(redraw));
    }
  };

  function serverBlock(id: LocalId): HTMLElement {
    const def = LOCAL[id];
    const p = providerDef(id);
    const field = p.urlField!;
    const connected = settings[field] !== "";
    const status = h("div", {});
    const exposure = h("div", {});
    const label = () => h("span", { class: "with-dot" }, accentDot(p.accent), t(def.name));
    const block = h("div", { class: "setting-block" });

    if (connected) {
      const inUse = settings.chatProvider === id;
      const use = h("button", { class: inUse ? "" : "primary", text: inUse ? CHAT_STRINGS.inUse : CHAT_STRINGS.useInChat });
      use.disabled = inUse;
      use.addEventListener("click", () => {
        settings.chatProvider = id;
        void save().then(redraw);
      });
      const disconnect = h("button", { class: "danger", text: CHAT_STRINGS.disconnect });
      disconnect.addEventListener("click", async () => {
        settings[field] = "";
        if (settings.chatProvider === id) settings.chatProvider = "anthropic";
        const entry = KEYED[id];
        if (entry) {
          await Bridge.secretClear(entry).catch(() => {});
          keys[id] = false;
        }
        await save();
        redraw();
      });
      block.append(
        setting(h("span", { class: "with-dot" }, label(), statusDot(true)), h("span", { class: "path", text: settings[field] }), use, disconnect),
        status,
      );
      exposure.append(exposureNotice(settings[field], keys[id] === true) ?? "");
      block.append(exposure);
      // Unsloth Studio on this computer: Lumo starts it when the chat needs it, and stops it.
      if (id === "unsloth") block.append(unslothStartBlock());
      // What Ollama, LM Studio and Unsloth Studio hold in memory (and a model to download where offered).
      if (id === "ollama" || id === "lmstudio" || id === "unsloth") {
        block.append(localModelsBlock(id, id === "unsloth" ? unslothMemory : undefined));
      }
      return block;
    }

    const input = h("input", {
      type: "text",
      placeholder: def.usual || "https://llm.example.com",
      style: "flex:1 1 auto;min-width:0",
      spellcheck: "false",
      autocomplete: "off",
    }) as HTMLInputElement;
    // A custom server may want a key; it goes to the keychain, never to settings.json.
    const key = h("input", {
      type: "password",
      placeholder: keys[id] ? CHAT_STRINGS.stored : id === "unsloth" ? t(UNSLOTH_KEY_HINT) : CHAT_STRINGS.keyOptional,
      style: "flex:1 1 auto;min-width:0",
      autocomplete: "off",
      spellcheck: "false",
    }) as HTMLInputElement;
    const connect = h("button", { class: "primary", text: CHAT_STRINGS.connect });

    const showExposure = () => {
      clear(exposure);
      const withKey = KEYED[id] !== undefined && (keys[id] === true || key.value.trim() !== "");
      const notice = exposureNotice(input.value || def.usual, withKey);
      if (notice) exposure.append(notice);
    };
    input.addEventListener("input", showExposure);
    key.addEventListener("input", showExposure);

    connect.addEventListener("click", async () => {
      connect.disabled = true;
      clear(status);
      status.append(h("div", { class: "hint", text: CHAT_STRINGS.connecting }));
      try {
        const keyed = id === "custom" || id === "unsloth" ? id : undefined;
        const typedKey = keyed ? key.value.trim() : "";
        if (keyed && typedKey) {
          // Stored with this address: the key is only ever sent there.
          await Bridge.localSetKey(input.value || def.usual, typedKey, keyed);
          key.value = "";
          keys[id] = true;
        }
        const server = await Bridge.localConnect(id, input.value);
        // Found at another address (Unsloth Studio on its other port): the key goes with it.
        if (keyed && typedKey && server.models.length) await Bridge.localSetKey(server.url, typedKey, keyed);
        if (!server.models.length) {
          clear(status);
          status.append(h("div", { class: "notice err", text: CHAT_STRINGS.noModels(t(def.name)) }));
        } else {
          settings[field] = server.url;
          // The model picked before stays, by the name the server gives it now.
          const keep = pickModel(providerDef(id), server.models, settings.chatModels[id] ?? "") ?? server.models[0];
          if (keep !== settings.chatModels[id]) {
            settings.chatModels = { ...settings.chatModels, [id]: keep };
          }
          await save();
          redraw();
          return;
        }
      } catch (err) {
        clear(status);
        status.append(h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }));
      }
      connect.disabled = false;
    });

    block.append(wideSetting(label(), null, input, connect));
    if (KEYED[id]) block.append(h("div", { class: "setting-extra" }, key));
    block.append(status, exposure);
    showExposure();
    return block;
  }

  redraw();
  localRedraw = redraw;
  return section;
}
