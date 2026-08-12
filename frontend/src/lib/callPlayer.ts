// Gapless playback of the PCM segments a call produces.
//
// `LibraryPanel`'s ReadingPlayer is the ancestor: generate segment n+1 while n
// plays. The difference is that a call cannot wait for a whole WAV — the backend
// streams raw PCM as the model produces it, so this schedules AudioBuffers onto
// a running cursor as the bytes arrive. `stop()` is barge-in and has to be
// instant, which is why every scheduled source is tracked.

export type CallPlayerState = "idle" | "buffering" | "playing";

export class CallPlayer {
  private ctx: AudioContext | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  /** When the next buffer should start, in AudioContext time. */
  private cursor = 0;
  private generation = 0;

  constructor(private readonly onState?: (state: CallPlayerState) => void) {}

  /**
   * Must be called from a user gesture (the "Start call" click) — browsers
   * refuse to start an AudioContext otherwise, and the first reply would be
   * silent with no visible error.
   */
  unlock(): void {
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    void this.ctx.resume();
  }

  get playing(): boolean {
    return this.sources.size > 0;
  }

  /** Seconds of already-scheduled audio still to play. */
  get queuedSeconds(): number {
    if (!this.ctx) return 0;
    return Math.max(0, this.cursor - this.ctx.currentTime);
  }

  /**
   * Read a PCM response to completion, scheduling it as it arrives.
   * Resolves when the last byte has been queued (not when it finishes playing).
   */
  async enqueueStream(res: Response): Promise<void> {
    if (!this.ctx || !res.body) return;
    const rate = Number(res.headers.get("X-Sample-Rate")) || 48000;
    const mine = this.generation;
    const reader = res.body.getReader();
    // s16le: a chunk boundary can land mid-sample, so carry the odd byte over.
    let carry: Uint8Array | null = null;
    this.onState?.("buffering");

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (mine !== this.generation) {
        void reader.cancel();
        return;
      }
      let bytes = value;
      if (carry) {
        const joined = new Uint8Array(carry.length + bytes.length);
        joined.set(carry);
        joined.set(bytes, carry.length);
        bytes = joined;
        carry = null;
      }
      if (bytes.length % 2 === 1) {
        carry = bytes.slice(bytes.length - 1);
        bytes = bytes.slice(0, bytes.length - 1);
      }
      if (bytes.length === 0) continue;
      this.schedule(this.toFloat(bytes), rate, mine);
    }
  }

  /** Schedule a complete WAV blob (the warm-up filler clip). */
  async enqueueWav(bytes: ArrayBuffer): Promise<void> {
    if (!this.ctx) return;
    const mine = this.generation;
    const buffer = await this.ctx.decodeAudioData(bytes.slice(0));
    if (mine !== this.generation) return;
    this.play(buffer, mine);
  }

  /** Cancel everything scheduled or in flight. This is barge-in. */
  stop(): void {
    this.generation++;
    for (const s of this.sources) {
      try {
        s.onended = null;
        s.stop();
      } catch {
        /* already finished */
      }
    }
    this.sources.clear();
    this.cursor = 0;
    this.onState?.("idle");
  }

  close(): void {
    this.stop();
    void this.ctx?.close();
    this.ctx = null;
  }

  private toFloat(bytes: Uint8Array): Float32Array {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = new Float32Array(bytes.byteLength / 2);
    for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768;
    return out;
  }

  private schedule(samples: Float32Array, rate: number, generation: number): void {
    if (!this.ctx || samples.length === 0) return;
    const buffer = this.ctx.createBuffer(1, samples.length, rate);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    this.play(buffer, generation);
  }

  private play(buffer: AudioBuffer, generation: number): void {
    if (!this.ctx || generation !== this.generation) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.ctx.destination);
    // Butt each buffer against the previous one. When the queue has drained
    // (generation was slower than playback) restart from now, with a small
    // lead so the very first buffer isn't scheduled in the past.
    const now = this.ctx.currentTime;
    const start = this.cursor > now ? this.cursor : now + 0.02;
    src.start(start);
    this.cursor = start + buffer.duration;
    this.sources.add(src);
    this.onState?.("playing");
    src.onended = () => {
      this.sources.delete(src);
      if (this.sources.size === 0 && generation === this.generation) this.onState?.("idle");
    };
  }
}
