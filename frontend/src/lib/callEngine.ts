// The call turn loop: listen → transcribe → chat → speak → listen.
//
// Kept out of the React component because a turn spans four network calls, two
// audio devices and a cancellation path, and none of that wants to be tangled
// with rendering. The component subscribes to `onChange` and renders state.
//
// Cancellation is one operation on purpose: aborting a turn has to stop the
// chat stream, drop every queued segment and reopen the mic together, or the
// assistant talks over its own interruption.

import { api } from "../api";
import { CallPlayer } from "./callPlayer";
import { MicVad } from "./vad";
import type { CallConfig, ChatMessage } from "../types";

export type CallPhase =
  | "idle"
  | "warming"
  | "listening"
  | "hearing"
  | "transcribing"
  | "thinking"
  /** The answer exists; its audio is still being synthesised. A separate state
   *  from "thinking" because it is a different wait with a different cause —
   *  a cold TTS model, not a slow model. */
  | "preparing"
  | "speaking"
  | "error";

export interface CallTurnStats {
  listenMs?: number;
  /** Time to the first chat token. */
  thinkMs?: number;
  /** Time from sending the turn to the first audible sample. */
  firstAudioMs?: number;
}

export interface CallState {
  phase: CallPhase;
  messages: ChatMessage[];
  /** Assistant text for the turn in progress (not yet in `messages`). */
  streamingText: string;
  /** Reasoning for the turn in progress — shown, never spoken. */
  streamingReasoning: string;
  /** The segment currently being spoken, for follow-along highlighting. */
  speakingText: string;
  level: number;
  error: string | null;
  hint: string | null;
  stats: CallTurnStats;
  truncated: boolean;
  /** Turns dropped from the last request because the context window is capped.
   *  Zero until it actually happens, so a short call says nothing about it. */
  droppedTurns: number;
  /** "Applies from the next turn" — set when a setting changes mid-call and
   *  cleared when that turn starts, so the change is acknowledged rather than
   *  appearing to do nothing. */
  settingsNote: string | null;
}

export interface CallSettings {
  chatModel: string;
  ttsModel: string;
  asrModel: string;
  language?: string;
  thinking: boolean;
  length: string;
  /** Voice fields, passed through to /api/call/speak unchanged. */
  voice: Record<string, unknown>;
  /** Hands-free (VAD ends the turn) vs push-to-talk. */
  handsFree: boolean;
  /** Keep listening while the assistant speaks, so speaking over it interrupts. */
  bargeIn: boolean;
  fillerEnabled: boolean;
  /** Mic sensitivity: how far above the noise floor counts as speech. */
  speechFactor: number;
}

const ASR_RATE = 16000;

export const INITIAL_CALL_STATE: CallState = {
  phase: "idle",
  messages: [],
  streamingText: "",
  streamingReasoning: "",
  speakingText: "",
  level: 0,
  error: null,
  hint: null,
  stats: {},
  truncated: false,
  droppedTurns: 0,
  settingsNote: null,
};

export class CallEngine {
  private vad: MicVad | null = null;
  private player: CallPlayer;
  private abort: AbortController | null = null;
  private filler: ArrayBuffer | null = null;
  private fillerTimer: number | null = null;
  private turnStartedAt = 0;
  private firstAudioSeen = false;
  private selfTriggerCount = 0;
  /** Segments actually handed to the player this turn — what the caller heard. */
  private spokenSoFar = "";
  /** Guards against an older re-warm landing after a newer one. */
  private warmToken = 0;
  private pendingRewarm = false;

  private state: CallState = { ...INITIAL_CALL_STATE };

  constructor(
    private readonly config: CallConfig,
    private settings: CallSettings,
    private readonly onChange: (state: CallState) => void,
  ) {
    this.player = new CallPlayer((s) => {
      if (s !== "playing") return;
      if (!this.firstAudioSeen) {
        this.firstAudioSeen = true;
        this.clearFiller();
        this.patch({ stats: { ...this.state.stats, firstAudioMs: Date.now() - this.turnStartedAt } });
      }
      // Audio is actually coming out of the speakers now — before this the
      // segment was only being synthesised, which is a different wait and gets
      // its own label.
      if (this.state.phase === "preparing" || this.state.phase === "thinking") {
        this.patch({ phase: "speaking" });
      }
    });
  }

