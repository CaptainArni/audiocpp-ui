// Continuous microphone capture with speech endpointing, for the Call tab.
//
// `MicRecorder` cannot do this job. MediaRecorder hands back an encoded blob
// *after* the fact, so by the time an energy meter says "speech started" the
// first phoneme has already been swallowed. A call needs raw PCM held in a
// rolling buffer, so the utterance can be cut with a pre-roll that begins
// before the speaker did.
//
// The detector is a plain energy gate with an adaptive noise floor rather than
// a wasm VAD: call audio is close-talk, and this is both good enough and
// dependency-free. `VadOptions` is the seam — a Silero/WebRTC detector can be
// swapped in behind it without the caller changing.

import { encodeWav, resampleMono } from "./wav";

export interface VadOptions {
  /** Silence that ends a turn. */
  hangoverMs: number;
  /** Audio kept from before speech was detected, so the onset isn't clipped. */
  prerollMs: number;
  /** Sample rate the utterance is delivered at (ASR wants 16 kHz). */
  targetRate: number;
  /** Ignore blips shorter than this — a cough or a chair, not a turn. */
  minSpeechMs?: number;
  /** Stop capturing a single utterance past this, whatever the VAD thinks. */
  maxUtteranceSec?: number;
  /**
   * How far above the noise floor counts as speech. Lower = more sensitive.
   *
   * Adjustable because one number cannot suit both a quiet talker in a still
   * room and a normal voice over a fan: too high and turns never start, too low
   * and the room ends the turn for you. Defaults to {@link DEFAULT_SPEECH_FACTOR}.
   */
  speechFactor?: number;
}

/** The tuned default: high enough not to trigger on room tone, low enough for a
 *  normal speaking voice at arm's length. */
export const DEFAULT_SPEECH_FACTOR = 2.8;

export interface VadCallbacks {
  /** ~50 Hz, 0..1, for the level ring. */
  onLevel?: (level: number) => void;
  /** Speech started — the UI can show it is hearing something. */
  onSpeechStart?: () => void;
  /** A complete utterance, already resampled and WAV-encoded. */
  onUtterance: (wav: File, durationSec: number) => void;
  onError?: (message: string) => void;
}

const FRAME = 1024;

/** Frames above the floor needed to call it speech (debounces transients). */
const ONSET_FRAMES = 3;

/** Absolute floor, so a dead-silent room doesn't make the gate infinitely touchy. */
const MIN_THRESHOLD = 0.006;

export class MicVad {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;

  /** Rolling pre-roll buffer, and the utterance being accumulated. */
  private preroll: Float32Array[] = [];
  private prerollFrames = 0;
  private speech: Float32Array[] = [];
  private speechFrames = 0;

  private speaking = false;
  private onsetCount = 0;
  private silenceFrames = 0;
  private noiseFloor = 0.01;
  private rate = 48000;
  private gated = false;
  private speechFactor: number;

  constructor(
    private readonly opts: VadOptions,
    private readonly cb: VadCallbacks,
  ) {
    this.speechFactor = opts.speechFactor ?? DEFAULT_SPEECH_FACTOR;
  }

  /** Retune mid-call. The whole point of the control is hearing the difference
   *  while you talk, so this must not require restarting the call. */
  setSpeechFactor(factor: number): void {
    this.speechFactor = factor;
  }

  get sampleRate(): number {
    return this.rate;
  }

  async start(): Promise<void> {
    // echoCancellation is what makes half-duplex bearable without headphones:
    // it removes most of the assistant's own voice from the mic feed.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const AudioCtx =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AudioCtx();
    this.rate = this.ctx.sampleRate;
    this.source = this.ctx.createMediaStreamSource(this.stream);

    // ScriptProcessor is deprecated but is the only node that delivers raw PCM
    // without shipping a separate worklet module through the bundler; at 1024
    // frames the main-thread cost is negligible next to synthesis.
    this.node = this.ctx.createScriptProcessor(FRAME, 1, 1);
    this.node.onaudioprocess = (e) => this.onFrame(e.inputBuffer.getChannelData(0));
    this.source.connect(this.node);
    // ScriptProcessor only runs when connected to the graph; a zero gain keeps
    // the mic from being echoed straight back out of the speakers.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.node.connect(mute);
    mute.connect(this.ctx.destination);
  }

