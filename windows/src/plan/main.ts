// The Plan island's window (plan_island.rs). This page only draws: the
// island's page sends the plan to show (`plan-state`) and hears the clicks
// (`plan-action`). The top bar moves the window and the grips resize it,
// both followed by Rust.

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
  drag: () => void Bridge.planDrag(),
  resize: (fx, fy) => void Bridge.planWindowResize(fx, fy),
  toward: () => Bridge.towardIsland("plan").then((p) => (p ? { x: p[0], y: p[1] } : null)),
});
// Out of sight until the island's page says it shows (plan-appear).
view.el.classList.add("gone");
root.append(view.el);

void onEvent<PlanData>("plan-state", (data) => {
  if (isLanguage(data.lang) && setLanguage(data.lang)) applyDocumentLanguage();
  view.render(data);
});

// Shown: out of the island's side (a plan just made, or the icon clicked), or at once.
void onEvent<{ fly: boolean }>("plan-appear", ({ fly }) => void view.appear(!fly));

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
