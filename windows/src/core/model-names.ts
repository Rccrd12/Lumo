// The names of Claude Code's and the Antigravity CLI's models as people say
// them: "Opus 5.5", "Gemini 4 Hydrogen", not the ids the CLIs take
// (`claude-opus-5-5`, `gemini-4-hydrogen`). The ids still go to the CLIs, and
// show on hover in the picker.

import { t } from "../i18n/i18n";

/** Words written in capitals. */
const ACRONYMS = new Set(["gpt", "oss", "ai", "xl"]);

/** The CLIs whose models are named here (providers.ts ids). */
const CLAUDE_CODE = "claude-code";
const AGY = "antigravity-cli";

/**
 * `id` as a name: its words capitalised, a version's parts joined by dots
 * ("5-5" → "5.5"), a date at its end left out; Claude Code's own "claude-"
 * too (`dropVendor`), since all its models are Claude's. A name already
 * written for people (capitals or spaces) stays as it is.
 */
export function prettyModel(id: string, dropVendor = false): string {
  if (!id || /[A-Z\s]/.test(id)) return id;
  let rest = id;
  // Claude Code's "[1m]": the model with a million tokens of context.
  let context = "";
  const window = /\[(\d+)([km])\]$/i.exec(rest);
  if (window) {
    context = ` ${window[1]}${window[2].toUpperCase()}`;
    rest = rest.slice(0, window.index);
  }
  const parts = rest.split("-").filter(Boolean);
  if (dropVendor && parts.length > 1 && parts[0] === "claude") parts.shift();
  while (parts.length > 1 && /^\d{8}$/.test(parts[parts.length - 1])) parts.pop();
  const words: string[] = [];
  for (const part of parts) {
    const prev = words[words.length - 1];
    // A version's next part: "5" after "5" is "5.5".
    if (/^\d{1,2}$/.test(part) && prev != null && /^\d+(\.\d+)*$/.test(prev)) {
      words[words.length - 1] = `${prev}.${part}`;
      continue;
    }
    words.push(ACRONYMS.has(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1));
  }
  return words.join(" ") + context;
}

/**
 * What the model button says for `model` of `provider`: the name the CLI's
 * list gave it (`listed`) when that is a name, else its id written as a name.
 * Other providers' models keep the names they have.
 */
export function cliModelName(provider: string, model: string, listed?: string): string {
  // Unsloth Studio's model with its version ("unsloth/Inkling-2-Mini-GGUF:UD-Q3_K_XL"):
  // as the picker's list says it, without whose it is ("Inkling-2-Mini-GGUF · UD-Q3_K_XL").
  if (provider === "unsloth") {
    const [repo, quant] = model.split(/:(?=[^:/]+$)/);
    return quant ? `${repo.slice(repo.lastIndexOf("/") + 1)} · ${quant}` : model;
  }
  if (provider !== CLAUDE_CODE && provider !== AGY) return model;
  if (listed && listed !== model) return listed;
  if (model === "default") return t("Default");
  return prettyModel(model, provider === CLAUDE_CODE);
}
