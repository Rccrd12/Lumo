// Settings → Gemini Live: the Google AI key, the model, its thinking, its
// voice, whether it may look at the screen, and who takes what it can't do.

import { Bridge, type ModelInfo, type ShortcutsReport } from "../../core/bridge";
import { effortFor, effortsFor, providerDef } from "../../core/providers";
import { SHORTCUTS, displayKeys, effective } from "../../core/shortcuts";
import { h, clear } from "../../views/dom";
import { accentDot, sectionHead, setting, statusDot, wideSetting } from "../parts";
import { LIVE_EXTENDED, LIVE_MODEL, THINKING_LEVELS, VOICES, parseLiveModel, parseThinking, parseVoice } from "../../live/protocol";
import { VOICE_SETTINGS } from "../../live/strings";
import { N_, t } from "../../i18n/i18n";
import { CHAT_STRINGS } from "./chat";
import { MORE_MODELS } from "./claude";
import { rerender, save, select, settings, toggle } from "../store";

// ── Voice: Gemini Live ────────────────────────────────────────────────────────

const THINKING_NAMES: Record<string, string> = { low: N_("Low"), medium: N_("Medium"), high: N_("High") };
/** Claude Code's effort levels, as the chat's picker names them. */
const EFFORT_NAMES: Record<string, string> = {
  low: N_("Low"), medium: N_("Medium"), high: N_("High"), xhigh: N_("Extra high"), max: N_("Max"),
};

/**
 * Gemini Live (src/live): the Google AI key (the same one as the chat's), the
 * model, its thinking, its voice, whether it may look at the screen, and who
 * takes what it can't do.
 */
export function voiceSection(
  present: Record<string, boolean>,
  keyChanged: (key: string, on: boolean) => void,
  shortcuts: ShortcutsReport | null,
): HTMLElement {
  const key = providerDef("google").key!;
  const input = h("input", {
    type: "password", autocomplete: "off", spellcheck: "false", style: "flex:1 1 auto;min-width:0",
  }) as HTMLInputElement;
  const dotEl = statusDot(present[key] ?? false);
  const saveBtn = h("button", { text: CHAT_STRINGS.save });
  const removeBtn = h("button", { class: "danger", text: CHAT_STRINGS.remove });
  const refresh = () => {
    input.placeholder = present[key] ? CHAT_STRINGS.stored : "AIza…";
    dotEl.style.background = present[key] ? "#22c55e" : "#f4505e";
    removeBtn.style.display = present[key] ? "" : "none";
  };
  saveBtn.addEventListener("click", async () => {
    const value = input.value.trim();
    if (!value) return;
    try {
      await Bridge.secretSet(key, value);
    } catch {
      dotEl.style.background = "#f5a524";
      return;
    }
    present[key] = true;
    input.value = "";
    keyChanged(key, true);
    // The chat's own Google AI row shows it too, on the next draw.
    void rerender();
  });
  removeBtn.addEventListener("click", async () => {
    try {
      await Bridge.secretClear(key);
    } catch {
      dotEl.style.background = "#f5a524";
      return;
    }
    present[key] = false;
    keyChanged(key, false);
    void rerender();
  });
  refresh();

  const model = parseLiveModel(settings.liveModel);
  const thinkingRow = setting(t(VOICE_SETTINGS.thinking), t(VOICE_SETTINGS.thinkingHint),
    select(THINKING_LEVELS.map((l) => [l, t(THINKING_NAMES[l])]), parseThinking(settings.liveThinking), (v) => {
      settings.liveThinking = v;
      void save();
    }),
  );
  const showThinking = (m: string) => {
    thinkingRow.hidden = m !== LIVE_EXTENDED;
  };
  showThinking(model);

  const { modelRow: helperModelRow, problem: helperProblem, effortRow: helperEffortRow, draw: drawHelper } = helperChoices();
  drawHelper();

  const def = SHORTCUTS.find((s) => s.id === "talkToGemini");
  const binding = shortcuts && def ? effective(def, settings.shortcuts) : null;
  const keys = displayKeys(binding?.keys ?? def?.defaultKeys ?? "Ctrl+Alt+L");

  return h(
    "section",
    {},
    ...sectionHead("Gemini Live", t(VOICE_SETTINGS.hint, { keys }), accentDot("#22d3ee")),
    wideSetting(h("span", { class: "with-dot" }, t(VOICE_SETTINGS.key), dotEl),
      t("Key from {site}", { site: "aistudio.google.com" }),
      input, saveBtn, removeBtn),
    setting(t(VOICE_SETTINGS.model), null,
      select([[LIVE_MODEL, "Gemini 3.8 Live"], [LIVE_EXTENDED, "Gemini 3.8 Live Extended Thinking"]], model, (v) => {
        settings.liveModel = v;
        showThinking(v);
        void save();
      }),
    ),
    thinkingRow,
    setting(t(VOICE_SETTINGS.voice), null,
      select([["", t(VOICE_SETTINGS.automatic)], ...VOICES.map((v): [string, string] => [v, v])], parseVoice(settings.liveVoice), (v) => {
        settings.liveVoice = v;
        void save();
      }),
    ),
    setting(t(VOICE_SETTINGS.screen), t(VOICE_SETTINGS.screenHint),
      toggle(settings.liveScreen, (on) => {
        settings.liveScreen = on;
        void save();
      }),
    ),
    setting(t(VOICE_SETTINGS.helper), t(VOICE_SETTINGS.helperHint),
      select([["claude-code", "Claude Code"], ["antigravity-cli", "Antigravity CLI"]], helperId(), (v) => {
        settings.liveHelper = v;
        // Each helper has its own models: the new one starts on its own choice.
        settings.liveHelperModel = "default";
        void save();
        drawHelper();
      }),
    ),
    helperModelRow,
    helperProblem,
    helperEffortRow,
  );
}

