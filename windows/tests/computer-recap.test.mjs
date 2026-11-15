// What a computer use turn leaves in the chat (src/views/computer-recap.ts, the
// recap under the answer, saved with the chat in src/core/chats.ts) and the
// permission card's box for a computer action (src/views/computer-card.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { calls, internals } from "./tauri.mjs";

installFakeDom();

const { cleanRecap, fromSavedTurn, toSavedTurn } = await import("../src/core/chats.ts");
const { computerRecapBox, recapDuration, stoppedLine, stoppedPlace } = await import("../src/views/computer-recap.ts");
const { computerTargetBox, pausedCardLine } = await import("../src/views/computer-card.ts");
const { State } = await import("../src/core/state.ts");

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const recap = (extra = {}) => ({
  agent: "Claude Code", color: "#D97757", actions: 9, ms: 41_000,
  steps: [
    { text: "Open Notepad", status: "done", image: PNG },
    { text: "Write the text", status: "done" },
    { text: "Save it on the Desktop", status: "active" },
    { text: "Check it is there", status: "pending" },
  ],
  ...extra,
});
const shown = (el) => el != null && el.hidden !== true;

test("a recap from Rust or from storage is kept only as far as it can be shown", () => {
  assert.equal(cleanRecap(null), undefined);
  assert.equal(cleanRecap({ agent: "x" }), undefined, "no steps");
  const clean = cleanRecap({
    agent: "Codex", color: "red; background:url(x)", actions: -3, ms: 1234.6, stopped: "yes",
    steps: [
      { text: "One", status: "done", image: "javascript:alert(1)" },
      { text: "Two", status: "weird" },
      { status: "done" },
      { text: "Three", status: "pending", image: PNG },
    ],
  });
  assert.deepEqual(clean, {
    agent: "Codex", color: "", actions: 0, ms: 1235,
    steps: [{ text: "One", status: "done" }, { text: "Three", status: "pending", image: PNG }],
  });
  assert.equal(cleanRecap(recap({ stopped: true })).stopped, true);
});

test("an answer's recap is saved with the chat and comes back with it", () => {
  const saved = toSavedTurn({ role: "assistant", content: "Done.", at: 5, computer: recap() });
  assert.deepEqual(saved, { role: "assistant", content: "Done.", at: 5, computer: recap() });
  assert.deepEqual(fromSavedTurn(JSON.parse(JSON.stringify(saved))), { at: 5, kept: undefined, computer: recap() });
  // A question never carries one; a turn saved before has none.
  assert.deepEqual(toSavedTurn({ role: "user", content: "Do it", computer: recap() }), { role: "user", content: "Do it" });
  assert.deepEqual(fromSavedTurn({ role: "assistant", content: "x", computer: { steps: "no" } }), { at: undefined, kept: undefined });
  assert.deepEqual(toSavedTurn({ role: "assistant", content: "x", kept: "y" }), { role: "assistant", content: "x", kept: "y" });
});

test("how long, and where a stopped turn ended", () => {
  assert.equal(recapDuration(41_000), "41 s");
  assert.equal(recapDuration(400), "0 s");
  assert.equal(recapDuration(125_000), "2 min 05 s");
  assert.equal(recapDuration(NaN), "0 s");
  assert.deepEqual(stoppedPlace(recap()), { step: 3, total: 4, last: "Write the text" });
  assert.equal(stoppedLine(recap()), "Stopped at step 3 of 4 · last done: Write the text");
  assert.equal(stoppedLine({ steps: [{ text: "A", status: "active" }, { text: "B", status: "pending" }] }), "Stopped at step 1 of 2");
  assert.deepEqual(stoppedPlace({ steps: [{ text: "A", status: "done" }] }), { step: 1, total: 1, last: "A" });
});

test("the recap is one line, closed; a click opens the steps with their pictures", () => {
  const box = computerRecapBox(recap(), 1);
  assert.match(box.querySelector(".cu-recap-head").textContent, /^Used the computer · 4 steps · 41 s/);
  assert.match(box.querySelector(".cu-recap-agent").textContent, /Claude Code/);
  assert.equal(box.querySelector(".cu-recap-stopped"), null, "not stopped: no amber line");
  const list = box.querySelector(".cu-recap-steps");
  assert.ok(!shown(list), "closed by default");
  box.querySelector(".cu-recap-head").fire("click");
  assert.ok(shown(list));
  assert.ok(box.classList.contains("open"));
  const steps = box.querySelectorAll(".cu-recap-step");
  assert.deepEqual(steps.map((s) => s.querySelector(".cu-recap-text").textContent), ["Open Notepad", "Write the text", "Save it on the Desktop", "Check it is there"]);
  assert.equal(steps[0].find("IMG")[0].getAttribute("src"), `data:image/png;base64,${PNG}`);
  assert.ok(steps[1].querySelector(".cu-recap-shot.none"), "no picture: a quiet box");
  assert.ok(steps[0].querySelector(".cu-recap-mark") && steps[1].querySelector(".cu-recap-mark"), "done: ticked");
  assert.equal(steps[2].querySelector(".cu-recap-mark"), null);
  assert.ok(steps[3].classList.contains("pending"));
  // Drawn again (the chat redraws), it stays open.
  assert.ok(shown(computerRecapBox(recap(), 1).querySelector(".cu-recap-steps")));
  assert.ok(!shown(computerRecapBox(recap(), 2).querySelector(".cu-recap-steps")));
});