  getState(): CallState {
    return this.state;
  }

  /**
   * Apply a settings change to the call in progress.
   *
   * Every setting is live — there is nothing here you have to hang up to
   * change. They differ only in *when* they bite, which is what
   * `settingsNote` tells the caller:
   *
   * - **immediately**: mic sensitivity, barge-in (they configure the devices)
   * - **from the next turn**: length, thinking, language (they are request
   *   parameters, and the turn in flight was already sent)
   * - **after a re-warm**: any model, or the voice (see below)
   */
  updateSettings(settings: CallSettings): void {
    const prev = this.settings;
    const wasGated = !prev.bargeIn;
    this.settings = settings;
    // Turning barge-in on mid-call should open the mic immediately.
    if (wasGated && settings.bargeIn && this.state.phase === "speaking") this.vad?.setGated(false);
    // Retuning the gate is only useful if you can hear the effect while talking.
    if (prev.speechFactor !== settings.speechFactor) this.vad?.setSpeechFactor(settings.speechFactor);

    if (this.state.phase === "idle") return;

    // Warm-up ran once, against the models and voice chosen at that moment.
    // Switching any of them mid-call leaves the replacement cold — the next
    // reply then takes seconds — and leaves the filler clip in the *previous*
    // voice. Re-warm so a mid-call switch behaves like the start of a call.
    const rewarmNeeded =
      prev.ttsModel !== settings.ttsModel ||
      prev.asrModel !== settings.asrModel ||
      prev.chatModel !== settings.chatModel ||
      JSON.stringify(prev.voice) !== JSON.stringify(settings.voice);

    // A change to how the *next* answer is generated cannot affect the one
    // already streaming. Saying so is the difference between "it's applied" and
    // "the switch does nothing".
    const nextTurnOnly =
      prev.length !== settings.length ||
      prev.thinking !== settings.thinking ||
      prev.language !== settings.language;
    if (nextTurnOnly && this.answering) {
      this.patch({ settingsNote: "Applies from your next turn." });
    } else if (nextTurnOnly || rewarmNeeded) {
      this.patch({ settingsNote: null });
    }

    // Mid-turn the models are busy answering; warming would queue behind the
    // very request it is meant to speed up. Defer to the next quiet moment.
    if (!rewarmNeeded) return;
    if (this.abort) this.pendingRewarm = true;
    else void this.rewarm();
  }

  /** Load whatever the setup now points at, and re-cut the filler clip.
   *  Latest-wins: rapid switching must not leave an older answer applied. */
  private async rewarm(): Promise<void> {
    const token = ++this.warmToken;
    this.patch({ hint: "Warming up the new selection…" });
    try {
      const warm = await api.callWarmup({
        chatModel: this.settings.chatModel,
        ttsModel: this.settings.ttsModel,
        asrModel: this.settings.asrModel,
        ...this.settings.voice,
      });
      if (token !== this.warmToken) return;
      if (warm.filler) this.filler = base64ToBuffer(warm.filler);
      const failure = [warm.chatError, warm.ttsError, warm.asrError].find(Boolean);
      this.patch({ hint: (failure as string) ?? null });
    } catch (err) {
      if (token !== this.warmToken) return;
      this.patch({ hint: (err as Error).message });
    }
  }

