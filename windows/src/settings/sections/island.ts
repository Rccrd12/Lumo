// Settings → Island: how the island behaves, Google Calendar and the
// calendars it shows, and the language row that General shows.

import { Bridge, type GoogleCalendarStatus } from "../../core/bridge";
import { parseCloseMode, parseMotion } from "../../core/state";
import { GoogleSync, MAX_GOOGLE_CALENDARS, isShown } from "../../core/google-calendar";
import { h } from "../../views/dom";
import { errorText, group, sectionHead, setting, statusDot, wideSetting } from "../parts";
import { FRAME_SHOWN } from "../../views/settings-frame";
import { LANGUAGES, N_, t } from "../../i18n/i18n";
import { CHAT_STRINGS } from "./chat";
import { KEY_STORE, applyLanguage, declaredViews, save, select, settings, toggle, whileShown } from "../store";

// ── Island section ────────────────────────────────────────────────────────────

/** Where the island lives and how big it is drawn. */
export function islandSection(): HTMLElement {
  const screen = h("select", {}) as HTMLSelectElement;
  screen.append(
    h("option", { value: "primary", text: t("Main display") }),
    h("option", { value: "cursor", text: t("Display under the cursor") }),
  );
  screen.value = settings.screen;
  void Bridge.listMonitors().then((list) => {
    for (const m of list ?? []) screen.append(h("option", { value: m.key, text: m.label }));
    // Set again now the option exists. A display saved under an older key (moved,
    // resized, or saved before names were kept) is shown by its place or its
    // name; one that is gone shows as the main one.
    const saved = settings.screen;
    const [place, name] = saved.split("|");
    const keys = (list ?? []).map((m) => m.key);
    screen.value =
      keys.find((k) => k === saved) ??
      (saved.startsWith("at:") ? keys.find((k) => k.split("|")[0] === place) : undefined) ??
      (name ? keys.find((k) => k.split("|")[1] === name) : undefined) ??
      saved;
    if (!screen.value) screen.value = "primary";
  });
  screen.addEventListener("change", () => {
    settings.screen = screen.value;
    void save();
  });

  // How big the island is drawn; Ctrl + / Ctrl − in the island do the same.
  const size = h("select", {}) as HTMLSelectElement;
  for (const pct of [80, 90, 100, 115, 130, 145, 160]) {
    size.append(h("option", { value: String(pct / 100), text: `${pct} %` }));
  }
  const nearest = [...size.options].reduce((best, o) =>
    Math.abs(Number(o.value) - settings.islandZoom) < Math.abs(Number(best.value) - settings.islandZoom) ? o : best);
  size.value = nearest.value;
  size.addEventListener("change", () => {
    settings.islandZoom = Number(size.value);
    void save();
  });

  // How far the island sits from the edge it hangs from.
  const gap = select([
    ["none", t("None")],
    ["light", t("Light (default)")],
    ["medium", t("Medium")],
    ["wide", t("Wide")],
  ], ["none", "medium", "wide"].includes(settings.islandEdgeGap) ? settings.islandEdgeGap : "light", (v) => {
    settings.islandEdgeGap = v;
    void save();
  });
  // How wide the closed island is, the rest of the island as it is.
  const compactW = select([
    ["normal", t("Wide (default)")],
    ["narrower", t("Mid-width")],
    ["narrow", t("Short")],
    ["lumo", t("Just Lumo")],
  ], ["narrower", "narrow", "lumo"].includes(settings.islandCompactWidth) ? settings.islandCompactWidth : "normal", (v) => {
    settings.islandCompactWidth = v;
    void save();
  });
  // The island's icons, against their usual size.
  const icons = h("select", {}) as HTMLSelectElement;
  for (const pct of [100, 125, 150]) {
    icons.append(h("option", { value: String(pct / 100), text: `${pct} %` }));
  }
  icons.value = [...icons.options].reduce((best, o) =>
    Math.abs(Number(o.value) - settings.iconScale) < Math.abs(Number(best.value) - settings.iconScale) ? o : best).value;
  icons.addEventListener("change", () => {
    settings.iconScale = Number(icons.value);
    void save();
  });

  // How much Lumo moves on his own.
  const motion = h("select", {}) as HTMLSelectElement;
  for (const [value, label] of [
    ["calm", N_("Calm")],
    ["lively", N_("Lively")],
    ["still", N_("Only when something happens")],
  ] as const) motion.append(h("option", { value, text: t(label) }));
  motion.value = parseMotion(settings.lumoMotion);
  motion.addEventListener("change", () => {
    settings.lumoMotion = motion.value;
    void save();
  });

  return h(
    "section",
    {},
    ...sectionHead(t("Island")),
    ...behaviourRows(),
    group("Lumo"),
    setting(t("Lumo moves"), null, motion),
    group(t("Position and size")),
    setting(t("Island lives on"), null, screen),
    setting(t("Island size"), null, size),
    setting(t("Closed island width"), t("only the closed island: the text, the icons and the open island keep their size. What it has to say still widens it"), compactW),
    setting(t("Distance from the edge"), t("between the island and the edge of the screen it is docked to. With Medium the mouse can cross the top of the screen above the island without opening it"), gap),
    setting(t("Icon size"), null, icons),
    setting(t("Put the island back in the centre"), null,
      h("button", { text: t("Put back"), onclick: () => void Bridge.islandRecenter() })),
    h("p", { class: "section-note" },
      t("Drag the top bar to move the island: near an edge it docks to it. Drag an edge or a corner to resize it; a double click puts the usual size back.")),
  );
}