test("a stopped turn says where, in its amber line, even closed", () => {
  const box = computerRecapBox(recap({ stopped: true }), 3);
  assert.ok(box.classList.contains("stopped"));
  assert.equal(box.querySelector(".cu-recap-stopped").textContent, "Stopped at step 3 of 4 · last done: Write the text");
});

const info = (extra) => ({ requestId: "r1", sessionId: "s", pillId: "p", fromChat: true, ...extra });

test("the card's box: none for other tools; typing and keys whole", () => {
  assert.equal(computerTargetBox(info({ tool: "Bash", command: "Bash · ls" })), null);
  const typed = computerTargetBox(info({ tool: "mcp__lumo__type", command: "Type · ciao⏎\nmondo" }));
  assert.ok(typed.classList.contains("cu-target-typed"));
  assert.equal(typed.querySelector(".cu-target-verb").textContent, "Type");
  assert.equal(typed.querySelector(".cu-target-text").textContent, "ciao⏎\nmondo", "every character Allow allows");
  const long = "x".repeat(2000);
  assert.equal(computerTargetBox(info({ tool: "mcp__lumo__type", command: `Type · ${long}` })).querySelector(".cu-target-text").textContent, long);
  assert.equal(computerTargetBox(info({ tool: "mcp__lumo__key", command: "Press · ctrl+s" })).querySelector(".cu-target-text").textContent, "ctrl+s");
});

