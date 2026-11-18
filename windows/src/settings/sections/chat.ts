// Settings → Chat: the cloud providers the island's chat can use, and the
// remaining usage it shows.

import { Bridge } from "../../core/bridge";
import { providerDef } from "../../core/providers";
import { h } from "../../views/dom";
import { accentDot, sectionHead, setting, statusDot, wideSetting } from "../parts";
import { t, tn } from "../../i18n/i18n";
import { save, select, settings, toggle } from "../store";

// ── Chat providers section ────────────────────────────────────────────────────

export const CHAT_STRINGS = {
  get providersTitle() { return t("Chat providers"); },
  get providersHint() { return t("Chat with Google AI, OpenAI or OpenRouter: add a key here, then pick the model above the chat box. Keys stay in the system keychain. These providers can only answer, never act on this computer."); },
  get stored() { return `••••••••  ${t("(stored)")}`; },
  get save() { return t("Save"); },
  get remove() { return t("Remove"); },
  get localTitle() { return t("Local models"); },
  get localHint() { return t("Chat with a model you run yourself: Ollama, LM Studio or any OpenAI-compatible server (vLLM, llama.cpp…). Leave the address empty for the usual one on this computer."); },
  get connect() { return t("Connect"); },
  get connecting() { return t("Connecting…"); },
  get disconnect() { return t("Disconnect"); },
  get useInChat() { return t("Use in chat"); },
  get inUse() { return t("In use"); },
  get keyOptional() { return t("API key (optional)"); },
  get localOnly() { return t("Nothing leaves your PC: the server runs on this computer."); },
  get remote() { return t("This address is another machine: what you ask is sent to it."); },
  get remoteHttp() { return t("This address is another machine, over plain http: what you ask travels unencrypted."); },
  get keyOverHttp() { return t("Warning: the key would be sent unencrypted (http://) to another machine. Use https://, or a server on this computer."); },
  get invalid() { return t("Not a valid http:// or https:// address."); },
  noModels: (name: string) => t("No models yet. Download one in {name} first.", { name }),
  models: (n: number) => tn("{count} model", "{count} models", n),
};

interface CloudDef {
  id: "google" | "openai" | "openrouter";
  name: string;
  placeholder: string;
  where: string;
}

export const CLOUD: CloudDef[] = [
  { id: "google", name: "Google AI", placeholder: "AIza…", where: "aistudio.google.com" },
  { id: "openai", name: "OpenAI", placeholder: "sk-…", where: "platform.openai.com" },
  { id: "openrouter", name: "OpenRouter", placeholder: "sk-or-…", where: "openrouter.ai/keys" },
];

export function chatProvidersSection(
  present: Record<string, boolean>,
  keyChanged: (key: string, on: boolean) => void,
): HTMLElement {
  const list = h("div", {});
  for (const def of CLOUD) {
    const p = providerDef(def.id);
    const key = p.key!;
    const input = h("input", {
      type: "password",
      placeholder: present[key] ? CHAT_STRINGS.stored : def.placeholder,
      autocomplete: "off",
      spellcheck: "false",
      style: "flex:1 1 auto;min-width:0",
    }) as HTMLInputElement;
    const dotEl = statusDot(present[key] ?? false);
    const saveBtn = h("button", { text: CHAT_STRINGS.save });
    const removeBtn = h("button", { class: "danger", text: CHAT_STRINGS.remove });
    const refresh = () => {
      input.placeholder = present[key] ? CHAT_STRINGS.stored : def.placeholder;
      dotEl.style.background = present[key] ? "#22c55e" : "#f4505e";
      removeBtn.style.display = present[key] ? "" : "none";
    };
    saveBtn.addEventListener("click", async () => {
      const value = input.value.trim();
      if (!value) return;
      try {
        await Bridge.secretSet(key, value);
        present[key] = true;
        input.value = "";
        keyChanged(key, true);
      } catch {
        dotEl.style.background = "#f5a524";
        return;
      }
      refresh();
    });
    removeBtn.addEventListener("click", async () => {
      try {
        await Bridge.secretClear(key);
        present[key] = false;
        keyChanged(key, false);
      } catch {
        dotEl.style.background = "#f5a524";
        return;
      }
      refresh();
    });
    refresh();
    list.append(
      wideSetting(h("span", { class: "with-dot" }, accentDot(p.accent), def.name, dotEl),
        t("Key from {site}", { site: def.where }),
        input, saveBtn, removeBtn),
    );
  }
  return h(
    "section",
    {},
    ...sectionHead(CHAT_STRINGS.providersTitle, CHAT_STRINGS.providersHint),
    ...list.children,
  );
}

// ── Chat names ────────────────────────────────────────────────────────────────

/**
 * Who names the chats: their own AI once the first answer is in
 * (chat_title.rs), with the provider's lightest model or the chat's; off,
 * the start of the first question, as before. On by default.
 */
export function chatNamesSection(): HTMLElement {
  const model = select(
    [["light", t("The provider's lightest")], ["chat", t("The chat's own")]],
    settings.chatTitleModel === "chat" ? "chat" : "light",
    (v) => {
      settings.chatTitleModel = v === "chat" ? "chat" : "light";
      void save();
    },
  );
  model.disabled = settings.chatAiTitles === false;
  return h(
    "section",
    {},
    ...sectionHead(t("Chat names")),
    setting(t("The AI names the chats"),
      t("After the first answer, the chat's AI picks a name of a few words. Off, the name is the start of the first question, as before. A chat you rename yourself keeps its name."),
      toggle(settings.chatAiTitles !== false, (on) => {
        settings.chatAiTitles = on;
        model.disabled = !on;
        void save();
      }),
    ),
    setting(t("Model for names"), t("Only the chat's provider is asked."), model),
  );
}

// ── Remaining usage in the chat ───────────────────────────────────────────────

/** The quiet line next to the chat's model picker (core/chat-usage.ts). Off until turned on. */
export function chatUsageSection(): HTMLElement {
  return h(
    "section",
    {},
    ...sectionHead(t("Remaining usage")),
    setting(t("Show remaining usage in the chat"),
      t("A ring next to the past chats shows how much the provider in use has used; a click shows each limit and when it resets. For Claude Code it needs the relay from {path}. Nothing is shown for Google or the local models.", { path: `${t("Agents")} → ${t("Plan usage")}` }),
      toggle(settings.chatShowUsage, (on) => {
        settings.chatShowUsage = on;
        void save();
      }),
    ),
  );
}