/** When the island opens and closes by itself. */
function behaviourRows(): HTMLElement[] {
  const close = h("select", {}) as HTMLSelectElement;
  close.append(
    h("option", { value: "timer", text: t("After a few seconds") }),
    h("option", { value: "leave", text: t("As soon as the mouse leaves") }),
    h("option", { value: "click", text: t("On a click outside the island") }),
    h("option", { value: "never", text: t("Only when I close it") }),
  );
  close.value = parseCloseMode(settings.islandClose);

  const seconds = h("input", {
    type: "number", min: "5", max: "120", step: "1",
    value: String(Math.round(settings.autoCloseInterval)),
    style: "width:72px",
  }) as HTMLInputElement;
  seconds.addEventListener("change", () => {
    settings.autoCloseInterval = Math.max(5, Math.min(120, Number(seconds.value) || 15));
    seconds.value = String(settings.autoCloseInterval);
    void save();
  });
  const secondsHint = h("span", { class: "unit", text: t("seconds after you leave the island") });
  const showSeconds = () => {
    const on = close.value === "timer";
    seconds.style.display = on ? "" : "none";
    secondsHint.style.display = on ? "" : "none";
  };
  showSeconds();
  close.addEventListener("change", () => {
    settings.islandClose = parseCloseMode(close.value);
    showSeconds();
    void save();
  });

  return [
    group(t("Opening and closing")),
    setting(t("Close the open island"), null, close, h("span", { class: "with-unit" }, seconds, secondsHint)),
    setting(t("Open on hover"), t("opens the closed island when the mouse rests on it"),
      toggle(settings.islandHoverOpen, (v) => { settings.islandHoverOpen = v; void save(); })),
    setting(t("Hide when unused"), t("the closed island slips into the edge of the screen a minute after you leave it"),
      toggle(settings.islandAutoHide, (v) => { settings.islandAutoHide = v; void save(); })),
    group(t("The closed island")),
    setting(t("Say what's going on"), t("the closed island says what the AI is doing, and when an answer or an email arrives"),
      toggle(settings.compactActivity, (v) => { settings.compactActivity = v; void save(); })),
    setting(t("Show the music playing"), t("with play, pause and skip, when nothing else is showing"),
      toggle(settings.compactMedia, (v) => { settings.compactMedia = v; void save(); })),
    setting(t("Allow simple requests from the closed island"),
      t("reads and commands that only look (ls, git status…) are answered from the closed island; anything else opens the full card"),
      toggle(settings.quickApprovals !== false, (v) => { settings.quickApprovals = v; void save(); })),
    group(t("Live Activities")),
    googleCalendarRow(),
    calendarRow(),
  ];
}