/** Answers `computer_peek` with `peek`, counting the asks. */
async function withPeek(peek, run) {
  const invoke = internals.invoke;
  let asked = 0;
  internals.invoke = async (cmd, args) => {
    if (cmd === "computer_peek") {
      asked++;
      calls.push([cmd, args]);
      return peek;
    }
    return invoke(cmd, args);
  };
  try {
    await run(() => asked);
  } finally {
    internals.invoke = invoke;
  }
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test("a click: the screen around it, the point marked, the action on it; the app's name for it apart; the numbers small", async () => {
  const peek = { image: PNG, width: 300, height: 188, at: [150, 94], name: "Save as…", role: "Menu item", app: "Notepad" };
  await withPeek(peek, async (asked) => {
    const card = info({ requestId: "click-1", tool: "mcp__lumo__left_click", command: "Click · 640, 320 (shift)", computerAt: [640, 320] });
    const box = computerTargetBox(card);
    assert.ok(box.classList.contains("cu-target-point"));
    // Until the crop comes: a placeholder, and the line as the card says it.
    assert.ok(box.querySelector(".cu-target-thumb"));
    assert.equal(box.querySelector(".cu-target-what").textContent, "Click 640, 320 (shift)");
    await settle();
    assert.deepEqual(calls.filter(([c]) => c === "computer_peek").at(-1)[1], { x: 640, y: 320 });
    const img = box.find("IMG")[0];
    assert.equal(img.getAttribute("src"), `data:image/png;base64,${PNG}`);
    // The crop fills the 150 × 94 box.
    assert.equal(img.style.width, "150px");
    const mark = box.querySelector(".cu-target-mark");
    assert.deepEqual([mark.style.left, mark.style.top], ["75px", "47px"]);
    // What will be done is the action on the point the picture marks, never the app's word for it.
    assert.equal(box.querySelector(".cu-target-what").textContent, "Click · at the marked point");
    assert.equal(box.querySelector(".cu-target-verb").textContent, "Click");
    // The app's name for the thing, as its words, apart.
    assert.equal(box.querySelector(".cu-target-called").textContent, "The app calls it «Save as…»");
    assert.equal(box.querySelector(".cu-target-name").textContent, "Save as…");
    assert.equal(box.querySelector(".cu-target-where").textContent, "Menu item · Notepad");
    assert.equal(box.querySelector(".cu-target-at").textContent, "640, 320 (shift) · Enlarge", "what Allow allows, still there");
    // The same request drawn again asks nothing more.
    computerTargetBox(card);
    await settle();
    assert.equal(asked(), 1);
  });
});

test("the crop, a click away from its own size, and back", async () => {
  await withPeek({ image: PNG, width: 360, height: 200, at: [180, 100], name: "OK" }, async () => {
    const box = computerTargetBox(info({ requestId: "z-1", tool: "mcp__lumo__left_click", command: "Click · 5, 6", computerAt: [5, 6] }));
    await settle();
    const img = box.find("IMG")[0];
    const zoom = box.querySelector(".cu-target-zoom");
    assert.equal(zoom.textContent, "Enlarge");
    assert.ok(!box.classList.contains("big"));
    zoom.fire("click");
    assert.ok(box.classList.contains("big"));
    assert.equal(img.style.width, "360px", "its own size");
    assert.deepEqual([box.querySelector(".cu-target-mark").style.left, box.querySelector(".cu-target-mark").style.top], ["180px", "100px"]);
    assert.equal(zoom.textContent, "Smaller");
    // The picture itself toggles it too.
    box.querySelector(".cu-target-thumb").fire("click");
    assert.ok(!box.classList.contains("big"));
    assert.equal(zoom.textContent, "Enlarge");
  });
});

test("a scroll and a drag: on the point, a drag to it; no name, no app's words; no crop, no picture", async () => {
  await withPeek({ image: PNG, width: 100, height: 60, at: [50, 30], name: "Results" }, async () => {
    const scroll = computerTargetBox(info({ requestId: "s-1", tool: "mcp__lumo__scroll", command: "Scroll up · 5, 6 ×3", computerAt: [5, 6] }));
    const drag = computerTargetBox(info({ requestId: "d-1", tool: "mcp__lumo__left_click_drag", command: "Drag · 1, 2 → 5, 6", computerAt: [5, 6] }));
    await settle();
    assert.equal(scroll.querySelector(".cu-target-what").textContent, "Scroll up · at the marked point");
    assert.equal(scroll.querySelector(".cu-target-at").textContent, "5, 6 ×3 · Enlarge");
    assert.equal(scroll.querySelector(".cu-target-where"), null, "nothing known of its kind or app");
    assert.equal(drag.querySelector(".cu-target-what").textContent, "Drag · to the marked point");
    assert.equal(drag.querySelector(".cu-target-at").textContent, "1, 2 → 5, 6 · Enlarge");
  });
  await withPeek({ image: PNG, width: 100, height: 60, at: [50, 30] }, async () => {
    const box = computerTargetBox(info({ requestId: "n-1", tool: "mcp__lumo__left_click", command: "Click · 5, 6", computerAt: [5, 6] }));
    await settle();
    assert.ok(box.find("IMG").length === 1);
    assert.equal(box.querySelector(".cu-target-what").textContent, "Click · at the marked point");
    assert.equal(box.querySelector(".cu-target-called"), null, "no name: nothing said in the app's words");
  });
  for (const peek of [null, { image: "<svg>", width: 1, height: 1, at: [0, 0] }]) {
    await withPeek(peek, async () => {
      const box = computerTargetBox(info({ requestId: `x-${String(peek)}`, tool: "mcp__lumo__left_click", command: "Click · 5, 6", computerAt: [5, 6] }));
      await settle();
      assert.equal(box.querySelector(".cu-target-thumb"), null);
      assert.equal(box.find("IMG").length, 0);
      assert.equal(box.querySelector(".cu-target-what").textContent, "Click 5, 6");
    });
  }
});

test("a name an app or a page chose (one that says the opposite) is never the card's own words", async () => {
  await withPeek({ image: PNG, width: 100, height: 60, at: [50, 30], name: "Cancel", role: "button", app: "Google Chrome" }, async () => {
    const box = computerTargetBox(info({ requestId: "p-1", tool: "mcp__lumo__left_click", command: "Click · 5, 6", computerAt: [5, 6] }));
    await settle();
    assert.equal(box.querySelector(".cu-target-what").textContent, "Click · at the marked point");
    assert.ok(!box.querySelector(".cu-target-what").textContent.includes("Cancel"));
    assert.equal(box.querySelector(".cu-target-called").textContent, "The app calls it «Cancel»");
  });
});

test("paused, a computer action's card says it won't be done", () => {
  const plan = (extra) => ({ engaged: true, paused: false, stopped: false, agent: "Codex", color: "#000", since: 0, steps: [], ...extra });
  try {
    State.computer = null;
    assert.equal(pausedCardLine(), null);
    State.computer = plan();
    assert.equal(pausedCardLine(), null, "running: the card is the usual one");
    State.computer = plan({ paused: true });
    assert.equal(pausedCardLine(), "Paused: this action won't be done. After Resume, Codex looks at the screen again and asks again.");
    State.computer = plan({ paused: true, stopped: true });
    assert.equal(pausedCardLine(), null, "stopped: nothing more to say");
  } finally {
    State.computer = null;
  }
});