  /** Close the gate: keep the stream open but ignore everything it hears.
   *  This is half-duplex — the mic is deaf while the assistant is speaking. */
  setGated(gated: boolean): void {
    this.gated = gated;
    if (gated) this.reset();
  }

  stop(): void {
    this.node?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.node = null;
    this.source = null;
    this.stream = null;
    this.ctx = null;
    this.reset();
  }

  /** Force the current utterance to end now (push-to-talk release). */
  flush(): void {
    if (this.speaking) this.finishUtterance();
    else this.reset();
  }

  /** Begin an utterance regardless of level (push-to-talk press). */
  forceStart(): void {
    if (this.speaking) return;
    this.speaking = true;
    this.silenceFrames = 0;
    this.speech = [...this.preroll];
    this.speechFrames = this.prerollFrames;
    this.cb.onSpeechStart?.();
  }

  private reset(): void {
    this.speaking = false;
    this.onsetCount = 0;
    this.silenceFrames = 0;
    this.speech = [];
    this.speechFrames = 0;
  }

  private onFrame(input: Float32Array): void {
    const frame = new Float32Array(input); // the source buffer is reused
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    this.cb.onLevel?.(Math.min(1, rms * 6));

    if (this.gated) return;

    const framesPerSec = this.rate / FRAME;
    const threshold = Math.max(MIN_THRESHOLD, this.noiseFloor * this.speechFactor);
    const loud = rms > threshold;

    if (!this.speaking) {
      // Track the floor only while nobody is talking, so a long sentence can't
      // drag the threshold up behind itself.
      this.noiseFloor = loud ? this.noiseFloor : this.noiseFloor * 0.95 + rms * 0.05;

      this.preroll.push(frame);
      this.prerollFrames += frame.length;
      const keep = (this.opts.prerollMs / 1000) * this.rate;
      while (this.prerollFrames - this.preroll[0].length > keep) {
        this.prerollFrames -= this.preroll.shift()!.length;
      }

      this.onsetCount = loud ? this.onsetCount + 1 : 0;
      if (this.onsetCount >= ONSET_FRAMES) this.forceStart();
      return;
    }

    this.speech.push(frame);
    this.speechFrames += frame.length;
    this.silenceFrames = loud ? 0 : this.silenceFrames + 1;

    const maxFrames = (this.opts.maxUtteranceSec ?? 60) * this.rate;
    const hangoverFrames = (this.opts.hangoverMs / 1000) * framesPerSec;
    if (this.silenceFrames >= hangoverFrames || this.speechFrames >= maxFrames) {
      this.finishUtterance();
    }
  }

  private finishUtterance(): void {
    const frames = this.speech;
    const total = this.speechFrames;
    this.reset();
    if (total === 0) return;

    const durationSec = total / this.rate;
    const minSpeech = (this.opts.minSpeechMs ?? 250) / 1000;
    // The hangover is part of every utterance, so measure the speech without it.
    if (durationSec - this.opts.hangoverMs / 1000 < minSpeech) return;

    const merged = new Float32Array(total);
    let offset = 0;
    for (const f of frames) {
      merged.set(f, offset);
      offset += f.length;
    }

    void (async () => {
      try {
        const resampled =
          this.rate === this.opts.targetRate
            ? merged
            : await resampleMono(merged, this.rate, this.opts.targetRate);
        const blob = encodeWav(resampled, this.opts.targetRate);
        this.cb.onUtterance(new File([blob], "turn.wav", { type: "audio/wav" }), durationSec);
      } catch (err) {
        this.cb.onError?.((err as Error).message || "Could not encode the recording.");
      }
    })();
  }
}