  /** Warm the models, then open the mic. Must be called from a user gesture. */
  async start(): Promise<void> {
    this.patch({ phase: "warming", error: null, hint: null });
    this.player.unlock();
    const token = ++this.warmToken; // invalidate any re-warm still in flight
    this.pendingRewarm = false;
    try {
      const warm = await api.callWarmup({
        chatModel: this.settings.chatModel,
        ttsModel: this.settings.ttsModel,
        asrModel: this.settings.asrModel,
        ...this.settings.voice,
      });
      if (token !== this.warmToken) return;
      if (warm.filler) this.filler = base64ToBuffer(warm.filler);
      const failures = [warm.chatError, warm.ttsError, warm.asrError].filter(Boolean);
      if (failures.length) this.patch({ hint: failures[0] as string });
    } catch (err) {
      this.patch({ phase: "error", error: (err as Error).message });
      return;
    }

    try {
      this.vad = new MicVad(
        {
          hangoverMs: this.config.vadHangoverMs,
          prerollMs: this.config.vadPrerollMs,
          targetRate: ASR_RATE,
          speechFactor: this.settings.speechFactor,
        },
        {
          onLevel: (level) => this.patch({ level }),
          onSpeechStart: () => this.onSpeechStart(),
          onUtterance: (wav) => void this.onUtterance(wav),
          onError: (message) => this.patch({ error: message }),
        },
      );
      await this.vad.start();
    } catch (err) {
      const e = err as DOMException;
      const message =
        e?.name === "NotAllowedError"
          ? "Microphone permission was denied. Allow mic access and start the call again."
          : e?.name === "NotFoundError"
            ? "No microphone was found on this device."
            : (err as Error).message || "Could not open the microphone.";
      this.patch({ phase: "error", error: message });
      return;
    }
    this.listen();
  }

  /** End the call: mic off, audio off, in-flight turn cancelled. */
  hangUp(): void {
    this.cancelTurn();
    this.vad?.stop();
    this.vad = null;
    this.player.close();
    this.player = new CallPlayer();
    this.patch({ phase: "idle", level: 0, speakingText: "" });
  }

  /** The assistant is mid-turn — answering, synthesising or already talking.
   *  All three are interruptible; only "speaking" being so would leave the
   *  caller unable to cut off a slow reply before it starts. */
  private get answering(): boolean {
    const p = this.state.phase;
    return p === "thinking" || p === "preparing" || p === "speaking";
  }

  /** Push-to-talk press. */
  pressToTalk(): void {
    if (this.answering) this.interrupt();
    this.vad?.setGated(false);
    this.vad?.forceStart();
    this.patch({ phase: "hearing" });
  }

  /** Push-to-talk release. */
  releaseToTalk(): void {
    this.vad?.flush();
  }

  /** Stop the assistant mid-sentence and go back to listening. */
  interrupt(): void {
    this.cancelTurn();
    this.listen();
  }

  /**
   * Carry on after a failed turn.
   *
   * A turn that errors used to leave the call parked in `error` with no handler
   * on the orb, so the only ways out were a non-obvious Redo or hanging up. A
   * failure is usually transient (one bad segment, a model still loading) and
   * should cost the turn, not the conversation.
   */
  resume(): void {
    if (this.state.phase !== "error") return;
    this.patch({ error: null });
    this.listen();
  }

  /** Send typed text as a turn — the same path, minus the microphone. */
  async sendText(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.cancelTurn();
    // Nothing was heard, so the previous turn's listen time must not be carried
    // over — it would be shown as this turn's and counted in its latency.
    this.patch({ stats: {} });
    await this.runTurn(trimmed);
  }

  /** Drop the last exchange so a misheard turn can be redone. */
  retryLast(): void {
    this.cancelTurn();
    const messages = [...this.state.messages];
    while (messages.length && messages[messages.length - 1].role === "assistant") messages.pop();
    if (messages.length && messages[messages.length - 1].role === "user") messages.pop();
    this.patch({ messages, streamingText: "", streamingReasoning: "" });
    this.listen();
  }

  clearConversation(): void {
    this.cancelTurn();
    this.patch({
      messages: [],
      streamingText: "",
      streamingReasoning: "",
      stats: {},
      truncated: false,
      droppedTurns: 0,
    });
    if (this.state.phase !== "idle") this.listen();
  }

  /**
   * Replace the conversation with a saved one, so a call can be picked up where
   * it was left. Works whether or not a call is up: loading before starting is
   * the common case (choose one, then hit the orb).
   */
  loadConversation(messages: ChatMessage[]): void {
    this.cancelTurn();
    this.patch({
      messages: [...messages],
      streamingText: "",
      streamingReasoning: "",
      stats: {},
      truncated: false,
      droppedTurns: 0,
    });
    if (this.state.phase !== "idle") this.listen();
  }

