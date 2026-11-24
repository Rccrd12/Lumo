// A local model's terminal (src-tauri/src/terminal.rs): its commands run in
// the chat's folder of copies, in the Windows sandbox. What the island keeps
// of them: the card that asks for one (who asks, with the internet or not, for
// how long at most), and each command that ran, under its answer and saved
// with the chat.

/** A command's card (terminal.rs `lumo_terminal`): who asks, and how it will run. */
export interface TerminalAsk {
  /** The provider that asks ("Ollama", "LM Studio"…), and its colour. */
  agent: string;
  color: string;
  /** It wants the internet, for this command only. */
  internet: boolean;
  /** It is stopped after this many seconds. */
  seconds: number;
}

/** A command that ran, as the answer shows it (terminal.rs `chat-command`). */
export interface RanCommand {
  command: string;
  /** Its exit code; none when it was stopped or never started. */
  code?: number;
  ok: boolean;
  ms: number;
  /** Stopped at its time limit. */
  stopped?: boolean;
  /** The sandbox refused something it tried. */
  denied?: boolean;
  /** It had the internet. */
  internet?: boolean;
  /** The end of what it printed (terminal.rs SHOWN_OUTPUT). */
  output: string;
}

/** The longest command and output kept, whatever comes (what terminal.rs sends is shorter). */
const MAX_COMMAND = 4_000;
const MAX_OUTPUT = 2_048;
/** The most commands kept with one answer. */
export const MAX_COMMANDS = 12;

/** A card's `lumo_terminal`, checked: null when it is not one. */
export function terminalAskOf(raw: unknown): TerminalAsk | null {
  const r = raw as Partial<Record<keyof TerminalAsk, unknown>> | null;
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  const seconds = typeof r.seconds === "number" && Number.isFinite(r.seconds) && r.seconds > 0 ? Math.round(r.seconds) : 120;
  return {
    agent: typeof r.agent === "string" && r.agent.trim() ? r.agent.trim().slice(0, 60) : "Lumo",
    color: typeof r.color === "string" && /^#[0-9a-f]{3,8}$/i.test(r.color) ? r.color : "#F5F6F8",
    internet: r.internet === true,
    seconds,
  };
}

/** One command, checked (an event, or a chat read back from storage): null when it is not one. */
export function ranCommandOf(raw: unknown): RanCommand | null {
  const r = raw as Partial<Record<keyof RanCommand, unknown>> | null;
  if (!r || typeof r !== "object" || typeof r.command !== "string" || !r.command.trim()) return null;
  const output = typeof r.output === "string" ? r.output : "";
  return {
    command: r.command.slice(0, MAX_COMMAND),
    ...(typeof r.code === "number" && Number.isInteger(r.code) ? { code: r.code } : {}),
    ok: r.ok === true,
    ms: typeof r.ms === "number" && Number.isFinite(r.ms) && r.ms >= 0 ? Math.round(r.ms) : 0,
    ...(r.stopped === true ? { stopped: true } : {}),
    ...(r.denied === true ? { denied: true } : {}),
    ...(r.internet === true ? { internet: true } : {}),
    output: output.length > MAX_OUTPUT ? `…\n${output.slice(-MAX_OUTPUT)}` : output,
  };
}

/** An answer's commands, checked; undefined when there are none. */
export function cleanCommands(raw: unknown): RanCommand[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.map(ranCommandOf).filter((c): c is RanCommand => c != null).slice(-MAX_COMMANDS);
  return out.length ? out : undefined;
}

/** How a command ended, for its line: done, refused by the sandbox, stopped at its limit, or failed. */
export type CommandEnd = "ok" | "denied" | "stopped" | "failed";

export function commandEnd(c: RanCommand): CommandEnd {
  if (c.stopped) return "stopped";
  if (c.ok) return "ok";
  return c.denied ? "denied" : "failed";
}