const helperId = () => (settings.liveHelper === "antigravity-cli" ? "antigravity-cli" : "claude-code");

/**
 * The helper's model and effort (Settings → Voice): the models the chat's
 * picker offers for that helper, asked only when this page is drawn (agy
 * lists its own); the effort for Claude Code only, as in the chat.
 */
function helperChoices(): { modelRow: HTMLElement; problem: HTMLElement; effortRow: HTMLElement; draw: () => void } {
  const models = h("select", {}) as HTMLSelectElement;
  const efforts = h("select", {}) as HTMLSelectElement;
  const modelRow = setting(t(VOICE_SETTINGS.helperModel), null, models);
  const effortRow = setting(t(VOICE_SETTINGS.helperEffort), null, efforts);
  const problem = h("div", { class: "notice warn" });
  models.addEventListener("change", () => {
    settings.liveHelperModel = models.value;
    void save();
  });
  efforts.addEventListener("change", () => {
    settings.liveHelperEffort = efforts.value;
    void save();
  });
  let ticket = 0;

  const fill = (list: ModelInfo[]) => {
    clear(models);
    const saved = settings.liveHelperModel || "default";
    const all = list.some((m) => m.id === saved) ? list : [...list, { id: saved, label: saved }];
    for (const m of all.filter((m) => !m.older)) models.append(h("option", { value: m.id, text: m.id === "default" ? t("Default") : m.label }));
    // Claude Code's older versions apart, as in the chat's "More models".
    const older = all.filter((m) => m.older);
    if (older.length) {
      const group = h("optgroup", { label: t(MORE_MODELS, { count: older.length }) });
      for (const m of older) group.append(h("option", { value: m.id, text: m.label }));
      models.append(group);
    }
    models.value = saved;
  };

  const draw = () => {
    const id = helperId();
    const mine = ++ticket;
    problem.hidden = true;
    fill([{ id: "default", label: t("Default") }]);
    models.disabled = true;
    void Bridge.chatModels(id).then(
      (list) => {
        if (mine !== ticket) return;
        models.disabled = false;
        fill(list.length ? list : [{ id: "default", label: t("Default") }]);
      },
      (err) => {
        if (mine !== ticket) return;
        models.disabled = false;
        problem.textContent = String(err).replace(/^Error:\s*/, "");
        problem.hidden = false;
      },
    );
    const levels = effortsFor(id);
    effortRow.hidden = levels.length === 0;
    clear(efforts);
    for (const e of levels) efforts.append(h("option", { value: e, text: e ? t(EFFORT_NAMES[e] ?? e) : t("Auto") }));
    efforts.value = effortFor(id, settings.liveHelperEffort);
  };
  return { modelRow, problem, effortRow, draw };
}