  // --- internals ----------------------------------------------------------

  private listen(): void {
    this.vad?.setGated(false);
    this.patch({ phase: "listening", speakingText: "", hint: this.state.hint });
    if (this.pendingRewarm) {
      this.pendingRewarm = false;
      void this.rewarm();
    }
  }

  private onSpeechStart(): void {
    if (this.answering) {
      // Only reachable with barge-in on: the caller talked over the assistant.
      if (!this.settings.bargeIn) return;
      this.cancelTurn();
    }
    this.patch({ phase: "hearing" });
  }

  private async onUtterance(wav: File): Promise<void> {
    if (this.state.phase === "transcribing" || this.state.phase === "thinking") return;
    this.patch({ phase: "transcribing" });
    const t0 = Date.now();
    let text = "";
    try {
      const res = await api.callListen(wav, this.settings.asrModel, this.settings.language);
      text = res.text.trim();
    } catch (err) {
      this.patch({ phase: "error", error: (err as Error).message });
      return;
    }
    const listenMs = Date.now() - t0;

    if (!text) {
      // Not an error: a cough, a door, the assistant's own tail through the
      // speakers. Say so and keep listening rather than spending a turn.
      this.selfTriggerCount++;
      this.patch({
        hint:
          this.selfTriggerCount >= 3 && this.settings.handsFree
            ? "Nothing recognised a few times — if the assistant's own voice is triggering the mic, use headphones or switch to push-to-talk."
            : "Didn't catch that.",
      });
      this.listen();
      return;
    }
    this.selfTriggerCount = 0;
    this.patch({ stats: { listenMs }, hint: null });
    await this.runTurn(text);
  }

