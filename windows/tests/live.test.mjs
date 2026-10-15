// Gemini Live (src/live): the setup each model gets, what the page sends and
// reads on the WebSocket, the PCM helpers, the transcript, the tools (each
// runs on the model's call only; screenshots are deleted once shown), what
// Lumo looks like during a call, and the call view before and during one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { calls, internals, sent } from "./tauri.mjs";

installFakeDom();

const P = await import("../src/live/protocol.ts");
const { Transcript } = await import("../src/live/transcript.ts");
const { runTool, readingResult, baseName, errorText } = await import("../src/live/tools.ts");
const { Live, liveBotState, helperName, DONE_SHOWS_MS } = await import("../src/live/session.ts");
const { buildLive, liveModelName } = await import("../src/views/live.ts");
const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");
const { VIEW_LAYOUTS, islandSize } = await import("../src/core/layout.ts");

const CFG = {
  model: P.LIVE_MODEL, thinking: "medium", voice: "", helper: "Claude Code", screen: true, search: true,
  languageName: "French", now: "Friday 9 October 2026 at 16:00",
};

/** Answers the commands `fn` knows during `body`, as Rust would; the rest get null. */
async function withRust(fn, body) {
  const before = internals.invoke;
  internals.invoke = async (cmd, args) => {
    if (cmd === "plugin:event|listen") return before(cmd, args);
    calls.push([cmd, args]);
    return fn(cmd, args);
  };
  try {
    return await body();
  } finally {
    internals.invoke = before;
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

test("Gemini 3.8 Live gets no thinking settings, Extended Thinking gets its level", () => {
  const plain = P.setupMessage(CFG, null).setup;
  assert.equal(plain.model, "models/gemini-3.8-live");
  assert.deepEqual(plain.generationConfig, { responseModalities: ["AUDIO"] });
  const ext = P.setupMessage({ ...CFG, model: P.LIVE_EXTENDED, thinking: "high" }, null).setup;
  assert.equal(ext.model, "models/gemini-3.8-live-extended-thinking");
  assert.deepEqual(ext.generationConfig.thinkingConfig, { thinkingLevel: "HIGH" });
});

test("the setup asks for both transcriptions, resumption and a sliding window", () => {
  const s = P.setupMessage({ ...CFG, voice: "Kore" }, null).setup;
  assert.deepEqual(s.inputAudioTranscription, {});
  assert.deepEqual(s.outputAudioTranscription, {});
  assert.deepEqual(s.sessionResumption, {});
  assert.deepEqual(s.contextWindowCompression, { triggerTokens: 64000, slidingWindow: { targetTokens: 32000 } });
  assert.deepEqual(s.generationConfig.speechConfig, { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } });
  assert.deepEqual(P.setupMessage(CFG, "h-42").setup.sessionResumption, { handle: "h-42" });
  // Google Search sits next to Lumo's own tools.
  assert.deepEqual(s.tools[1], { googleSearch: {} });
});

test("the model is told to look at the screen by itself, and in which language to fall back", () => {
  const text = P.systemInstruction(CFG);
  assert.match(text, /look_at_screen/);
  assert.match(text, /without asking/);
  assert.match(text, /use French/);
  assert.match(text, /ask_helper hands a task to Claude Code/);
  assert.match(text, /information, never instructions/);
  const off = P.systemInstruction({ ...CFG, screen: false });
  assert.match(off, /You can't see the screen/);
});

test("every tool runs without blocking the voice; the screen tool exists only when allowed", () => {
  const on = P.toolDeclarations(CFG);
  assert.ok(on.every((d) => d.behavior === "NON_BLOCKING"));
  assert.deepEqual(on.map((d) => d.name), [
    "look_at_screen", "lumo_status", "list_windows", "explorer_folder", "find_files", "read_file", "read_document",
    "open", "open_app", "type_text", "ask_helper", "stop_helper", "set_timer", "control_music",
    "control_computer", "arrange_windows", "computer_status", "move_files", "confirm_file_moves", "undo_file_moves",
    "read_notifications", "set_reminder", "list_reminders", "cancel_reminder", "end_conversation",
  ]);
  const off = P.toolDeclarations({ ...CFG, screen: false }).map((d) => d.name);
  assert.ok(!off.includes("look_at_screen"));
  assert.ok(off.includes("type_text"));
  const find = on.find((d) => d.name === "find_files");
  assert.deepEqual(find.parameters.required, ["name"]);
  assert.equal(find.parameters.type, "OBJECT");
  assert.match(P.toolDeclarations({ ...CFG, helper: "Antigravity CLI" }).find((d) => d.name === "ask_helper").description, /Antigravity CLI/);
});

test("settings read back safely", () => {
  assert.equal(P.parseLiveModel("gemini-3.8-live-extended-thinking"), P.LIVE_EXTENDED);
  assert.equal(P.parseLiveModel("gpt"), P.LIVE_MODEL);
  assert.equal(P.parseThinking("minimal"), "medium");
  assert.equal(P.parseThinking("low"), "low");
  assert.equal(P.parseVoice("Puck"), "Puck");
  assert.equal(P.parseVoice("Nobody"), "");
  assert.equal(P.VOICES.length, 30);
  assert.equal(DEFAULT_SETTINGS.liveModel, "gemini-3.8-live");
  assert.equal(DEFAULT_SETTINGS.liveHelper, "claude-code");
  assert.equal(DEFAULT_SETTINGS.liveScreen, true);
});

// ── What the page sends ───────────────────────────────────────────────────────

test("microphone, pictures and text go as realtime input", () => {
  assert.deepEqual(P.audioMessage("AAA="), { realtimeInput: { audio: { data: "AAA=", mimeType: "audio/pcm;rate=16000" } } });
  assert.deepEqual(P.frameMessage("/9j/"), { realtimeInput: { video: { data: "/9j/", mimeType: "image/jpeg" } } });
  assert.deepEqual(P.textMessage("hi"), { realtimeInput: { text: "hi" } });
  assert.deepEqual(P.audioEndMessage(), { realtimeInput: { audioStreamEnd: true } });
});

test("a tool's answer carries its scheduling, except for Extended Thinking", () => {
  const answers = [
    { id: "1", name: "read_file", result: { text: "x" }, scheduling: "WHEN_IDLE" },
    { id: "2", name: "open", error: "Nothing is at C:\\x.", scheduling: "WHEN_IDLE" },
  ];
  assert.deepEqual(P.toolResponseMessage(answers, false), {
    toolResponse: {
      functionResponses: [
        { id: "1", name: "read_file", response: { result: { text: "x" }, scheduling: "WHEN_IDLE" } },
        { id: "2", name: "open", response: { error: "Nothing is at C:\\x.", scheduling: "WHEN_IDLE" } },
      ],
    },
  });
  const ext = P.toolResponseMessage(answers, true).toolResponse.functionResponses;
  assert.ok(ext.every((r) => !("scheduling" in r.response)));
});

// ── What Google sends ─────────────────────────────────────────────────────────

test("server messages become events, in order, and thoughts are never played", () => {
  assert.deepEqual(P.parseServerMessage({ setupComplete: {} }), [{ kind: "ready" }]);
  assert.deepEqual(
    P.parseServerMessage({
      serverContent: {
        inputTranscription: { text: "ciao" },
        modelTurn: { parts: [{ thought: true, text: "hmm" }, { inlineData: { mimeType: "audio/pcm;rate=24000", data: "AQI=" } }] },
        outputTranscription: { text: " Ciao!" },
        turnComplete: true,
      },
    }),
    [{ kind: "heard", text: "ciao" }, { kind: "audio", data: "AQI=" }, { kind: "said", text: " Ciao!" }, { kind: "turnComplete" }],
  );
  assert.deepEqual(P.parseServerMessage({ serverContent: { interrupted: true } }), [{ kind: "interrupted" }]);
  assert.deepEqual(P.parseServerMessage({ serverContent: { interactionStatus: "IDLE" } }), [{ kind: "idle", idle: true }]);
  assert.deepEqual(
    P.parseServerMessage({ toolCall: { functionCalls: [{ id: "a", name: "open", args: { target: "x" } }, { nope: 1 }] } }),
    [{ kind: "toolCall", calls: [{ id: "a", name: "open", args: { target: "x" } }] }],
  );
  assert.deepEqual(P.parseServerMessage({ toolCallCancellation: { ids: ["a", 3] } }), [{ kind: "toolCancel", ids: ["a"] }]);
  assert.deepEqual(P.parseServerMessage({ goAway: { timeLeft: "9.5s" } }), [{ kind: "goAway", ms: 9500 }]);
  assert.deepEqual(P.parseServerMessage({ sessionResumptionUpdate: { newHandle: "h1", resumable: true } }), [{ kind: "handle", handle: "h1" }]);
  // Not resumable at this point: the last good handle stays.
  assert.deepEqual(P.parseServerMessage({ sessionResumptionUpdate: { newHandle: "h2", resumable: false } }), []);
  assert.deepEqual(P.parseServerMessage({ voiceActivity: { type: "ACTIVITY_START" } }), [{ kind: "voice", speaking: true }]);
  assert.deepEqual(P.parseServerMessage("junk"), []);
  assert.deepEqual(P.parseServerMessage({ usageMetadata: { totalTokenCount: 3 } }), []);
});

test("durations come as protobuf strings", () => {
  assert.equal(P.parseDuration("12s"), 12000);
  assert.equal(P.parseDuration("0.25s"), 250);
  assert.equal(P.parseDuration(3), 3000);
  assert.equal(P.parseDuration("soon"), null);
});

// ── PCM ───────────────────────────────────────────────────────────────────────

test("PCM16 goes both ways, little-endian and clipped", () => {
  const bytes = P.floatToPcm16(new Float32Array([0, 1, -1, 2, 0.5]));
  assert.deepEqual([...bytes.slice(0, 6)], [0, 0, 0xff, 0x7f, 0x00, 0x80]);
  const back = P.pcm16ToFloat(bytes);
  assert.equal(back.length, 5);
  assert.ok(Math.abs(back[1] - 1) < 0.001 && back[2] === -1 && Math.abs(back[4] - 0.5) < 0.001);
  assert.equal(P.pcm16ToFloat(new Uint8Array([1, 2, 3])).length, 1);
  assert.deepEqual([...P.base64ToBytes(P.bytesToBase64(bytes))], [...bytes]);
});

test("48 kHz comes down to 16 kHz in 40 ms blocks", () => {
  const d = new P.Downsampler(48000);
  const second = new Float32Array(48000).fill(0.25);
  const blocks = d.push(second);
  assert.equal(blocks.length, 25);
  assert.ok(blocks.every((b) => b.length === 640 && Math.abs(b[0] - 0.25) < 1e-6));
  // 44.1 kHz too, without drifting: four seconds are 100 blocks, give or take the last sample.
  const odd = new P.Downsampler(44100);
  const total = [0, 1, 2, 3].reduce((n) => n + odd.push(new Float32Array(44100)).length, 0);
  assert.ok(total >= 99 && total <= 100, String(total));
});

test("a screenshot is made to fit 1600 pixels, never enlarged", () => {
  assert.deepEqual(P.fitSize(3840, 2160), { w: 1600, h: 900 });
  assert.deepEqual(P.fitSize(800, 600), { w: 800, h: 600 });
  assert.deepEqual(P.fitSize(1920 + 2560, 1440), { w: 1600, h: 514 });
});

// ── Transcript ────────────────────────────────────────────────────────────────

test("pieces join into lines, a new speaker starts a new one, and the history gets turns", () => {
  const tr = new Transcript();
  tr.heard(" What's on");
  tr.heard(" my screen?");
  tr.said("You have");
  tr.said(" VS Code open.");
  tr.close();
  tr.said("Anything else?");
  tr.heard("No", false);
  tr.heard("thanks", true);
  assert.deepEqual(tr.lines.map((l) => [l.role, l.text]), [
    ["user", "What's on my screen?"],
    ["model", "You have VS Code open."],
    ["model", "Anything else?"],
    ["user", "No"],
    ["user", "thanks"],
  ]);
  assert.deepEqual(tr.turns(), [
    { role: "user", content: "What's on my screen?" },
    { role: "assistant", content: "You have VS Code open.\n\nAnything else?" },
    { role: "user", content: "No\n\nthanks" },
  ]);
  tr.heard("   ");
  assert.equal(tr.lines.length, 5);
});

// ── Tools ─────────────────────────────────────────────────────────────────────

function host(overrides = {}) {
  const log = { pictures: [], doing: [], ended: 0 };
  return {
    log,
    host: {
      screen: true,
      helper: "Claude Code",
      showPictures: async (urls) => log.pictures.push(urls),
      doing: (label) => log.doing.push(label),
      end: () => log.ended++,
      ...overrides,
    },
  };
}

test("look_at_screen shows the picture to the model and deletes the files at once", async () => {
  const { host: h, log } = host();
  const shot = { display: 0, name: "s.png", path: "C:\\inbox\\s.png", width: 2560, height: 1440, preview: "data:image/png;base64,AA" };
  const answer = await withRust((cmd) => (cmd === "screen_capture" ? [shot] : null), () =>
    runTool({ id: "c1", name: "look_at_screen", args: {} }, h));
  assert.deepEqual(sent("screen_capture").at(-1), { display: null });
  assert.deepEqual(sent("screen_discard").at(-1), { paths: ["C:\\inbox\\s.png"] });
  assert.deepEqual(log.pictures, [["data:image/png;base64,AA"]]);
  assert.equal(answer.id, "c1");
  assert.equal(answer.scheduling, "WHEN_IDLE");
  assert.deepEqual(answer.result.displays, [{ display: 0, width: 2560, height: 1440 }]);
  assert.equal(log.doing.at(-1), null);
});

test("with the screen turned off, nothing is captured", async () => {
  const { host: h } = host({ screen: false });
  const before = sent("screen_capture").length;
  const answer = await runTool({ id: "c2", name: "look_at_screen", args: {} }, h);
  assert.match(answer.error, /turned screenshots off/);
  assert.equal(sent("screen_capture").length, before);
});

test("read_file: text as text, an image as a picture, a folder as a list, a PDF points to read_document", async () => {
  const { host: h, log } = host();
  const readings = {
    "C:\\a.txt": { kind: "text", name: "a.txt", text: "hello", cut: true },
    "C:\\b.png": { kind: "image", name: "b.png", mime: "image/png", data: "QUJD" },
    "C:\\c.pdf": { kind: "document", name: "c.pdf", size: 10 },
  };
  await withRust((cmd, args) => (cmd === "live_read" ? readings[args.path] : null), async () => {
    const text = await runTool({ id: "1", name: "read_file", args: { path: "C:\\a.txt" } }, h);
    assert.deepEqual(text.result, { name: "a.txt", text: "hello", note: "Only the beginning of the file: it is longer." });
    const img = await runTool({ id: "2", name: "read_file", args: { path: "C:\\b.png" } }, h);
    assert.deepEqual(log.pictures.at(-1), ["data:image/png;base64,QUJD"]);
    assert.equal(img.result.note, "The image is now shown to you.");
    const pdf = await runTool({ id: "3", name: "read_file", args: { path: "C:\\c.pdf" } }, h);
    assert.match(pdf.result.note, /read_document/);
  });
  assert.deepEqual(readingResult({ kind: "folder", path: "C:\\d", entries: [{ name: "x", dir: true, size: 0, modified: "" }], omitted: 2 }), {
    folder: "C:\\d", entries: [{ name: "x", folder: true, size: 0, modified: "" }], notListed: 2,
  });
  assert.ok(log.doing.includes("Reading a.txt"));
});

test("an error from Rust is the answer's error, never a thrown one", async () => {
  const { host: h } = host();
  const before = internals.invoke;
  internals.invoke = async (cmd, args) => {
    if (cmd === "live_open") throw "Lumo doesn't open programs or scripts this way: ask for the app by its name instead.";
    return before(cmd, args);
  };
  try {
    const a = await runTool({ id: "9", name: "open", args: { target: "C:\\x.exe" } }, h);
    assert.match(a.error, /doesn't open programs/);
    assert.equal(a.result, undefined);
  } finally {
    internals.invoke = before;
  }
  const missing = await runTool({ id: "10", name: "read_file", args: {} }, h);
  assert.match(missing.error, /Say which path/);
  const unknown = await runTool({ id: "11", name: "rm_rf", args: {} }, h);
  assert.match(unknown.error, /no tool called rm_rf/);
});

test("ask_helper hands the task to Rust and brings back the answer; end_conversation is silent", async () => {
  const { host: h, log } = host();
  const a = await withRust((cmd) => (cmd === "live_help" ? "Done: 3 files renamed." : null), () =>
    runTool({ id: "h", name: "ask_helper", args: { task: "Rename the photos", folder: "C:\\Pics" } }, h));
  assert.deepEqual(sent("live_help").at(-1), { task: "Rename the photos", folder: "C:\\Pics" });
  assert.deepEqual(a.result, { helper: "Claude Code", answer: "Done: 3 files renamed." });
  assert.ok(log.doing.includes("Asked Claude Code"));
  const end = await runTool({ id: "e", name: "end_conversation", args: {} }, h);
  assert.equal(end.scheduling, "SILENT");
  assert.equal(log.ended, 1);
});

test("the helper is offered for the user's connected accounts, and asked before saying no", () => {
  const text = P.systemInstruction(CFG);
  assert.match(text, /calendar/);
  assert.match(text, /Never tell the user you can't do something before Claude Code has tried/);
  assert.match(P.toolDeclarations(CFG).find((d) => d.name === "ask_helper").description, /calendar, email/);
  assert.match(text, /type_text writes text into the text box/);
});

test("type_text types what the model said into the window in front, and says where", async () => {
  const { host: h, log } = host();
  const typed = { chars: 18, app: "chrome", title: "Gmail", flattened: false };
  const a = await withRust((cmd) => (cmd === "live_type" ? typed : null), () =>
    runTool({ id: "t1", name: "type_text", args: { text: "Ciao,\na domani" } }, h));
  assert.deepEqual(sent("live_type").at(-1), { text: "Ciao,\na domani" });
  assert.deepEqual(a.result, { typed: 18, into: "Gmail (chrome)" });
  assert.ok(log.doing.includes("Typing the text"));
  const term = await withRust((cmd) => (cmd === "live_type" ? { ...typed, app: "WindowsTerminal", title: "", flattened: true } : null), () =>
    runTool({ id: "t2", name: "type_text", args: { text: "a\nb" } }, h));
  assert.equal(term.result.into, "WindowsTerminal");
  assert.match(term.result.note, /terminal/);
  const empty = await runTool({ id: "t3", name: "type_text", args: { text: "  " } }, h);
  assert.match(empty.error, /which text/);
});

test("small helpers", () => {
  assert.equal(baseName("C:\\Users\\me\\report.pdf"), "report.pdf");
  assert.equal(baseName("/home/me/folder/"), "folder");
  assert.equal(errorText(new Error("boom")), "boom");
  assert.equal(errorText("Error: nope"), "nope");
  assert.equal(helperName("antigravity-cli"), "Antigravity CLI");
  assert.equal(helperName("claude-code"), "Claude Code");
  assert.equal(liveModelName(P.LIVE_EXTENDED), "Gemini 3.8 Live Extended Thinking");
});

// ── Lumo and the island during a call ─────────────────────────────────────────

test("Lumo speaks, thinks and works with the call; a waiting card shows over it", () => {
  assert.equal(liveBotState("off", false), null);
  assert.equal(liveBotState("speaking", false), "working");
  assert.equal(liveBotState("listening", true), "searching");
  assert.equal(liveBotState("listening", false), null);
  assert.equal(liveBotState("thinking", false), "thinking");
  assert.equal(liveBotState("connecting", false), "thinking");
  State.liveState = "working";
  assert.equal(State.effectiveState, "working");
  State.pendingApproval = { requestId: "r", sessionId: "", pillId: State.focusId ?? "", tool: "Bash", command: "ls", fromChat: true };
  assert.notEqual(State.effectiveState, "working");
  assert.equal(State.defaultView(), "approval");
  State.pendingApproval = null;
  State.liveActive = true;
  assert.equal(State.defaultView(), "live");
  State.liveActive = false;
  State.liveState = null;
  assert.equal(State.defaultView(), "prompt");
});

test("the call view has the chat's room", () => {
  assert.equal(VIEW_LAYOUTS.live.height, 240);
  assert.deepEqual(islandSize("expanded", "live"), { w: 640, h: 240 });
});

test("\"Claude Code answered\" has no dots going, and goes by itself", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const view = buildLive(() => {});
  Live.phase = "listening";
  try {
    Live.setDoing("Reading a.pdf");
    view.sync();
    const doing = view.el.querySelector(".live-doing");
    assert.equal(doing.hidden, false);
    assert.ok(!doing.classList.contains("done"), "work going on: dots");
    Live.setDoing("Antigravity CLI answered", true);
    view.sync();
    assert.ok(doing.classList.contains("done"), "over: no dots");
    t.mock.timers.tick(DONE_SHOWS_MS);
    assert.equal(Live.doing, null);
    view.sync();
    assert.equal(doing.hidden, true);
  } finally {
    Live.setDoing(null);
    Live.phase = "off";
  }
});

test("before a call, the view says what Gemini can do and offers to start", () => {
  State.settings = { ...DEFAULT_SETTINGS, liveHelper: "antigravity-cli" };
  const view = buildLive(() => {});
  view.sync();
  const text = (el) => el.textContent ?? "";
  const all = text(view.el);
  assert.match(all, /Gemini 3\.8 Live/);
  assert.match(all, /ask Antigravity CLI for what it can't do/);
  assert.match(all, /Start talking/);
  assert.equal(Live.active, false);
  State.settings = { ...DEFAULT_SETTINGS };
});

const shortcutHost = (opened) => ({
  alert: (v) => opened.push(v), setView: () => {}, collapse: () => {}, emote: () => {},
  setPinned: () => {}, takeKeyboard: () => {}, wardrobeAnywhere: () => {}, holdOpen: () => {},
});

test("the shortcut starts a call without opening the closed island; with no answer from Rust it ends saying so", async () => {
  const { runGlobalShortcut } = await import("../src/island/shortcuts.ts");
  const opened = [];
  State.mode = "compact";
  runGlobalShortcut(shortcutHost(opened), "talkToGemini", () => {});
  assert.deepEqual(opened, [], "the island stays closed");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(Live.active, false);
  assert.equal(Live.problem, "The connection to Gemini Live was lost.");
  assert.ok(sent("live_token").length >= 1);
  // The microphone was never asked for: there was nothing to talk to.
  assert.equal(sent("live_microphone").filter((a) => a.on).length, 0);
});

test("on an open island the shortcut opens the call view; on a call, it pauses and resumes it", async () => {
  const { runGlobalShortcut } = await import("../src/island/shortcuts.ts");
  const opened = [];
  State.mode = "expanded";
  State.view = "prompt";
  runGlobalShortcut(shortcutHost(opened), "talkToGemini", () => {});
  assert.deepEqual(opened, ["live"]);
  await new Promise((r) => setTimeout(r, 10));

  Live.phase = "listening";
  Live.muted = false;
  try {
    // A call behind another view comes back first, untouched.
    runGlobalShortcut(shortcutHost(opened), "talkToGemini", () => {});
    assert.deepEqual(opened, ["live", "live"]);
    assert.equal(Live.muted, false);
    // On the call view, or with the island closed: pause, then resume. It never ends the call.
    State.view = "live";
    runGlobalShortcut(shortcutHost(opened), "talkToGemini", () => {});
    assert.equal(Live.muted, true);
    State.mode = "compact";
    runGlobalShortcut(shortcutHost(opened), "talkToGemini", () => {});
    assert.equal(Live.muted, false);
    runGlobalShortcut(shortcutHost(opened), "talkToGemini", () => {});
    assert.equal(Live.muted, true);
    assert.equal(Live.active, true);
    assert.deepEqual(opened, ["live", "live"], "the closed island stays closed");
  } finally {
    Live.phase = "off";
    Live.muted = false;
    State.mode = "hidden";
    State.view = "prompt";
  }
});

test("a close reason loses the link Google's 123 bytes cut in half", () => {
  const cut = "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: h";
  assert.equal(P.closeDetail(cut), "You exceeded your current quota, please check your plan and billing details.");
  assert.equal(P.closeDetail("  Invalid argument.  "), "Invalid argument.");
  assert.equal(P.closeDetail(""), "");
  assert.equal(P.liveModelName(P.LIVE_EXTENDED), "Gemini 3.8 Live Extended Thinking");
});

test("without Google Search the setup leaves it out and the model is told to ask the helper", () => {
  const s = P.setupMessage({ ...CFG, search: false }, null).setup;
  assert.equal(s.tools.length, 1);
  assert.ok(!JSON.stringify(s.tools).includes("googleSearch"));
  const text = P.systemInstruction({ ...CFG, search: false });
  assert.doesNotMatch(text, /Google Search finds/);
  assert.match(text, /no web search of your own/);
  assert.match(P.systemInstruction(CFG), /Google Search finds/);
});

test("with computer use on, Gemini hands what is to be done on the screen to Claude Code", () => {
  const on = P.systemInstruction({ ...CFG, computer: true });
  assert.match(on, /use_computer hands something to do on the screen to Claude Code/);
  assert.match(on, /Never try to do it yourself/);
  assert.doesNotMatch(P.systemInstruction(CFG), /use_computer/, "off by default");
  const names = (cfg) => P.toolDeclarations(cfg).map((d) => d.name);
  assert.ok(names({ ...CFG, computer: true }).includes("use_computer"));
  assert.ok(!names(CFG).includes("use_computer"));
  // Whoever helps otherwise: the screen is Claude Code's.
  const withAgy = P.toolDeclarations({ ...CFG, helper: "Antigravity CLI", computer: true });
  assert.match(withAgy.find((d) => d.name === "use_computer").description, /Claude Code/);
  assert.doesNotMatch(withAgy.find((d) => d.name === "ask_helper").description, /screen/);
});

// ── The computer itself (src/live/pc-protocol.ts, pc-tools.ts) ────────────────

const PC = await import("../src/live/pc-protocol.ts");

test("the computer's own tools are explained, and moving files waits for the user's yes", () => {
  const text = P.systemInstruction(CFG);
  assert.match(text, /control_computer sets the volume/);
  assert.match(text, /call confirm_file_moves with its id only after they say yes/);
  assert.match(text, /Do not disturb/);
  const decl = P.toolDeclarations(CFG);
  const move = decl.find((d) => d.name === "move_files");
  assert.equal(move.parameters.properties.moves.type, "ARRAY");
  assert.deepEqual(move.parameters.properties.moves.items.required, ["from", "to"]);
  assert.match(decl.find((d) => d.name === "confirm_file_moves").description, /Never call it before the user said yes/);
  assert.ok(PC.isPcTool("set_reminder") && !PC.isPcTool("open"));
});

test("a reminder's time: a local date and time, a bare date at 9, or a length from now", () => {
  assert.equal(PC.parseLocalTime("2026-10-15T09:30"), new Date(2026, 9, 15, 9, 30).getTime());
  assert.equal(PC.parseLocalTime("2026-10-15 18:05"), new Date(2026, 9, 15, 18, 5).getTime());
  assert.equal(PC.parseLocalTime("2026-10-15"), new Date(2026, 9, 15, 9, 0).getTime());
  assert.equal(PC.parseLocalTime("2026-02-31T10:00"), null, "no 31 February");
  assert.equal(PC.parseLocalTime("tomorrow"), null);
  const now = 1_000_000;
  assert.equal(PC.reminderTime({ in: "1h30m" }, now), now + 90 * 60_000);
  assert.equal(PC.reminderTime({ at: "2026-10-15T09:30", in: "1h" }, now), new Date(2026, 9, 15, 9, 30).getTime(), "at wins");
  assert.equal(PC.reminderTime({}, now), null);
});

test("a notification's codes never reach Google", () => {
  assert.equal(PC.hideCodes("Your code is 482913"), "Your code is ••••");
  assert.equal(PC.hideCodes("Codice: 482 913, scade tra 10 minuti"), "Codice: ••••, scade tra 10 minuti");
  assert.equal(PC.hideCodes("PIN 1234-5678"), "PIN ••••");
  assert.equal(PC.hideCodes("Meeting at 10:30 in room 12"), "Meeting at 10:30 in room 12", "short numbers stay");
});

test("control_computer and arrange_windows check the action before Rust is asked", async () => {
  const { host: h, log } = host();
  const bad = await runTool({ id: "p1", name: "control_computer", args: { action: "explode" } }, h);
  assert.match(bad.error, /Say one of: volume/);
  assert.equal(sent("pc_control").length, 0);
  await withRust((cmd) => (cmd === "pc_control" ? { volume: 30, muted: false } : cmd === "pc_window" ? { title: "Inbox - Chrome", app: "chrome" } : null), async () => {
    const vol = await runTool({ id: "p2", name: "control_computer", args: { action: "volume", value: 30 } }, h);
    assert.deepEqual(sent("pc_control").at(-1), { action: "volume", value: 30, plan: null });
    assert.deepEqual(vol.result, { volume: 30, muted: false });
    const win = await runTool({ id: "p3", name: "arrange_windows", args: { window: "chrome", action: "left" } }, h);
    assert.deepEqual(sent("pc_window").at(-1), { window: "chrome", action: "left" });
    assert.deepEqual(win.result, { done: "left", window: "Inbox - Chrome", app: "chrome" });
  });
  assert.ok(log.doing.includes("Adjusting the computer") && log.doing.includes("Arranging the windows"));
});

test("move_files only plans; confirm_file_moves does the plan by its id", async () => {
  const { host: h } = host();
  const plan = { id: 4, moves: [{ from: "C:\\Users\\a\\Downloads\\x.pdf", to: "C:\\Users\\a\\Downloads\\PDF\\x.pdf" }], newFolders: ["C:\\Users\\a\\Downloads\\PDF"], skipped: [] };
  await withRust((cmd) => (cmd === "pc_files_plan" ? plan : cmd === "pc_files_apply" ? { moved: 1, newFolders: 1, failed: [] } : null), async () => {
    const a = await runTool({
      id: "m1",
      name: "move_files",
      args: { moves: [{ from: plan.moves[0].from, to: "C:\\Users\\a\\Downloads\\PDF" }, { from: "", to: "x" }, "junk"], folders: ["C:\\Users\\a\\Downloads\\PDF", 3] },
    }, h);
    assert.deepEqual(sent("pc_files_plan").at(-1), {
      moves: [{ from: plan.moves[0].from, to: "C:\\Users\\a\\Downloads\\PDF" }],
      folders: ["C:\\Users\\a\\Downloads\\PDF"],
    });
    assert.equal(a.result.plan_id, 4);
    assert.match(a.result.note, /Nothing has moved yet/);
    assert.equal(sent("pc_files_apply").length, 0);
    const b = await runTool({ id: "m2", name: "confirm_file_moves", args: { plan_id: 4 } }, h);
    assert.deepEqual(sent("pc_files_apply").at(-1), { id: 4 });
    assert.equal(b.result.moved, 1);
  });
});

test("computer_status reads in plain words", () => {
  const r = PC.statusResult({
    cpuPercent: 12.5, memoryUsedGb: 9.1, memoryTotalGb: 16, disks: [{ drive: "C:", freeGb: 40.2, totalGb: 476.3 }],
    battery: { percent: 64, charging: false, minutesLeft: 150 }, uptimeHours: 30.5,
    busiest: [{ name: "chrome", cpuPercent: 8.2, memoryMb: 2100 }], biggest: [{ name: "Code", cpuPercent: 1, memoryMb: 2400 }],
  });
  assert.equal(r.processor, "12.5%");
  assert.equal(r.memory, "9.1 of 16 GB in use");
  assert.deepEqual(r.disks, ["C: 40.2 GB free of 476.3"]);
  assert.equal(r.battery, "64%, about 150 min left");
  assert.deepEqual(r.busiest, ["chrome 8.2%"]);
  assert.deepEqual(r.most_memory, ["Code 2400 MB"]);
});

test("set_reminder sends Rust the time in ms; a time it can't read asks again", async () => {
  const { host: h } = host();
  const bad = await runTool({ id: "r1", name: "set_reminder", args: { text: "call the bank", at: "tomorrow" } }, h);
  assert.match(bad.error, /Say when/);
  const at = new Date(2030, 0, 2, 9, 0).getTime();
  await withRust((cmd, args) => (cmd === "reminders_add" ? { id: 1, at: args.at, text: args.text } : null), async () => {
    const ok = await runTool({ id: "r2", name: "set_reminder", args: { text: "call the bank", at: "2030-01-02T09:00" } }, h);
    assert.deepEqual(sent("reminders_add").at(-1), { at, text: "call the bank" });
    assert.equal(ok.result.set, true);
    assert.equal(ok.result.id, 1);
  });
});
