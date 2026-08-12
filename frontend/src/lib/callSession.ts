// The live call, owned outside the React tree.
//
// `CallPanel` cannot own the engine. Mantine's `Tabs` keeps inactive panels
// mounted with `keepMountedMode: "activity"`, and React 19's `<Activity>` *tears
// down and re-runs effects* while keeping refs and state — the same behaviour
// `App.tsx` documents for the Monaco log panel. An effect cleanup that hung up
// the call therefore fired the moment you glanced at another tab: microphone
// released, audio stopped, conversation gone.
//
// So the engine lives here, at module scope, for the lifetime of the page. This
// mirrors the Android app, where `ReaderApp` owns the process-wide
// `PlaybackEngine` for exactly the same reason. Components subscribe; only an
// explicit "End call" tears it down.

import { CallEngine, INITIAL_CALL_STATE, type CallSettings, type CallState } from "./callEngine";
import type { CallConfig } from "../types";

let engine: CallEngine | null = null;
let state: CallState = INITIAL_CALL_STATE;
const listeners = new Set<() => void>();

function publish(next: CallState) {
  state = next;
  listeners.forEach((l) => l());
}

/** For `useSyncExternalStore`. Must be referentially stable between renders. */
export const callSession = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  getSnapshot(): CallState {
    return state;
  },

  /** True once a call has been started and not yet ended. */
  get active(): boolean {
    return engine !== null && state.phase !== "idle";
  },

  /**
   * Start a call, creating the engine on first use.
   *
   * Must be called from a user gesture: the audio context can only be unlocked
   * from one, and without it the first reply is silent with no visible error.
   */
  async start(config: CallConfig, settings: CallSettings): Promise<void> {
    if (!engine) engine = new CallEngine(config, settings, publish);
    else engine.updateSettings(settings);
    await engine.start();
  },

  /** Push setup changes through; the engine re-warms when a model or voice moves. */
  updateSettings(settings: CallSettings): void {
    engine?.updateSettings(settings);
  },

  /** End the call and drop the engine, so the next one starts clean. */
  end(): void {
    engine?.hangUp();
    engine = null;
    publish(INITIAL_CALL_STATE);
  },

  interrupt: () => engine?.interrupt(),
  resume: () => engine?.resume(),
  pressToTalk: () => engine?.pressToTalk(),
  releaseToTalk: () => engine?.releaseToTalk(),
  retryLast: () => engine?.retryLast(),
  clearConversation: () => engine?.clearConversation(),
  sendText: (text: string) => engine?.sendText(text),
};
