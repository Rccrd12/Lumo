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
const { runTool, readingResult, baseName, errorText, locate } = await import("../src/live/tools.ts");
const { Live, liveBotState, helperName } = await import("../src/live/session.ts");
const { buildLive, liveModelName } = await import("../src/views/live.ts");
const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");
const { VIEW_LAYOUTS, islandSize } = await import("../src/core/layout.ts");

const CFG = {
  model: P.LIVE_MODEL, thinking: "medium", voice: "", helper: "Claude Code", screen: true, search: true,
  languageName: "French", os: "Windows", now: "Friday 9 October 2026 at 16:00",
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
    "look_at_screen", "point_at", "list_windows", "explorer_folder", "find_files", "read_file", "read_document",
    "open", "open_app", "type_text", "ask_helper", "stop_helper", "end_conversation",
  ]);
  const off = P.toolDeclarations({ ...CFG, screen: false }).map((d) => d.name);
  assert.ok(!off.includes("look_at_screen") && !off.includes("point_at"), "no pointing without the screen");
  assert.ok(off.includes("type_text"));
  assert.deepEqual(on.find((d) => d.name === "point_at").parameters.required, ["x", "y"]);
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
      shownScreens: null,
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
  assert.match(text, /point_at shows the user where to click/);
  assert.doesNotMatch(P.systemInstruction({ ...CFG, screen: false }), /point_at/);
});

test("a point of the last screenshot is found on its display, side by side from the left", () => {
  const two = [{ display: 0, width: 1568, height: 882 }, { display: 1, width: 1568, height: 1176 }];
  // The picture is 3136 wide and 1176 high: the first display's bottom is empty.
  assert.deepEqual(locate(two, 250, 375), { display: 0, x: 0.5, y: 0.5 });
  assert.deepEqual(locate(two, 750, 1000), { display: 1, x: 0.5, y: 1 });
  assert.equal(locate(two, 250, 900), null, "under the shorter display");
  assert.equal(locate(two, 1200, 10), null);
  assert.equal(locate(two, Number.NaN, 10), null);
  assert.deepEqual(locate([{ display: 2, width: 1000, height: 500 }], 1000, 0), { display: 2, x: 1, y: 0 });
});

test("point_at needs a screenshot first, then shows the pointer where the model said", async () => {
  const { host: h, log } = host();
  const early = await runTool({ id: "p0", name: "point_at", args: { x: 500, y: 500 } }, h);
  assert.match(early.error, /look_at_screen first/);
  const shot = { display: 1, name: "s.png", path: "C:\\inbox\\s.png", width: 1568, height: 882, preview: "data:image/png;base64,AA" };
  await withRust((cmd) => (cmd === "screen_capture" ? [shot] : null), () =>
    runTool({ id: "p1", name: "look_at_screen", args: { display: 1 } }, h));
  assert.deepEqual(h.shownScreens, [{ display: 1, width: 1568, height: 882 }]);
  const a = await withRust(() => null, () =>
    runTool({ id: "p2", name: "point_at", args: { x: 250, y: 800, label: "Clicca qui" } }, h));
  assert.deepEqual(sent("live_point").at(-1), { display: 1, x: 0.25, y: 0.8, label: "Clicca qui" });
  assert.match(a.result.shown, /pointer/);
  assert.ok(log.doing.includes("Showing where to click"));
  const off = await runTool({ id: "p3", name: "point_at", args: { x: 1500, y: 10 } }, h);
  assert.match(off.error, /off the screen/);
  const { host: noScreen } = host({ screen: false, shownScreens: h.shownScreens });
  assert.match((await runTool({ id: "p4", name: "point_at", args: { x: 1, y: 1 } }, noScreen)).error, /turned screenshots off/);
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

test("the shortcut opens the call view and starts a call; with no answer from Rust it ends saying so", async () => {
  const { runGlobalShortcut } = await import("../src/island/shortcuts.ts");
  const opened = [];
  const shortcutHost = {
    alert: (v) => opened.push(v), setView: () => {}, collapse: () => {}, emote: () => {},
    setPinned: () => {}, takeKeyboard: () => {}, wardrobeAnywhere: () => {},
  };
  runGlobalShortcut(shortcutHost, "talkToGemini", () => {});
  assert.deepEqual(opened, ["live"]);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(Live.active, false);
  assert.equal(Live.problem, "The connection to Gemini Live was lost.");
  assert.ok(sent("live_token").length >= 1);
  // The microphone was never asked for: there was nothing to talk to.
  assert.equal(sent("live_microphone").filter((a) => a.on).length, 0);
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
