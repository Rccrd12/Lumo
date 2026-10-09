// Gemini Live — one spoken conversation at a time, from the island.
//
// A call starts on the user's click (the microphone button, or the shortcut)
// and nothing listens before that. Rust gives a short-lived token for each
// connection (live.rs), so the Google AI key never reaches this page. Google
// closes a connection every ten minutes or so and says so first (goAway):
// the call moves to a new one with the resumption handle, between sentences,
// and the user hears nothing of it. The call ends on End, when Gemini says
// goodbye, after 5 minutes with nobody speaking, or on an error, and what was
// said is kept in the chat's history.
//
// While a call is on, Lumo shows it (State.liveState): speaking, thinking, or
// at work on a tool. The call goes on when the island closes, and the
// compact island stays on screen until it ends.

import { Bridge, onEvent, type LiveHelperActivity } from "../core/bridge";
import { chatTitle, newChatId, saveChat } from "../core/chats";
import { HOST_OS } from "../core/pills";
import { State } from "../core/state";
import type { BotStateName } from "../core/layout";
import { LANGUAGES, language, t } from "../i18n/i18n";
import { activityLabel } from "../views/chat";
import { MicError, Microphone, Speaker } from "./audio";
import {
  FRAME_GAP_MS, RECONNECT_AHEAD_MS, SILENCE_ENDS_MS, TOOL, audioEndMessage, audioMessage, base64ToBytes,
  bytesToBase64, closeDetail, fitSize, liveModelName, frameMessage, isExtended, parseLiveModel, parseServerMessage,
  parseThinking, parseVoice, setupMessage, textMessage, toolResponseMessage, type FunctionCall, type LiveConfig,
  type ServerEvent, type ToolAnswer,
} from "./protocol";
import { LIVE_STRINGS as S } from "./strings";
import { runTool } from "./tools";
import { Transcript } from "./transcript";

export type LivePhase = "off" | "connecting" | "listening" | "thinking" | "speaking" | "reconnecting";

/** Who takes what Gemini can't do (Settings → Voice). */
export function helperName(id: string): string {
  return id === "antigravity-cli" ? "Antigravity CLI" : "Claude Code";
}

/** What Lumo looks like during a call. */
export function liveBotState(phase: LivePhase, working: boolean): BotStateName | null {
  if (phase === "off") return null;
  if (phase === "speaking") return "working";
  if (working) return "searching";
  if (phase === "listening") return null;
  return "thinking";
}

/** The English name of the interface language, for the model. */
function languageName(): string {
  const code = language();
  if (code === "en") return "English";
  const names: Record<string, string> = {
    "zh-Hans": "Simplified Chinese", hi: "Hindi", es: "Spanish", ar: "Arabic", fr: "French",
    bn: "Bengali", "pt-BR": "Brazilian Portuguese", ru: "Russian", id: "Indonesian",
  };
  return names[code] ?? LANGUAGES.find((l) => l.code === code)?.name ?? "English";
}

