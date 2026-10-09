// Gemini Live — what the model asks the computer for (protocol.ts TOOL), and
// what it gets back. Each call runs once, when the model asks; nothing here
// watches anything on its own. Pictures (a screenshot, an image file) go to
// the model as a video frame, through the host; the answer only says so.
//
// The screenshot files screen.rs writes are deleted as soon as the picture
// is taken from them: nothing of the screen is kept on this computer.

import { Bridge, type LiveReading } from "../core/bridge";
import { compactTimer, parseDuration, timerLeft } from "../core/compact";
import { t } from "../i18n/i18n";
import { TOOL, type FunctionCall, type ToolAnswer } from "./protocol";
import { LIVE_STRINGS as S } from "./strings";

export interface ToolHost {
  /** Settings → Voice allows the screen. */
  screen: boolean;
  /** "Claude Code" or "Antigravity CLI". */
  helper: string;
  /** Shows the model these pictures (data URLs), as one frame. */
  showPictures(dataUrls: string[]): Promise<void>;
  /** What the call view says the model is doing; null when it is done. */
  doing(label: string | null): void;
  /** The model said goodbye. */
  end(): void;
}

/** An error from Rust or the bridge, as words for the model. */
export function errorText(err: unknown): string {
  const text = String((err as { message?: string })?.message ?? err ?? "").replace(/^Error:\s*/, "").trim();
  return text || t("Unexpected API response.");
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** The last part of a path, for "Reading report.pdf". */
export function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** What the model hears of a read file. */
export function readingResult(r: LiveReading): Record<string, unknown> {
  switch (r.kind) {
    case "text":
      return r.cut ? { name: r.name, text: r.text, note: "Only the beginning of the file: it is longer." } : { name: r.name, text: r.text };
    case "folder":
      return {
        folder: r.path,
        entries: r.entries.map((e) => ({ name: e.name, folder: e.dir, size: e.size, modified: e.modified })),
        ...(r.omitted ? { notListed: r.omitted } : {}),
      };
    case "document":
      return { name: r.name, size: r.size, note: "This is a document: call read_document with a question to read it." };
    case "image":
      return { name: r.name, note: "The image is now shown to you." };
  }
}

/** Runs one call of the model's; never throws (a failure is the answer's `error`). */
export async function runTool(call: FunctionCall, host: ToolHost): Promise<ToolAnswer> {
  const base = { id: call.id, name: call.name };
  try {
    const result = await run(call, host);
    // Heard once Gemini has finished its sentence; the goodbye needs no answer.
    return { ...base, result, scheduling: call.name === TOOL.end ? "SILENT" : "WHEN_IDLE" };
  } catch (err) {
    return { ...base, error: errorText(err), scheduling: "WHEN_IDLE" };
  } finally {
    if (call.name !== TOOL.end) host.doing(null);
  }
}

async function run(call: FunctionCall, host: ToolHost): Promise<unknown> {
  const a = call.args;
  switch (call.name) {
    case TOOL.look: {
      if (!host.screen) throw new Error("The user turned screenshots off in Lumo's settings.");
      host.doing(t(S.lookingScreen));
      const display = typeof a.display === "number" && Number.isInteger(a.display) && a.display >= 0 ? a.display : null;
      const shots = await Bridge.screenCapture(display);
      // The files were only the way here: the picture goes, the files are deleted.
      void Bridge.screenDiscard(shots.map((s) => s.path));
      if (shots.length === 0) throw new Error("No screen was captured.");
      await host.showPictures(shots.map((s) => s.preview));
      return {
        shown: shots.length === 1 ? "The screenshot is now shown to you." : `Screenshots of ${shots.length} displays, side by side from display 0, are now shown to you.`,
        displays: shots.map((s) => ({ display: s.display, width: s.width, height: s.height })),
      };
    }
    case TOOL.windows: {
      host.doing(t(S.lookingWindows));
      const list = await Bridge.screenWindows();
      return { windows: list.map((w) => ({ title: w.title, app: w.app, ...(w.active ? { active: true } : {}), ...(w.minimized ? { minimized: true } : {}) })) };
    }
    case TOOL.explorer: {
      host.doing(t(S.lookingExplorer));
      const folder = await Bridge.screenExplorer();
      if (!folder) return { none: "No folder is open in File Explorer." };
      return {
        folder: folder.path,
        entries: folder.entries.map((e) => ({ name: e.name, folder: e.dir, size: e.size, modified: e.modified })),
        ...(folder.omitted ? { notListed: folder.omitted } : {}),
      };
    }
    case TOOL.find: {
      const name = str(a.name);
      if (!name) throw new Error("Say which name to look for.");
      host.doing(t(S.searchingFor, { pattern: name }));
      const found = await Bridge.liveFind(name, str(a.folder) || null);
      if (found.length === 0) return { none: `Nothing named like "${name}" was found.` };
      return { found: found.map((f) => ({ path: f.path, ...(f.dir ? { folder: true } : { size: f.size }), modified: f.modified })) };
    }
    case TOOL.read: {
      const path = str(a.path);
      if (!path) throw new Error("Say which path to read.");
      host.doing(t(S.reading, { name: baseName(path) }));
      const reading = await Bridge.liveRead(path);
      if (reading.kind === "image") await host.showPictures([`data:${reading.mime};base64,${reading.data}`]);
      return readingResult(reading);
    }
    case TOOL.document: {
      const path = str(a.path);
      if (!path) throw new Error("Say which file to read.");
      host.doing(t(S.reading, { name: baseName(path) }));
      return { answer: await Bridge.liveDocument(path, str(a.question) || "Summarise it.") };
    }
    case TOOL.open: {
      const target = str(a.target);
      if (!target) throw new Error("Say what to open.");
      host.doing(t(S.opening, { name: /^https?:\/\//i.test(target) ? target : baseName(target) }));
      return { opened: await Bridge.liveOpen(target) };
    }
    case TOOL.openApp: {
      const name = str(a.name);
      if (!name) throw new Error("Say which app to open.");
      host.doing(t(S.opening, { name }));
      return { started: await Bridge.liveOpenApp(name) };
    }
    case TOOL.point: {
      if (!host.screen) throw new Error("The user turned screenshots off in Lumo's settings.");
      const target = str(a.target);
      if (!target) throw new Error("Say which element to point at.");
      host.doing(t(S.pointing));
      const what = await Bridge.livePoint(target, str(a.name), str(a.label).slice(0, 60));
      return { shown: `A pointer now shows it on the user's screen for a few seconds: ${what}. Say what to do there.` };
    }
    case TOOL.type: {
      const text = typeof a.text === "string" ? a.text : "";
      if (!text.trim()) throw new Error("Say which text to type.");
      host.doing(t(S.typing));
      const typed = await Bridge.liveType(text);
      return {
        typed: typed.chars,
        into: typed.title ? `${typed.title} (${typed.app})` : typed.app,
        ...(typed.flattened ? { note: "Line breaks were typed as spaces: the window in front is a terminal, where a line break would run a command." } : {}),
      };
    }
    case TOOL.helper: {
      const task = str(a.task);
      if (!task) throw new Error("Say what the task is.");
      host.doing(t(S.asked, { helper: host.helper }));
      const answer = await Bridge.liveHelp(task, str(a.folder) || null);
      return { helper: host.helper, answer };
    }
    case TOOL.stopHelper:
      await Bridge.liveHelpStop();
      return { stopped: true };
    case TOOL.timer: {
      const ms = parseDuration(str(a.duration));
      if (ms == null) throw new Error("Say how long, e.g. \"10m\".");
      const timer = compactTimer(ms, str(a.label));
      return { started: true, rings_in: timerLeft(timer.total) };
    }
    case TOOL.music: {
      const action = str(a.action);
      const which = action === "next" ? "next" : action === "previous" ? "previous" : action === "play_pause" ? "toggle" : null;
      if (!which) throw new Error("Say play_pause, next or previous.");
      const done = await Bridge.mediaControl(which);
      if (!done) throw new Error("Nothing is playing that can be controlled.");
      return { done: true };
    }
    case TOOL.end:
      host.end();
      return { ending: true };
    default:
      throw new Error(`There is no tool called ${call.name}.`);
  }
}
