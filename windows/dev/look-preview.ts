// Dev harness: the real island in a plain browser, with a Claude Code
// session, a permission request, a chat and the tools, to compare the usual
// look with the new one (Settings → Island → New look). `npm run dev`, then
// open /dev/look-preview.html. `?view=approval&look=new` opens straight on a
// view in a look. Not part of the app bundle.

import "../src/style.css";
import "../src/look-new.css";
import { State } from "../src/core/state";
import { Island } from "../src/island/island";
import { registerHookHandlers } from "../src/island/hooks";
import type { IslandViewName } from "../src/core/layout";

type Listener = (e: { event: string; id: number; payload: unknown }) => void;
const listeners = (window as unknown as { __lumoListeners: Map<string, Listener> }).__lumoListeners;
const emit = (event: string, payload: unknown) => listeners.get(event)?.({ event, id: 0, payload });
const hook = (payload: Record<string, unknown>) => emit("hook", payload);

const params = new URLSearchParams(location.search);
const island = new Island(document.getElementById("root")!);
(window as unknown as { island: Island; State: typeof State }).island = island;
(window as unknown as { State: typeof State }).State = State;
await registerHookHandlers(island);
State.settings = { ...State.settings, islandNewLook: params.get("look") === "new", soundEnabled: false };
island.applySettings();
State.loadIntegrationTasks();

// A Claude Code session at work in "lumo".
const cwd = "C:\\dev\\lumo";
hook({ hook_event_name: "SessionStart", cwd });
hook({ hook_event_name: "UserPromptSubmit", cwd, prompt: "Add a dark mode toggle to the settings" });
hook({ hook_event_name: "PreToolUse", cwd, tool_name: "Read", tool_input: { file_path: `${cwd}\\src\\settings\\general.ts` } });
hook({ hook_event_name: "PreToolUse", cwd, tool_name: "Edit", tool_input: { file_path: `${cwd}\\src\\settings\\general.ts`, old_string: "a", new_string: "b" } });

// A short chat.
State.chatHistory = [
  { id: 1, role: "user", content: "What does `npm test` run in this repo?" },
  { id: 2, role: "assistant", content: "Node's built-in test runner on `tests/**/*.test.mjs`: 54 test files, done in about ten seconds. The TypeScript check is separate: `npx tsc --noEmit`." },
];

function show(view: IslandViewName) {
  if (view === "approval" && !State.pendingApproval) {
    hook({ hook_event_name: "PermissionRequest", cwd, request_id: "r1", tool_name: "Bash", tool_input: { command: "npm test", description: "Run the test suite" } });
  }
  island.setView(view);
  island.holdOpen();
  State.notify();
  sync();
}

const bar = document.getElementById("bar")!;
const views: [IslandViewName, string][] = [["overview", "Sessions"], ["approval", "Permission"], ["prompt", "Chat"], ["tools", "Tools"], ["upload", "Drop"]];
const buttons = new Map<string, HTMLButtonElement>();
for (const [view, label] of views) {
  const b = document.createElement("button");
  b.textContent = label;
  b.onclick = () => show(view);
  bar.append(b);
  buttons.set(view, b);
}
const lookBtn = document.createElement("button");
lookBtn.onclick = () => {
  State.settings = { ...State.settings, islandNewLook: !State.settings.islandNewLook };
  island.applySettings();
  State.notify();
  sync();
};
const closeBtn = document.createElement("button");
closeBtn.textContent = "Close";
closeBtn.onclick = () => island.collapse();
bar.append(lookBtn, closeBtn);

function sync() {
  for (const [view, b] of buttons) b.classList.toggle("on", State.view === view);
  lookBtn.textContent = State.settings.islandNewLook ? "Look: new" : "Look: usual";
  lookBtn.classList.toggle("on", State.settings.islandNewLook === true);
}

show((params.get("view") as IslandViewName | null) ?? "overview");