const GOOGLE_CAL = {
  get hint() {
    return t("Sign in with your Google account: Lumo reads your calendars without changing them, and sees a new event within a minute (within 15 while saving energy). The client and the access stay in the {store}, and Lumo talks only to Google.", { store: KEY_STORE });
  },
  get guideTitle() { return t("Once only: your own Google client (free, about 10 minutes)"); },
  get guide() {
    return [
      t("In Google Cloud Console, create a project, for example “Lumo”."),
      t("APIs & Services → Library → Google Calendar API → Enable."),
      t("OAuth consent screen: External, then Publish app under Audience (in Testing, Google ends the access every 7 days)."),
      t("Clients → Create client → Desktop app, then paste its ID and secret here."),
    ];
  },
  get openConsole() { return t("Open Google Cloud Console"); },
  get clientId() { return t("Client ID"); },
  get clientSecret() { return t("Client secret"); },
  get signIn() { return t("Sign in with Google"); },
  get signInAgain() { return t("Sign in again"); },
  get waiting() { return t("Continue in the browser…"); },
  get waitingHint() { return t("The browser opened: choose the account and allow Lumo to read the calendar."); },
  get mismatch() { return t("Google says redirect_uri_mismatch? The client is not a Desktop app: create one of that type, paste its ID and secret, and sign in again."); },
  get unverified() { return t("Google says it hasn't verified the app? It is your own client: choose Advanced, then go to your project."); },
  get tooMany() { return t("The island reads at most {max} calendars: turn off the ones you don't need.", { max: MAX_GOOGLE_CALENDARS }); },
  get pasteFirst() { return t("Paste your Google client's ID and secret first."); },
  get ended() { return t("Access ended: sign in again."); },
  get pick() { return t("Calendars to show on the island"); },
  get removeClient() { return t("Remove client"); },
  get notRevoked() { return t("Google could not be reached: Lumo no longer uses the access, but to end it at Google too, remove Lumo in your Google account (Security → Third-party connections)."); },
  shown: (shown: number, count: number) => t("Calendars on the island: {shown} of {count}", { shown, count }),
};

/** Where step 1 and 2 of the guide happen: the Calendar API's page, which offers to pick or create a project. */
const GOOGLE_CONSOLE = "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com";

/**
 * Settings → Island → Google Calendar: the user's own OAuth client (a short
 * guide to make one in Google Cloud Console, its ID and secret), the sign-in
 * in the browser (google_calendar.rs), then the account's calendars to pick
 * for the island (settings.googleCalendars, core/google-calendar.ts).
 */
