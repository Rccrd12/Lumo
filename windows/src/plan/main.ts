// The Plan island in a window of its own (plan_island.rs), off the island.
// This page only draws: the island's page sends the plan to show
// (`plan-state`) and hears the clicks (`plan-action`). The top bar moves the
// window and the grips resize it, both followed by Rust.

import "./plan.css";
import { Bridge, emitToWindow, onEvent } from "../core/bridge";
import { PlanView, type PlanAction, type PlanData } from "../views/plan-view";
import { applyDocumentLanguage, isLanguage, setLanguage, t } from "../i18n/i18n";
import { ContextMenu, textEntries } from "../views/context-menu";
import { MENU_TEXT } from "../core/context-menu";

const root = document.getElementById("app")!;
const act = (a: PlanAction) => void emitToWindow("island", "plan-action", a);
const view = new PlanView({
  act,
  drag: () => void Bridge.planDrag(null),
  resize: (fx, fy) => void Bridge.planWindowResize(fx, fy),
  // Its icon is in the island: it folds toward it and comes out of it.
  iconPoint: () => Bridge.towardIsland("plan").then((p) => (p ? { x: p[0], y: p[1] } : null)),
  movable: true,
});
root.append(view.el);
let last: PlanData | null = null;

void onEvent<PlanData>("plan-state", (data) => {
  if (isLanguage(data.lang) && setLanguage(data.lang)) applyDocumentLanguage();
  last = data;
  view.render(data);
});

// Shown again: out of its icon after it was clicked, else at once. Taken off
// the island (`painted`), the island's page waits to hear it has been drawn
// here before it lets go of its own.
void onEvent<{ fly: boolean; painted: boolean }>("plan-appear", ({ fly, painted }) => {
  if (last) view.render(last);
  if (fly) void view.flyIn();
  else view.reveal();
  if (painted) {
    requestAnimationFrame(() => requestAnimationFrame(() => void emitToWindow("island", "plan-painted")));
  }
});

// Its icon in the chat clicked while it is open: it folds as with its "–".
void onEvent<null>("plan-fold", () => void view.fold());

void emitToWindow("island", "plan-hello");

// Lumo's own right-click menu, never the webview's: the text actions,
// Refresh and Settings, as in the live activities' window.
const menu = new ContextMenu();
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  menu.open(e.clientX, e.clientY, [
    ...textEntries(e.target),
    { kind: "sep" },
    { kind: "item", label: t(MENU_TEXT.refresh), title: t(MENU_TEXT.refreshHint), shortcut: "Ctrl+R", run: () => act({ kind: "refresh" }) },
    { kind: "item", label: t("Settings"), run: () => act({ kind: "settings" }) },
  ]);
});
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey && !e.altKey && e.key.toLowerCase() === "r") || e.key === "F5") {
    e.preventDefault();
    act({ kind: "refresh" });
  }
});