  private async runTurn(userText: string): Promise<void> {
    const messages: ChatMessage[] = [...this.state.messages, { role: "user", content: userText }];
    this.patch({
      phase: "thinking",
      messages,
      streamingText: "",
      streamingReasoning: "",
      speakingText: "",
      truncated: false,
      // The change the note referred to is now in effect.
      settingsNote: null,
    });
    // The mic is deaf while the assistant answers unless barge-in is on.
    this.vad?.setGated(!this.settings.bargeIn);

    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.turnStartedAt = Date.now();
    this.firstAudioSeen = false;
    this.spokenSoFar = "";
    this.armFiller();

    // Segments are synthesised one at a time and in order: the model serializes
    // its own requests anyway, and a queue of in-flight ones would only delay
    // the cancel when someone interrupts.
    let chain: Promise<void> = Promise.resolve();
    let failed = false;

    const speakSegment = (text: string) => {
      chain = chain.then(async () => {
        if (signal.aborted || failed) return;
        try {
          // Synthesis can take seconds on a cold model, and during that the
          // answer is already on screen — saying "Thinking…" there is wrong.
          if (!this.player.playing) this.patch({ phase: "preparing" });
          this.patch({ speakingText: text });
          const res = await api.callSpeak(
            { model: this.settings.ttsModel, text, language: this.settings.language, ...this.settings.voice },
            signal,
          );
          if (signal.aborted) return;
          // Counted as spoken once its audio is queued: if the turn is cut off
          // here, this is the part the caller actually heard.
          this.spokenSoFar = this.spokenSoFar ? `${this.spokenSoFar} ${text}` : text;
          await this.player.enqueueStream(res);
        } catch (err) {
          if (signal.aborted) return;
          failed = true;
          this.patch({ error: (err as Error).message });
        }
      });
    };

    try {
      await api.chatStream(
        {
          model: this.settings.chatModel,
          messages,
          thinking: this.settings.thinking,
          length: this.settings.length,
        },
        (event) => {
          switch (event.type) {
            case "text":
              this.patch({ streamingText: this.state.streamingText + event.delta });
              break;
            case "reasoning":
              this.patch({ streamingReasoning: this.state.streamingReasoning + event.delta });
              break;
            case "speak":
              // The model has decided what to say, so the filler has nothing
              // left to cover. Letting it fire now would be a lie ("Moment…"
              // while the answer is already on screen) *and* would delay the
              // real reply, since it queues into the same audio cursor.
              this.clearFiller();
              speakSegment(event.text);
              break;
            case "context":
              // The window is capped, so the model no longer sees the start of
              // a long call. Silent trimming makes that look like forgetfulness.
              this.patch({ droppedTurns: event.dropped });
              break;
            case "truncated":
              this.patch({ truncated: true });
              break;
            case "error":
              failed = true;
              this.patch({ error: event.message });
              break;
            case "done":
              this.patch({
                stats: { ...this.state.stats, thinkMs: event.firstTokenMs ?? undefined },
                messages: [...messages, { role: "assistant", content: event.text }],
                streamingText: "",
              });
              break;
          }
        },
        signal,
      );
    } catch (err) {
      if (!signal.aborted) {
        this.clearFiller();
        this.patch({ phase: "error", error: (err as Error).message });
        return;
      }
    }

    await chain;
    this.clearFiller();
    if (signal.aborted) return;
    if (failed) {
      this.patch({ phase: "error" });
      return;
    }
    // Only completed turns are reported: an interrupted one measures how long
    // someone waited before giving up, which would drag the average somewhere
    // meaningless. Fire-and-forget — telemetry must never cost a turn.
    const stats = this.state.stats;
    api.callTurn({
      // Measured from the moment you stopped talking, which includes the ASR —
      // that wait is part of the turn even though it happened before `runTurn`.
      totalMs: Date.now() - this.turnStartedAt + (stats.listenMs ?? 0),
      listenMs: stats.listenMs,
      thinkMs: stats.thinkMs,
      firstAudioMs: stats.firstAudioMs,
    });
    // Wait out whatever is still scheduled before reopening the mic, or the
    // hands-free VAD hears the assistant's own tail and answers itself.
    const remainingMs = this.player.queuedSeconds * 1000;
    window.setTimeout(() => {
      if (!signal.aborted && this.state.phase !== "idle") this.listen();
    }, remainingMs + 120);
  }

  /** Play the pre-synthesised filler if the reply is taking a moment. */
  private armFiller(): void {
    this.clearFiller();
    if (!this.settings.fillerEnabled || !this.filler || !this.config.fillerAfterMs) return;
    this.fillerTimer = window.setTimeout(() => {
      if (!this.firstAudioSeen && this.filler) void this.player.enqueueWav(this.filler);
    }, this.config.fillerAfterMs);
  }

  private clearFiller(): void {
    if (this.fillerTimer !== null) window.clearTimeout(this.fillerTimer);
    this.fillerTimer = null;
  }

  /**
   * Abort the turn in flight, and leave the conversation coherent.
   *
   * The user's message is appended when the turn starts, the assistant's only on
   * `done`. Cancelling in between used to leave a user turn that was never
   * answered — so the next turn sent two user messages in a row, and whatever
   * the assistant had already *said out loud* was missing from its own context,
   * which made it cheerfully repeat itself. Keep what was spoken; drop the
   * question if nothing was.
   */
  private cancelTurn(): void {
    const wasAnswering = this.abort !== null;
    this.abort?.abort();
    this.abort = null;
    this.clearFiller();
    this.player.stop();

    const patch: Partial<CallState> = { speakingText: "", streamingReasoning: "", streamingText: "" };
    if (wasAnswering) {
      const messages = [...this.state.messages];
      const last = messages[messages.length - 1];
      // `done` already landed (the assistant message is in) — nothing to repair.
      if (last?.role === "user") {
        const spoken = this.spokenSoFar.trim();
        if (spoken) messages.push({ role: "assistant", content: spoken });
        else messages.pop();
        patch.messages = messages;
      }
    }
    this.spokenSoFar = "";
    this.patch(patch);
  }

  private patch(patch: Partial<CallState>): void {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }
}

function base64ToBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
