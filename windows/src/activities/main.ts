// The live activities in a window of their own (activities.rs), off the
// island. This page only draws: the island's page sends what to show
// (`activities-state`) and hears the clicks (`activities-action`). The top
// bar moves the window and the grips resize it, both followed by Rust.

import "./activities.css";
import { Bridge, emitToWindow, onEvent } from "../core/bridge";
import { ActivitiesView, type ActivitiesData } from "../views/activities-view";
import { applyDocumentLanguage, isLanguage, setLanguage } from "../i18n/i18n";

const root = document.getElementById("app")!;
let view: ActivitiesView | null = null;
let last: ActivitiesData | null = null;

/** Built once the language is known, so its labels are in it. */
function ensureView(): ActivitiesView {
  if (view) return view;
  view = new ActivitiesView({
    act: (a) => void emitToWindow("island", "activities-action", a),
    drag: () => void Bridge.activitiesDrag(null),
    resize: (fx, fy) => void Bridge.activitiesWindowResize(fx, fy),
    focus: () => void Bridge.activitiesFocus(true),
    iconPoint: () => null,
    movable: true,
  }, () => "free");
  root.append(view.el);
  return view;
}

void onEvent<ActivitiesData>("activities-state", (data) => {
  if (isLanguage(data.lang) && setLanguage(data.lang)) applyDocumentLanguage();
  last = data;
  ensureView().render(data);
});

// Shown again: out of its corner after the icon was clicked, else at once.
// Taken off the island (`painted`), the island's page waits to hear it has
// been drawn here before it lets go of its own.
void onEvent<{ fly: boolean; painted: boolean }>("activities-appear", ({ fly, painted }) => {
  const v = ensureView();
  if (last) v.render(last);
  if (fly) v.flyIn();
  else v.reveal();
  if (painted) {
    requestAnimationFrame(() => requestAnimationFrame(() => void emitToWindow("island", "activities-painted")));
  }
});

// The keyboard goes back to the app in front once the timer's field is left.
window.addEventListener("focusout", () => void Bridge.activitiesFocus(false));

void emitToWindow("island", "activities-hello");