function googleCalendarRow(): HTMLElement {
  const dotEl = statusDot(false);
  const body = h("div", { class: "mail-accounts", style: "flex:1 1 auto;min-width:0" });
  const row = wideSetting(h("span", { class: "with-dot" }, "Google Calendar", dotEl), GOOGLE_CAL.hint, body);
  const sync = new GoogleSync((path, query) => Bridge.googleCalendarGet(path, query));
  let problem = "";
  /** While a sign-in waits for the browser: asks each second whether it ended (here or in another Settings), then draws the row again. */
  let waitTimer: number | null = null;
  /** The status the row was last drawn with. */
  let drawn: GoogleCalendarStatus | null = null;

  const problemLine = () => problem
    ? h("div", { class: "mail-account-error" }, h("i", { class: "dot", style: "background:#f4505e" }), h("span", { text: problem }))
    : null;

  const signIn = async (button: HTMLButtonElement) => {
    button.disabled = true;
    problem = "";
    // The browser opens; the row says what to do there until it comes back.
    window.setTimeout(() => void render(), 300);
    try {
      await Bridge.googleCalendarSignIn();
      sync.reset();
      // Security shows the calendar's row from now on.
      for (const redraw of declaredViews) redraw();
    } catch (err) {
      problem = errorText(err);
    } finally {
      void render();
    }
  };

  const clientForm = (stored: boolean) => {
    const field = (label: string, type: string, placeholder: string) => {
      const input = h("input", { type, placeholder, autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
      return { input, row: h("div", { class: "field-row" }, h("label", { text: label }), input) };
    };
    const id = field(GOOGLE_CAL.clientId, "text", stored ? CHAT_STRINGS.stored : "…apps.googleusercontent.com");
    const secret = field(GOOGLE_CAL.clientSecret, "password", stored ? CHAT_STRINGS.stored : "GOCSPX-…");
    const go = h("button", { class: "primary", text: GOOGLE_CAL.signIn }) as HTMLButtonElement;
    go.addEventListener("click", async () => {
      const [idValue, secretValue] = [id.input.value.trim(), secret.input.value.trim()];
      // Empty fields keep what is stored; a new client needs both.
      if ((!idValue || !secretValue) && !(stored && !idValue && !secretValue)) {
        problem = GOOGLE_CAL.pasteFirst;
        void render();
        return;
      }
      try {
        if (idValue) await Bridge.secretSet("google-calendar-client-id", idValue);
        if (secretValue) await Bridge.secretSet("google-calendar-client-secret", secretValue);
      } catch (err) {
        problem = errorText(err);
        void render();
        return;
      }
      void signIn(go);
    });
    const consoleBtn = h("button", { text: GOOGLE_CAL.openConsole });
    consoleBtn.addEventListener("click", () => void Bridge.openUrl(GOOGLE_CONSOLE));
    const guide = h("div", { class: "section-note" },
      h("div", { class: "mail-account-form-title", text: GOOGLE_CAL.guideTitle }),
      h("ol", { style: "margin:6px 0 8px 18px;display:flex;flex-direction:column;gap:3px" },
        ...GOOGLE_CAL.guide.map((step) => h("li", { text: step }))),
      consoleBtn);
    // Disconnect keeps the client (Google Cloud Console may not show its secret again): it goes only from here.
    const remove = stored ? h("button", { class: "danger", text: GOOGLE_CAL.removeClient }) as HTMLButtonElement : null;
    remove?.addEventListener("click", async () => {
      remove.disabled = true;
      try {
        await Bridge.secretClear("google-calendar-client-id");
        await Bridge.secretClear("google-calendar-client-secret");
        problem = "";
      } catch (err) {
        problem = errorText(err);
      }
      void render();
    });
    return [guide, h("div", { class: "field-rows" }, id.row, secret.row), h("div", { class: "mail-account-actions", style: "justify-content:flex-start" }, go, remove)];
  };

  const signOutButton = () => {
    const out = h("button", { class: "danger", text: CHAT_STRINGS.disconnect }) as HTMLButtonElement;
    out.addEventListener("click", async () => {
      out.disabled = true;
      try {
        const revoked = await Bridge.googleCalendarSignOut();
        sync.reset();
        problem = revoked ? "" : GOOGLE_CAL.notRevoked;
        for (const redraw of declaredViews) redraw();
      } catch (err) {
        problem = errorText(err);
      }
      void render();
    });
    return out;
  };

  const calendarsList = async (list: HTMLElement, account: HTMLElement, line: HTMLElement, unreadable: Record<string, string>) => {
    try {
      const calendars = await sync.list();
      const picks = () => settings.googleCalendars ?? {};
      // The island reads the first MAX_GOOGLE_CALENDARS shown (core/google-calendar.ts): the count says so.
      const count = () => {
        const shown = calendars.filter((c) => isShown(c, picks())).length;
        line.textContent = GOOGLE_CAL.shown(Math.min(shown, MAX_GOOGLE_CALENDARS), calendars.length);
        line.classList.toggle("bad", shown > MAX_GOOGLE_CALENDARS);
        line.title = shown > MAX_GOOGLE_CALENDARS ? GOOGLE_CAL.tooMany : "";
        tooMany.style.display = shown > MAX_GOOGLE_CALENDARS ? "" : "none";
      };
      const tooMany = h("span", { class: "hint", text: GOOGLE_CAL.tooMany, style: "margin:4px 0 0 2px" });
      const primary = calendars.find((c) => c.primary);
      if (primary) account.textContent = primary.id;
      count();
      list.replaceChildren(h("span", { class: "hint", text: GOOGLE_CAL.pick, style: "margin:4px 0 0 2px" }), tooMany,
        ...calendars.map((c) => h("div", { class: "mail-account", style: "grid-template-columns:auto minmax(0,1fr) auto" },
          h("i", { class: "dot", style: `background:${c.color}` }),
          h("div", { class: "mail-account-text" }, h("span", { class: "mail-account-address", text: c.name, title: c.name }),
            // Google no longer lets the account read it (no longer shared, deleted): its events left the island, and this says why.
            unreadable[c.id] ? h("span", { class: "mail-account-line bad", text: unreadable[c.id], title: unreadable[c.id] }) : null),
          toggle(isShown(c, picks()), (on) => {
            settings.googleCalendars = { ...picks(), [c.id]: on };
            count();
            void save();
          }))));
    } catch (err) {
      // Lumo is paused: nothing is read until it resumes, and nothing failed.
      if (errorText(err) === "paused") return;
      // Google may have refused the permission on this very ask: then the row offers Sign in again.
      if ((await Bridge.googleCalendarStatus())?.needsSignIn) {
        void render();
        return;
      }
      line.textContent = errorText(err);
      line.classList.add("bad");
    }
  };

  const render = async () => {
    const status = await Bridge.googleCalendarStatus();
    if (!status) return;
    drawn = status;
    if (waitTimer != null) window.clearInterval(waitTimer);
    waitTimer = null;
    const parts: (HTMLElement | null)[] = [];
    if (status.signingIn) {
      dotEl.style.background = "#f5a524";
      const cancel = h("button", { text: t("Cancel") }) as HTMLButtonElement;
      cancel.addEventListener("click", () => {
        cancel.disabled = true;
        void Bridge.googleCalendarCancel();
      });
      parts.push(h("div", { class: "mail-account-actions", style: "justify-content:flex-start" },
        h("button", { text: GOOGLE_CAL.waiting, disabled: true }), cancel),
        h("span", { class: "hint", text: GOOGLE_CAL.waitingHint }),
        h("span", { class: "hint", text: GOOGLE_CAL.unverified }),
        h("span", { class: "hint", text: GOOGLE_CAL.mismatch }));
      waitTimer = window.setInterval(async () => {
        if (!row.isConnected) {
          if (waitTimer != null) window.clearInterval(waitTimer);
          waitTimer = null;
          return;
        }
        if (!(await Bridge.googleCalendarStatus())?.signingIn) void render();
      }, 1_000);
    } else if (status.signedIn) {
      const bad = status.needsSignIn;
      dotEl.style.background = bad ? "#f4505e" : "#22c55e";
      const account = h("span", { class: "mail-account-address", text: "Google" });
      const line = h("span", { class: bad ? "mail-account-line bad" : "mail-account-line", text: bad ? GOOGLE_CAL.ended : "" });
      const again = bad ? h("button", { class: "primary", text: GOOGLE_CAL.signInAgain }) as HTMLButtonElement : null;
      again?.addEventListener("click", () => void signIn(again));
      parts.push(h("div", { class: "mail-account", style: bad ? "" : "grid-template-columns:auto minmax(0,1fr) auto" },
        h("i", { class: "dot", style: `background:${bad ? "#f4505e" : "#22c55e"}` }),
        h("div", { class: "mail-account-text" }, h("div", { class: "mail-account-name" }, account), line),
        again, signOutButton()));
      const list = h("div", { class: "mail-account-list" });
      parts.push(list);
      if (!bad) void calendarsList(list, account, line, status.unreadable ?? {});
    } else {
      dotEl.style.background = "#f4505e";
      parts.push(...clientForm(status.client));
    }
    parts.push(problemLine());
    body.replaceChildren(...parts.filter((p): p is HTMLElement => p != null));
  };
  void render();
  // Back on screen: the island may have learned meanwhile that Google ended the access (or a sign-in in the other window).
  const recheck = async () => {
    if (waitTimer != null || !row.isConnected) return;
    const status = await Bridge.googleCalendarStatus();
    if (status && (status.signedIn !== drawn?.signedIn || status.needsSignIn !== drawn?.needsSignIn
      || JSON.stringify(status.unreadable ?? {}) !== JSON.stringify(drawn?.unreadable ?? {}))) void render();
  };
  const onMessage = (e: MessageEvent) => {
    if (!row.isConnected) {
      window.removeEventListener("message", onMessage);
      return;
    }
    if (e.source === window.parent && e.origin === location.origin && e.data === FRAME_SHOWN) void recheck();
  };
  window.addEventListener("message", onMessage);
  whileShown(row, "focus", () => void recheck());
  return row;
}

/** The live activities' calendar: its iCal address, kept in the credential store (calendar.rs). */
function calendarRow(): HTMLElement {
  const key = "calendar-ics-url";
  const input = h("input", {
    type: "password",
    placeholder: "https://calendar.google.com/calendar/ical/…/basic.ics",
    autocomplete: "off",
    spellcheck: "false",
    style: "flex:1 1 auto;min-width:0",
  }) as HTMLInputElement;
  const dotEl = statusDot(false);
  const saveBtn = h("button", { text: t("Save") });
  const removeBtn = h("button", { class: "danger", text: CHAT_STRINGS.remove });
  const show = (stored: boolean) => {
    input.placeholder = stored ? CHAT_STRINGS.stored : "https://calendar.google.com/calendar/ical/…/basic.ics";
    dotEl.style.background = stored ? "#22c55e" : "#f4505e";
    removeBtn.style.display = stored ? "" : "none";
  };
  show(false);
  void Bridge.secretPresent(key).then((on) => show(on === true));
  // An empty field saves nothing: the address goes only with Remove.
  saveBtn.addEventListener("click", async () => {
    const value = input.value.trim();
    if (!value) return;
    try {
      await Bridge.secretSet(key, value);
      input.value = "";
      show(true);
      // Security shows the calendar's row from now on.
      for (const redraw of declaredViews) redraw();
    } catch {
      dotEl.style.background = "#f5a524";
    }
  });
  removeBtn.addEventListener("click", async () => {
    try {
      await Bridge.secretClear(key);
      show(false);
      for (const redraw of declaredViews) redraw();
    } catch {
      dotEl.style.background = "#f5a524";
    }
  });
  return wideSetting(h("span", { class: "with-dot" }, t("Calendar"), dotEl),
    t("The calendar's secret iCal address. Google Calendar: Settings → your calendar → Integrate calendar → Secret address in iCal format. It stays in the {store}, and Lumo only reads it.", { store: KEY_STORE }),
    input, saveBtn, removeBtn);
}

/**
 * Settings → General → Language: "System" follows the
 * system's language when Lumo has it (else English), or one of the ten.
 * Both windows and the tray switch in place, without a restart.
 */
export function languageRow(): HTMLElement {
  const select = h("select", {}) as HTMLSelectElement;
  select.append(h("option", { value: "", text: t("System") }));
  for (const { code, name } of LANGUAGES) select.append(h("option", { value: code, text: name, lang: code }));
  select.value = LANGUAGES.some((l) => l.code === settings.language) ? settings.language : "";
  select.addEventListener("change", () => {
    settings.language = select.value;
    void save();
    applyLanguage();
  });
  return setting(t("Language"), null, select);
}