function localNow(): string {
  const d = new Date();
  return d.toLocaleString("en-GB", {
    weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

/** One picture or several side by side, as a JPEG the size Gemini takes. */
async function toJpeg(dataUrls: string[]): Promise<string> {
  const images = await Promise.all(dataUrls.map((src) => new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(t("The image is too large.")));
    img.src = src;
  })));
  const width = images.reduce((w, i) => w + i.naturalWidth, 0);
  const height = Math.max(...images.map((i) => i.naturalHeight));
  const size = fitSize(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = size.w;
  canvas.height = size.h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(t("Unexpected API response."));
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, size.w, size.h);
  const scale = size.w / width;
  let x = 0;
  for (const img of images) {
    ctx.drawImage(img, x * scale, 0, img.naturalWidth * scale, img.naturalHeight * scale);
    x += img.naturalWidth;
  }
  return canvas.toDataURL("image/jpeg", 0.82).replace(/^data:image\/jpeg;base64,/, "");
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class LiveSession {
  phase: LivePhase = "off";
  readonly transcript = new Transcript();
  muted = false;
  /** What a tool or the helper is doing, for the call view. */
  doing: string | null = null;
  /** Why the last call ended, when it did not end on End. */
  problem: string | null = null;
  /** The problem is a missing or refused key: the view offers Settings. */
  problemIsKey = false;
  /** The model of the call on now (or the last one). */
  model = "";

  private mic: Microphone | null = null;
  private speaker: Speaker | null = null;
  private ws: WebSocket | null = null;
  /** Bumped on every connection: what an old one still sends is dropped. */
  private generation = 0;
  private ready = false;
  private cfg: LiveConfig | null = null;
  private handle: string | null = null;
  /** Gemini is working on a reply (from the user's words to the turn's end). */
  private busy = false;
  /** Tool calls running, by id, with the connection they came on. */
  private running = new Map<string, { name: string; generation: number; cancelled: boolean }>();
  private chatId = "";
  private lastVoice = 0;
  private lastFrame = 0;
  private silenceTimer: ReturnType<typeof setInterval> | null = null;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  /** Google said it closes this connection: move between sentences, or by this time. */
  private moveBy: number | null = null;
  private moveTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnects = 0;
  private ending = false;
  private unlisten: (() => void) | null = null;
  /** Bumped by every start: an older start still waiting on Rust or the microphone gives up. */
  private call = 0;

  get active(): boolean {
    return this.phase !== "off";
  }

  /** How loud the user or Gemini is right now, 0…1, for the call view. */
  get level(): number {
    if (this.phase === "speaking") return this.speaker?.level() ?? 0;
    return this.mic?.level ?? 0;
  }

  // ── Start and end ─────────────────────────────────────────────────────────

  /** Starts a call (on a click or the shortcut). Does nothing while one is on. */
  async start() {
    if (this.active) return;
    const s = State.settings;
    this.cfg = {
      model: parseLiveModel(s.liveModel),
      thinking: parseThinking(s.liveThinking),
      voice: parseVoice(s.liveVoice),
      helper: helperName(s.liveHelper),
      screen: s.liveScreen && HOST_OS === "windows",
      languageName: languageName(),
      os: HOST_OS === "windows" ? "Windows" : "Linux",
      now: localNow(),
    };
    const call = ++this.call;
    const current = () => call === this.call && this.phase === "connecting";
    this.model = this.cfg.model;
    this.problem = null;
    this.problemIsKey = false;
    this.muted = false;
    this.doing = null;
    this.handle = null;
    this.busy = false;
    this.ending = false;
    this.reconnects = 0;
    this.moveBy = null;
    this.transcript.clear();
    this.chatId = newChatId();
    this.setPhase("connecting");

    // The speaker opens on the click, so the first words are never held back.
    this.speaker = new Speaker();
    void this.speaker.open();

    let token;
    try {
      token = await Bridge.liveToken();
    } catch (err) {
      if (!current()) return;
      const text = String(err).replace(/^Error:\s*/, "");
      this.fail(text, /API key|Settings/i.test(text));
      return;
    }
    if (!current()) return;
    if (!token) {
      this.fail(t(S.lost));
      return;
    }

    const mic = new Microphone();
    mic.onChunk = (pcm) => this.sendAudio(pcm);
    await Bridge.liveMicrophone(true);
    try {
      await mic.start();
    } catch (err) {
      if (!current()) return;
      const problem = err instanceof MicError ? err.problem : "failed";
      this.fail(t(problem === "denied" ? S.micDenied : problem === "missing" ? S.micMissing : S.micFailed));
      return;
    } finally {
      void Bridge.liveMicrophone(false);
    }
    // Ended (or started again) while the microphone opened: it closes at once.
    if (!current()) {
      mic.stop();
      return;
    }
    this.mic = mic;

    void onEvent<LiveHelperActivity>("live-helper-activity", (a) => {
      if (!this.active) return;
      this.doing = `${a.helper}: ${activityLabel({ kind: a.kind, detail: a.detail })}`;
      this.changed();
    }).then((un) => {
      if (this.active) this.unlisten = un;
      else un();
    });
    this.lastVoice = performance.now();
    this.silenceTimer = setInterval(() => this.checkSilence(), 15_000);
    this.connect(token.url, token.token);
  }

  /** Ends the call: the microphone closes, the helper stops, what was said is kept. */
  end(problem: string | null = null) {
    if (!this.active) return;
    this.problem = problem;
    this.remember();
    this.generation++;
    const ws = this.ws;
    this.ws = null;
    this.ready = false;
    if (ws) {
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close(1000);
      } catch {
        // Already closed.
      }
    }
    this.mic?.stop();
    this.mic = null;
    this.speaker?.close();
    this.speaker = null;
    if (this.running.size) void Bridge.liveHelpStop();
    this.running.clear();
    for (const timer of [this.drainTimer, this.moveTimer, this.notifyTimer]) if (timer) clearTimeout(timer);
    if (this.silenceTimer) clearInterval(this.silenceTimer);
    this.drainTimer = this.moveTimer = this.notifyTimer = null;
    this.silenceTimer = null;
    this.unlisten?.();
    this.unlisten = null;
    void Bridge.liveMicrophone(false);
    this.doing = null;
    this.busy = false;
    this.setPhase("off");
  }

  private fail(problem: string, key = false) {
    this.end(problem);
    this.problemIsKey = key;
    State.notify();
  }

  toggleMute() {
    if (!this.active) return;
    this.muted = !this.muted;
    this.mic?.setMuted(this.muted);
    // Google stops waiting for the rest of a sentence the microphone cut.
    if (this.muted) this.send(audioEndMessage());
    this.changed();
  }

  /** Typed in the call view: Gemini answers it as if it were said. */
  sendText(text: string) {
    const line = text.trim();
    if (!line || !this.ready) return;
    this.speaker?.clear();
    this.transcript.close();
    this.transcript.heard(line, true);
    this.busy = true;
    this.lastVoice = performance.now();
    this.send(textMessage(line));
    this.update();
  }

  // ── The connection ────────────────────────────────────────────────────────

  private connect(url: string, token: string) {
    const generation = ++this.generation;
    this.ready = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${url}?access_token=${encodeURIComponent(token)}`);
    } catch {
      this.fail(t(S.lost));
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    const decoder = new TextDecoder();
    ws.onopen = () => {
      if (generation !== this.generation || !this.cfg) return;
      ws.send(JSON.stringify(setupMessage(this.cfg, this.handle)));
    };
    ws.onmessage = (e: MessageEvent) => {
      if (generation !== this.generation) return;
      let data: unknown;
      try {
        data = JSON.parse(typeof e.data === "string" ? e.data : decoder.decode(e.data as ArrayBuffer));
      } catch {
        return;
      }
      for (const ev of parseServerMessage(data)) this.onEvent(ev);
    };
    ws.onerror = () => {
      // The close that follows says why.
    };
    ws.onclose = (e: CloseEvent) => {
      if (generation !== this.generation) return;
      this.onClose(e.code, e.reason, this.ready);
    };
  }

  private onClose(code: number, reason: string, wasReady: boolean) {
    this.ws = null;
    this.ready = false;
    if (!this.active || this.ending) {
      this.end(this.problem);
      return;
    }
    const detail = closeDetail(reason);
    // Refused outright (a bad setup, the key, the quota): trying again changes nothing.
    const refused = !wasReady || code === 1007 || code === 1008;
    if (!refused && this.handle && this.reconnects < 3) {
      void this.reconnect();
      return;
    }
    const key = /API key|API_KEY|permission|unauthenticated/i.test(detail);
    if (/quota|RESOURCE_EXHAUSTED/i.test(detail)) this.fail(t(S.quota, { model: liveModelName(this.model) }), true);
    else this.fail(detail ? t(S.closedBecause, { detail }) : t(S.lost), key);
  }

  /** A new connection carrying on the same conversation. */
  private async reconnect() {
    if (!this.active) return;
    this.reconnects++;
    this.moveBy = null;
    if (this.moveTimer) clearTimeout(this.moveTimer);
    this.moveTimer = null;
    const old = this.ws;
    this.generation++;
    this.ws = null;
    this.ready = false;
    if (old) {
      old.onclose = null;
      old.onmessage = null;
      try {
        old.close(1000);
      } catch {
        // Already closed.
      }
    }
    this.setPhase("reconnecting");
    if (this.reconnects > 1) await wait(600 * this.reconnects);
    let token;
    try {
      token = await Bridge.liveToken();
    } catch (err) {
      this.fail(String(err).replace(/^Error:\s*/, ""));
      return;
    }
    if (!this.active) return;
    if (!token) {
      this.fail(t(S.lost));
      return;
    }
    this.connect(token.url, token.token);
  }

  private send(message: unknown) {
    if (!this.ws || !this.ready || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  private sendAudio(pcm: Uint8Array) {
    // Nothing is sent before the setup is done, nor while moving connections.
    if (this.ready) this.send(audioMessage(bytesToBase64(pcm)));
  }

  // ── What Google sends ─────────────────────────────────────────────────────

  private onEvent(ev: ServerEvent) {
    switch (ev.kind) {
      case "ready":
        this.ready = true;
        // A connection that opened is a working one: the count starts again.
        if (this.phase === "reconnecting") this.reconnects = 0;
        this.setPhase("listening");
        this.update();
        break;
      case "audio":
        this.busy = true;
        this.lastVoice = performance.now();
        this.speaker?.play(base64ToBytes(ev.data));
        this.update();
        break;
      case "heard":
        this.lastVoice = performance.now();
        this.transcript.heard(ev.text);
        this.changed();
        break;
      case "said":
        this.lastVoice = performance.now();
        this.transcript.said(ev.text);
        this.changed();
        break;
      case "interrupted":
        this.speaker?.clear();
        this.transcript.close();
        this.update();
        break;
      case "turnComplete":
        this.transcript.close();
        // Extended Thinking may go on after its turn: its status says when it is done.
        if (!isExtended(this.model)) this.busy = false;
        this.remember();
        this.update();
        break;
      case "idle":
        this.busy = !ev.idle;
        this.update();
        break;
      case "voice":
        if (ev.speaking) this.lastVoice = performance.now();
        break;
      case "toolCall":
        for (const call of ev.calls) void this.runCall(call);
        break;
      case "toolCancel":
        for (const id of ev.ids) {
          const run = this.running.get(id);
          if (!run) continue;
          run.cancelled = true;
          if (run.name === TOOL.helper) void Bridge.liveHelpStop();
        }
        break;
      case "goAway":
        this.moveBy = performance.now() + ev.ms;
        if (this.moveTimer) clearTimeout(this.moveTimer);
        this.moveTimer = setTimeout(() => void this.reconnect(), Math.max(0, ev.ms - RECONNECT_AHEAD_MS));
        this.update();
        break;
      case "handle":
        this.handle = ev.handle;
        break;
    }
  }

  private async runCall(call: FunctionCall) {
    const generation = this.generation;
    this.running.set(call.id, { name: call.name, generation, cancelled: false });
    this.lastVoice = performance.now();
    this.update();
    const answer = await runTool(call, {
      screen: this.cfg?.screen ?? false,
      helper: this.cfg?.helper ?? "Claude Code",
      showPictures: (urls) => this.showPictures(urls),
      doing: (label) => {
        this.doing = label;
        this.changed();
      },
      end: () => this.finishAfterGoodbye(),
    });
    const run = this.running.get(call.id);
    this.running.delete(call.id);
    if (!this.active || !run || run.cancelled) {
      this.update();
      return;
    }
    if (call.name === TOOL.helper) {
      this.doing = t(answer.error != null ? S.helperStopped : S.helperDone, { helper: this.cfg?.helper ?? "" });
      this.changed();
    }
    this.answer(answer, run.generation);
    this.update();
  }

  /**
   * A tool's answer. One that comes back after the call moved to a new
   * connection (the helper can take minutes) is told to Gemini in words, as
   * the call it answers is gone with the old connection.
   */
  private answer(answer: ToolAnswer, generation: number) {
    const extended = isExtended(this.model);
    if (generation === this.generation) {
      this.send(toolResponseMessage([answer], extended));
      return;
    }
    if (answer.name === TOOL.end) return;
    const body = answer.error != null ? { error: answer.error } : { result: answer.result };
    this.send(textMessage(`[Lumo: the result of your earlier ${answer.name} call, which you haven't heard yet] ${JSON.stringify(body)}`));
  }

  private async showPictures(urls: string[]) {
    const jpeg = await toJpeg(urls);
    const since = performance.now() - this.lastFrame;
    if (since < FRAME_GAP_MS) await wait(FRAME_GAP_MS - since);
    this.lastFrame = performance.now();
    this.send(frameMessage(jpeg));
  }

  /** Gemini said goodbye and called end_conversation: the call ends once it has finished talking. */
  private finishAfterGoodbye() {
    if (this.ending) return;
    this.ending = true;
    const started = performance.now();
    const check = () => {
      if (!this.active) return;
      if (this.speaker?.playing && performance.now() - started < 10_000) {
        setTimeout(check, 200);
        return;
      }
      this.end();
    };
    setTimeout(check, 400);
  }

  private checkSilence() {
    if (!this.active || this.phase === "speaking" || this.running.size > 0) return;
    if (performance.now() - this.lastVoice > SILENCE_ENDS_MS) this.end(t(S.endedSilence));
  }

  // ── State ─────────────────────────────────────────────────────────────────

  /** Works out the phase from what is going on, and when to look again. */
  private update() {
    if (!this.active || this.phase === "connecting" || this.phase === "reconnecting") {
      this.changed();
      return;
    }
    const playing = this.speaker?.playing ?? false;
    const next: LivePhase = playing ? "speaking" : this.busy || this.running.size > 0 ? "thinking" : "listening";
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = null;
    if (playing) {
      // Look again once what is queued has been said.
      this.drainTimer = setTimeout(() => this.update(), Math.ceil((this.speaker?.queued ?? 0) * 1000) + 60);
    }
    // Google is closing this connection: move now, between sentences.
    if (this.moveBy != null && !playing && !this.busy && this.running.size === 0) {
      void this.reconnect();
      return;
    }
    this.setPhase(next);
  }

  private setPhase(phase: LivePhase) {
    const changed = phase !== this.phase;
    this.phase = phase;
    const shown = liveBotState(phase, this.running.size > 0);
    if (changed || State.liveState !== shown) {
      State.liveState = shown;
      State.liveActive = phase !== "off";
      State.notify();
    }
  }

  /** The view redraws, at most every 120 ms while words stream in. */
  private changed() {
    const shown = liveBotState(this.phase, this.running.size > 0);
    if (State.liveState !== shown) {
      State.liveState = shown;
      State.notify();
      return;
    }
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      State.notify();
    }, 120);
  }

  /** What was said, in the chat's history (after each turn and at the end). */
  private remember() {
    const turns = this.transcript.turns();
    if (!turns.some((x) => x.role === "user")) return;
    saveChat({
      id: this.chatId,
      title: chatTitle(turns),
      updatedAt: Date.now(),
      provider: "google",
      session: null,
      turns,
    });
  }
}

export const Live = new LiveSession();
