// Settings → Local models, under a connected Ollama or LM Studio: the model it
// holds in memory, Free memory to unload it with one click, and Download a
// model with its progress (local_models.rs). The server is asked only while
// this is on screen, never in the background.

import { Bridge, onEvent, type LocalLoaded, type LocalPull } from "../core/bridge";
import { formatSize } from "../core/screen";
import { N_, t } from "../i18n/i18n";
import { h, clear } from "../views/dom";
import { errorText, setting, wideSetting } from "./parts";

export type ModelServerId = "ollama" | "lmstudio";

const STRINGS = {
  inMemory: N_("In memory"),
  checking: N_("Checking…"),
  none: N_("No model in memory."),
  free: N_("Free memory"),
  download: N_("Download a model"),
  downloadButton: N_("Download"),
  ollamaHint: N_("Its name as Ollama writes it, such as llama3.2 or qwen3:8b."),
  lmstudioHint: N_("Its name in LM Studio's catalog, such as openai/gpt-oss-20b, or a Hugging Face link."),
  downloading: N_("Downloading {model}…"),
  downloaded: N_("{model} is downloaded."),
};

/** A download under way, by server: it goes on while Settings redraws. */
const running = new Map<ModelServerId, LocalPull>();
/** How the last download ended, by server: shown until the next one starts. */
const ended = new Map<ModelServerId, { ok: boolean; text: string }>();
/** The block on screen for each server, told about each step. */
const shown = new Map<ModelServerId, () => void>();
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  void onEvent<LocalPull>("local-pull", (p) => {
    const id = p.provider as ModelServerId;
    if (!running.has(id)) return;
    running.set(id, p);
    shown.get(id)?.();
  });
}

/** "llama3.2:3b · 3.2 GB": what is in memory, one model after the other. */
export function loadedText(models: readonly LocalLoaded[]): string {
  if (!models.length) return t(STRINGS.none);
  return models.map((m) => (m.size > 0 ? `${m.name} · ${formatSize(m.size)}` : m.name)).join(", ");
}

/** How far a download is, 0 to 100; null while its size is not known. */
export function pullPercent(p: Pick<LocalPull, "completed" | "total">): number | null {
  return p.total > 0 ? Math.min(100, Math.floor((p.completed / p.total) * 100)) : null;
}

/** The memory and download rows of a connected Ollama or LM Studio. */
export function localModelsBlock(id: ModelServerId): HTMLElement {
  listen();
  const block = h("div", {});

  // ── In memory ──
  const memory = h("span", { class: "setting-hint", text: t(STRINGS.checking) });
  const free = h("button", { text: t(STRINGS.free) }) as HTMLButtonElement;
  free.disabled = true;
  const memoryStatus = h("div", {});
  const refresh = async () => {
    clear(memoryStatus);
    try {
      const models = await Bridge.localLoaded(id);
      memory.textContent = loadedText(models);
      free.disabled = models.length === 0;
    } catch (err) {
      memory.textContent = "";
      free.disabled = true;
      memoryStatus.append(h("div", { class: "notice err", text: errorText(err) }));
    }
  };
  free.addEventListener("click", async () => {
    free.disabled = true;
    clear(memoryStatus);
    try {
      await Bridge.localUnload(id);
    } catch (err) {
      memoryStatus.append(h("div", { class: "notice err", text: errorText(err) }));
    }
    await refresh();
  });
  const memoryRow = setting(t(STRINGS.inMemory), memory, free);

  // ── Download a model ──
  const input = h("input", {
    type: "text",
    placeholder: id === "ollama" ? "llama3.2" : "openai/gpt-oss-20b",
    style: "flex:1 1 auto;min-width:0",
    spellcheck: "false",
    autocomplete: "off",
  }) as HTMLInputElement;
  const start = h("button", { class: "primary", text: t(STRINGS.downloadButton) }) as HTMLButtonElement;
  const progress = h("div", {});
  const drawProgress = () => {
    clear(progress);
    const p = running.get(id);
    start.disabled = Boolean(p);
    if (!p) {
      const end = ended.get(id);
      if (end) progress.append(h("div", { class: end.ok ? "notice ok" : "notice err", text: end.text }));
      return;
    }
    const pct = pullPercent(p);
    progress.append(
      h("div", { class: "row" },
        h("span", { class: "hint", text: t(STRINGS.downloading, { model: p.model }) }),
        h("span", { class: "spacer" }),
        h("span", { class: "hint", text: pct === null ? "" : `${pct}% · ${formatSize(p.total)}` }),
      ),
      h("div", { class: pct === null ? "progress busy" : "progress" }, h("i", { style: pct === null ? "" : `width:${pct}%` })),
    );
  };
  const download = async () => {
    const model = input.value.trim();
    if (!model || running.has(id)) return;
    ended.delete(id);
    running.set(id, { provider: id, model, completed: 0, total: 0 });
    drawProgress();
    try {
      await Bridge.localPull(id, model);
      input.value = "";
      ended.set(id, { ok: true, text: t(STRINGS.downloaded, { model }) });
    } catch (err) {
      ended.set(id, { ok: false, text: errorText(err) });
    }
    running.delete(id);
    // The block on screen now, should Settings have redrawn meanwhile.
    shown.get(id)?.();
  };
  start.addEventListener("click", () => void download());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void download();
  });
  const hint = t(id === "ollama" ? STRINGS.ollamaHint : STRINGS.lmstudioHint);
  const downloadRow = wideSetting(t(STRINGS.download), hint, input, start);

  shown.set(id, drawProgress);
  drawProgress();
  void refresh();
  block.append(memoryRow, memoryStatus, downloadRow, progress);
  return block;
}
