// Settings → Local models → Maya (maya-inkling-mini, maya.rs): the folder it
// was built in, which of its configurations Lumo writes (the graphics card,
// the context, vision, the drafter), and Lumo starting and stopping it the
// way it does Unsloth Studio. Maya is asked only while this is on screen.

import { Bridge, MAYA_EVENT, onEvent, type MayaInstall, type MayaServer } from "../core/bridge";
import { providerDef } from "../core/providers";
import { N_, t } from "../i18n/i18n";
import { h, clear } from "../views/dom";
import { accentDot, errorText, setting, statusDot, wideSetting } from "./parts";
import { save, select, settings, toggle } from "./store";
import { CHAT_STRINGS } from "./sections/chat";

const STRINGS = {
  folderHint: N_("The maya-inkling-mini folder, already built as its guide says: Lumo finds the engine, the model and the tokenizer in it. It installs and downloads nothing itself."),
  folderPlaceholder: N_("The maya-inkling-mini folder"),
  choose: N_("Choose…"),
  autoStart: N_("Start and stop it by itself"),
  autoStartHint: N_("When you pick it in the chat, Lumo starts Maya in the background, with no terminal window."),
  card: N_("Graphics card"),
  cardHint: N_("Which of Maya's configurations Lumo writes. Below 24 GB the experts stay in the computer's memory (about 15 GB of it) with a cache on the card."),
  card24: N_("24 GB or more: everything on the card"),
  context: N_("Context"),
  contextHint: N_("More context leaves less of the card's memory for the experts, so answers come a little slower."),
  contextSmall: N_("{size} · about {speed} tok/s"),
  vision: N_("Images"),
  visionHint: N_("Maya reads pictures with its image encoder, on the processor: it takes nothing from the card, and a new picture takes a few seconds."),
  visionMissing: N_("The image encoder isn't built, or mmproj-BF16.gguf isn't in the models folder."),
  drafter: N_("Drafter"),
  drafterHint: N_("Thinking Machines' drafter guesses the next words: code and edits come up to 1.5 times faster. It takes about 1 GB of the card's memory."),
  drafterMissing: N_("Its weights aren't there: mtp.safetensors goes in the models folder."),
  drafterSmallCard: N_("On a card under 24 GB the drafter slows Maya down: checking its guesses runs more experts on the processor."),
  stopAfter: N_("Stop after"),
  stopAfterHint: N_("Only if Lumo started it: a Maya you started yourself stays on."),
  minutes5: N_("5 minutes with no question"),
  minutes15: N_("15 minutes with no question"),
  hour: N_("1 hour with no question"),
  exit: N_("When Lumo quits"),
  never: N_("Never"),
  inMemory: N_("In memory"),
  checking: N_("Checking…"),
  off: N_("Off: it starts when you use it in the chat."),
  offPlain: N_("Off."),
  starting: N_("Starting Maya…"),
  seconds: N_("{seconds} s"),
  loaded: N_("{model} · context {size}"),
  ownedAfter: N_("Started by Lumo: it stops after {minutes} minutes with no question."),
  ownedExit: N_("Started by Lumo: it stops when Lumo quits."),
  ownedNever: N_("Started by Lumo: it stays on."),
  theirs: N_("On: started outside Lumo, so Lumo leaves it as it is."),
  outdated: N_("Started with other settings: they apply when it starts again."),
  start: N_("Start now"),
  stop: N_("Stop now"),
  restart: N_("Restart now"),
};

/** Maya's one model. */
const MODEL = "inkling-2-mini";

/** "16K", "262K": a context as people say it. */
function size(tokens: number): string {
  return `${Math.round(tokens / 1024)}K`;
}

const fullCard = () => !["8", "12", "16"].includes(settings.mayaVram);

/** The contexts offered, as maya.rs context() takes them. */
function contexts(): [number, string][] {
  if (!fullCard()) {
    // The guide's numbers on an 8 GB card (RTX 5070 Laptop): a bigger card's cache does better.
    return [[16_384, "41"], [32_768, "36"], [65_536, "32"]].map(([n, speed]) => [n as number, t(STRINGS.contextSmall, { size: size(n as number), speed })]);
  }
  const all = [32_768, 65_536, 131_072, 262_144, ...(settings.mayaDrafter ? [] : [344_064])];
  return all.map((n) => [n, size(n)]);
}

/** The context picked, within what the card takes (maya.rs context). */
function pickedContext(): number {
  const offered = contexts().map(([n]) => n);
  const max = offered[offered.length - 1];
  const picked = settings.mayaContext || (fullCard() ? max : 16_384);
  return offered.find((n) => n >= Math.min(picked, max)) ?? max;
}

