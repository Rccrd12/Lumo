// Gemini Live — the microphone and Gemini's voice, with WebAudio.
//
// The microphone is opened with the system's echo cancellation, so Gemini
// does not hear itself and the user can talk over it. Its samples come from
// an AudioWorklet (public/live-mic-worklet.js), are brought down to 16 kHz
// here and handed out 40 ms at a time. Gemini's voice is queued gap-free at
// 24 kHz; `clear()` drops what is queued when the user interrupts it.
//
// Both exist only during a call: nothing here runs, or holds the microphone,
// once it ends.

import { Downsampler, OUTPUT_RATE, floatToPcm16, level, pcm16ToFloat } from "./protocol";

export type MicProblem = "denied" | "missing" | "failed";

export class MicError extends Error {
  problem: MicProblem;
  constructor(problem: MicProblem, message: string) {
    super(message);
    this.problem = problem;
  }
}

type AudioContextCtor = typeof AudioContext;

function audioContext(): AudioContextCtor | null {
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export class Microphone {
  /** 40 ms of 16 kHz PCM16, while not muted. */
  onChunk: ((pcm: Uint8Array) => void) | null = null;
  muted = false;
  /** How loud the user is right now, 0…1. */
  level = 0;

  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioNode | null = null;
  private down: Downsampler | null = null;

  async start(): Promise<void> {
    const media = navigator.mediaDevices;
    const Ctx = audioContext();
    if (!media?.getUserMedia || !Ctx) throw new MicError("failed", "no getUserMedia");
    try {
      this.stream = await media.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        video: false,
      });
    } catch (err) {
      const name = (err as { name?: string })?.name ?? "";
      if (name === "NotAllowedError" || name === "SecurityError") throw new MicError("denied", String(err));
      if (name === "NotFoundError" || name === "OverconstrainedError") throw new MicError("missing", String(err));
      throw new MicError("failed", String(err));
    }
    try {
      this.ctx = new Ctx();
      if (this.ctx.state === "suspended") await this.ctx.resume();
      this.down = new Downsampler(this.ctx.sampleRate);
      this.source = this.ctx.createMediaStreamSource(this.stream);
      this.node = await this.tap(this.ctx);
      this.source.connect(this.node);
    } catch (err) {
      this.stop();
      throw new MicError("failed", String(err));
    }
  }

  /** The worklet where the webview has one, else the older ScriptProcessor. */
  private async tap(ctx: AudioContext): Promise<AudioNode> {
    if (ctx.audioWorklet && typeof AudioWorkletNode !== "undefined") {
      try {
        await ctx.audioWorklet.addModule("/live-mic-worklet.js");
        const node = new AudioWorkletNode(ctx, "lumo-microphone", { numberOfInputs: 1, numberOfOutputs: 0 });
        node.port.onmessage = (e: MessageEvent<Float32Array>) => this.take(e.data);
        return node;
      } catch {
        // Falls through to the ScriptProcessor.
      }
    }
    const proc = ctx.createScriptProcessor(2048, 1, 1);
    proc.onaudioprocess = (e) => this.take(e.inputBuffer.getChannelData(0));
    // A ScriptProcessor only runs when connected to the output; it writes silence.
    proc.connect(ctx.destination);
    return proc;
  }

  private take(samples: Float32Array) {
    this.level = this.muted ? 0 : level(samples);
    if (this.muted || !this.down) return;
    for (const block of this.down.push(samples)) this.onChunk?.(floatToPcm16(block));
  }

  setMuted(on: boolean) {
    this.muted = on;
    if (on) {
      this.level = 0;
      this.down?.reset();
    }
  }

  stop() {
    try {
      this.source?.disconnect();
      this.node?.disconnect();
    } catch {
      // Already disconnected.
    }
    if (this.node instanceof AudioWorkletNode) this.node.port.onmessage = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.stream = null;
    this.source = null;
    this.node = null;
    this.down = null;
    this.level = 0;
  }
}

/** A little room before the first chunk, so a late one never leaves a gap. */
const LEAD_S = 0.06;

export class Speaker {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private out: GainNode | null = null;
  private next = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private probe: Float32Array<ArrayBuffer> | null = null;

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctx = audioContext();
    if (!Ctx) return null;
    this.ctx = new Ctx();
    this.out = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.out.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    return this.ctx;
  }

  /** Opens the output on the user's click, so the first words are never held back. */
  async open() {
    const ctx = this.ensure();
    if (ctx?.state === "suspended") await ctx.resume().catch(() => {});
  }

  /** Queues one chunk of Gemini's voice (PCM16 at 24 kHz) after the last one. */
  play(pcm: Uint8Array) {
    const ctx = this.ensure();
    if (!ctx || !this.out) return;
    const samples = pcm16ToFloat(pcm);
    if (samples.length === 0) return;
    const buffer = ctx.createBuffer(1, samples.length, OUTPUT_RATE);
    buffer.getChannelData(0).set(samples);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.out);
    const start = Math.max(this.next, ctx.currentTime + (this.playing ? 0 : LEAD_S));
    src.start(start);
    this.next = start + buffer.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
  }

  /** The user spoke over Gemini: what is queued goes. */
  clear() {
    for (const src of this.sources) {
      try {
        src.stop();
      } catch {
        // Already ended.
      }
    }
    this.sources.clear();
    this.next = 0;
  }

  get playing(): boolean {
    return !!this.ctx && this.next > this.ctx.currentTime;
  }

  /** Seconds of voice still queued. */
  get queued(): number {
    return this.ctx ? Math.max(0, this.next - this.ctx.currentTime) : 0;
  }

  /** How loud Gemini is right now, 0…1. */
  level(): number {
    if (!this.analyser || !this.playing) return 0;
    if (!this.probe) this.probe = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(this.probe);
    return level(this.probe);
  }

  close() {
    this.clear();
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.analyser = null;
    this.out = null;
    this.probe = null;
  }
}