/** Maya's block under Unsloth Studio: its folder, or once connected its settings and state. */
export function mayaBlock(redrawAll: () => void): HTMLElement {
  const p = providerDef("maya");
  const block = h("div", { class: "setting-block engine" });
  const label = () => h("span", { class: "with-dot" }, accentDot(p.accent), "Maya · Inkling 2 Mini");

  if (!settings.mayaUrl) {
    const input = h("input", {
      type: "text",
      placeholder: t(STRINGS.folderPlaceholder),
      style: "flex:1 1 auto;min-width:0",
      spellcheck: "false",
      autocomplete: "off",
    }) as HTMLInputElement;
    input.value = settings.mayaDir;
    const choose = h("button", { text: t(STRINGS.choose) }) as HTMLButtonElement;
    const connect = h("button", { class: "primary", text: CHAT_STRINGS.connect }) as HTMLButtonElement;
    const status = h("div", {});
    choose.addEventListener("click", async () => {
      const dir = await Bridge.pickFolder();
      if (dir) input.value = dir;
    });
    connect.addEventListener("click", async () => {
      connect.disabled = true;
      clear(status);
      try {
        const server = await Bridge.localConnect("maya", input.value.trim());
        settings.mayaDir = input.value.trim();
        settings.mayaUrl = server.url;
        settings.chatModels = { ...settings.chatModels, maya: server.models[0] ?? MODEL };
        await save();
        redrawAll();
        return;
      } catch (err) {
        status.append(h("div", { class: "notice err", text: errorText(err) }));
      }
      connect.disabled = false;
    });
    block.append(wideSetting(label(), null, input, choose, connect), status, h("div", { class: "hint", text: t(STRINGS.folderHint) }));
    return block;
  }

  // ── Connected ──
  const inUse = settings.chatProvider === "maya";
  const use = h("button", { class: inUse ? "" : "primary", text: inUse ? CHAT_STRINGS.inUse : CHAT_STRINGS.useInChat }) as HTMLButtonElement;
  use.disabled = inUse;
  use.addEventListener("click", () => {
    settings.chatProvider = "maya";
    settings.chatModels = { ...settings.chatModels, maya: MODEL };
    void save().then(redrawAll);
  });
  const disconnect = h("button", { class: "danger", text: CHAT_STRINGS.disconnect });
  disconnect.addEventListener("click", async () => {
    await Bridge.mayaStop().catch(() => false);
    settings.mayaUrl = "";
    if (settings.chatProvider === "maya") settings.chatProvider = "anthropic";
    await save();
    redrawAll();
  });
  const missing = h("div", {});
  // Green once connected; red when the folder no longer holds what the server needs.
  const dot = statusDot(true);
  block.append(
    setting(h("span", { class: "with-dot" }, label(), dot), h("span", { class: "path", text: settings.mayaDir }), use, disconnect),
    missing,
    h("div", { class: "hint", text: CHAT_STRINGS.localOnly }),
  );

  const options = h("div", {});
  const memory = h("div", {});
  block.append(h("div", { class: "engine-options" }, options, memory));
  let install: MayaInstall | null = null;

  /** A change that the next start of Maya takes: saved, the rows drawn again, the state asked again. */
  const changed = () => void save().then(() => { drawOptions(); void refresh(); });

  function drawOptions() {
    clear(options);
    // Without its files a switch is off and can't be turned on: Lumo leaves it out of the config (maya.rs config).
    const visionMissing = install !== null && !install.vision;
    const drafterMissing = install !== null && !install.drafter;
    // On a smaller card the drafter is left out too (maya.rs config): its checks run more experts on the processor.
    const drafterOff = drafterMissing || !fullCard();
    const vision = toggle(settings.mayaVision && !visionMissing, (on) => { settings.mayaVision = on; changed(); });
    const drafter = toggle(settings.mayaDrafter && !drafterOff, (on) => { settings.mayaDrafter = on; changed(); });
    (vision as HTMLButtonElement).disabled = visionMissing;
    (drafter as HTMLButtonElement).disabled = drafterOff;
    options.append(
      setting(t(STRINGS.autoStart), t(STRINGS.autoStartHint),
        toggle(settings.mayaAutoStart !== false, (on) => { settings.mayaAutoStart = on; void save().then(() => void refresh()); })),
      setting(t(STRINGS.card), t(STRINGS.cardHint),
        select([["24", t(STRINGS.card24)], ["16", "16 GB"], ["12", "12 GB"], ["8", "8 GB"]],
          fullCard() ? "24" : settings.mayaVram, (v) => { settings.mayaVram = v; settings.mayaContext = 0; changed(); })),
      setting(t(STRINGS.context), t(STRINGS.contextHint),
        select(contexts().map(([n, text]) => [String(n), text]), String(pickedContext()), (v) => { settings.mayaContext = Number(v); changed(); })),
      setting(t(STRINGS.vision), t(visionMissing ? STRINGS.visionMissing : STRINGS.visionHint), vision),
      setting(t(STRINGS.drafter), t(drafterMissing ? STRINGS.drafterMissing : fullCard() ? STRINGS.drafterHint : STRINGS.drafterSmallCard), drafter),
      setting(t(STRINGS.stopAfter), t(STRINGS.stopAfterHint),
        select([
          ["5", t(STRINGS.minutes5)],
          ["15", t(STRINGS.minutes15)],
          ["60", t(STRINGS.hour)],
          ["exit", t(STRINGS.exit)],
          ["never", t(STRINGS.never)],
        ], settings.mayaStopAfter || "15", (v) => { settings.mayaStopAfter = v; void save(); })),
    );
  }

  // ── In memory ──
  const line = h("span", { class: "setting-hint", text: t(STRINGS.checking) });
  const startNow = h("button", { text: t(STRINGS.start) }) as HTMLButtonElement;
  const restart = h("button", { text: t(STRINGS.restart) }) as HTMLButtonElement;
  const stopNow = h("button", { class: "danger", text: t(STRINGS.stop) }) as HTMLButtonElement;
  const below = h("div", {});
  memory.append(setting(t(STRINGS.inMemory), line, startNow, restart, stopNow), below);
  const buttons = (shown: HTMLButtonElement[]) => {
    for (const b of [startNow, restart, stopNow]) {
      b.hidden = !shown.includes(b);
      b.disabled = false;
    }
  };

  function drawStarting(s: MayaServer) {
    drawing++;
    clear(below);
    line.textContent = "";
    buttons([]);
    below.append(
      h("div", { class: "row" },
        h("span", { class: "hint", text: t(STRINGS.starting) }),
        h("span", { class: "spacer" }),
        h("span", { class: "hint", text: s.seconds >= 2 ? t(STRINGS.seconds, { seconds: s.seconds }) : "" }),
      ),
      h("div", { class: "progress busy" }, h("i", {})),
    );
  }

  // Draws can overlap (the first refresh, a click's and the event's): only
  // the latest one writes, and it clears after its wait, so the row is never
  // drawn twice.
  let drawing = 0;
  async function draw(s: MayaServer | null) {
    const mine = ++drawing;
    if (!s) return;
    if (s.state === "starting") {
      drawStarting(s);
      return;
    }
    if (s.state === "off") {
      clear(below);
      line.textContent = t(settings.mayaAutoStart !== false ? STRINGS.off : STRINGS.offPlain);
      buttons(install?.ready === false ? [] : [startNow]);
      return;
    }
    const caps = await Bridge.localCaps("maya", MODEL).catch(() => null);
    if (mine !== drawing) return;
    clear(below);
    line.textContent = caps?.loadedContext ? t(STRINGS.loaded, { model: MODEL, size: size(caps.loadedContext) }) : MODEL;
    if (!s.owned) {
      below.append(h("div", { class: "hint", text: t(STRINGS.theirs) }));
      buttons([]);
      return;
    }
    const after = settings.mayaStopAfter || "15";
    below.append(h("div", { class: "hint", text: after === "exit" ? t(STRINGS.ownedExit) : after === "never" ? t(STRINGS.ownedNever) : t(STRINGS.ownedAfter, { minutes: after }) }));
    if (s.outdated) below.append(h("div", { class: "notice warn", text: t(STRINGS.outdated) }));
    buttons(s.outdated ? [restart, stopNow] : [stopNow]);
  }

  async function refresh() {
    await draw(await Bridge.mayaStatus());
  }

  const begin = async (b: HTMLButtonElement) => {
    b.disabled = true;
    try {
      await Bridge.mayaStart();
    } catch (err) {
      await refresh();
      below.append(h("div", { class: "notice err", text: errorText(err) }));
      return;
    }
    await refresh();
  };
  startNow.addEventListener("click", () => void begin(startNow));
  restart.addEventListener("click", async () => {
    restart.disabled = true;
    await Bridge.mayaStop().catch(() => false);
    await begin(restart);
  });
  stopNow.addEventListener("click", async () => {
    stopNow.disabled = true;
    await Bridge.mayaStop().catch(() => false);
    await refresh();
  });

  listen();
  shown = (s) => {
    if (!block.isConnected) return;
    if (s.state === "starting") drawStarting(s);
    else void refresh();
  };
  buttons([]);
  drawOptions();
  void Bridge.mayaInstall("").then((found) => {
    install = found;
    if (found && !found.ready) {
      missing.append(h("div", { class: "notice err", text: found.missing }));
      dot.replaceWith(statusDot(false));
    }
    drawOptions();
    void refresh();
  });
  return block;
}

/** The Maya block on screen, told each step of a start or a stop. */
let shown: ((s: MayaServer) => void) | null = null;
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  void onEvent<MayaServer>(MAYA_EVENT, (s) => shown?.(s));
}
