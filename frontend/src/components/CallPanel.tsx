import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Collapse,
  Grid,
  Group,
  Loader,
  ScrollArea,
  SegmentedControl,
  Select,
  Slider,
  Stack,
  Switch,
  Text,
  Textarea,
  Tooltip,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconBrain,
  IconChevronDown,
  IconChevronUp,
  IconDeviceFloppy,
  IconHistory,
  IconInfoCircle,
  IconMessage,
  IconMicrophone,
  IconPhone,
  IconPhoneOff,
  IconPlayerStopFilled,
  IconRefresh,
  IconSend,
  IconSettings,
  IconTrash,
} from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { api } from "../api";
import type { CallPhase, CallSettings, CallState } from "../lib/callEngine";
import { callSession } from "../lib/callSession";
import { DEFAULT_SPEECH_FACTOR } from "../lib/vad";
import type { CallConfig, ConversationSummary, DiscoveredModel } from "../types";
import { ModelSelect } from "./ModelSelect";
import { VoicePicker, type VoiceValue } from "./VoicePicker";
import { SectionCard } from "./ui/primitives";
import "./CallPanel.css";

interface Props {
  models: DiscoveredModel[];
  registeredIds: string[];
  serverRunning: boolean;
}

const PHASE_LABEL: Record<CallPhase, string> = {
  idle: "Not in a call",
  warming: "Warming up the models…",
  listening: "Listening",
  hearing: "Hearing you…",
  transcribing: "Understanding…",
  thinking: "Thinking…",
  preparing: "Preparing the voice…",
  speaking: "Speaking",
  error: "Something went wrong",
};

// What the orb *does* in each phase. A button's accessible name should name the
// action, not the state — the state is already announced by the label under it.
const ORB_LABEL: Partial<Record<CallPhase, string>> = {
  idle: "Start the call",
  speaking: "Interrupt the assistant",
  preparing: "Interrupt the assistant",
  thinking: "Interrupt the assistant",
  error: "Keep talking after the error",
  listening: "Hold to talk",
  hearing: "Listening to you",
};

/**
 * Mantine colour keys per phase, resolved as CSS variables by the orb.
 *
 * `speaking` is the one deliberate choice here: it takes the **audio** accent
 * (magenta), the same colour as every playhead and waveform in the app, so that
 * "sound is coming out right now" looks the same wherever it happens. The
 * waiting phases stay in the chrome family and differ from each other by motion
 * as much as by hue.
 */
const PHASE_COLOR: Record<CallPhase, string> = {
  idle: "gray",
  warming: "yellow",
  listening: "violet",
  hearing: "cyan",
  transcribing: "indigo",
  thinking: "violet",
  preparing: "indigo",
  speaking: "magenta",
  error: "red",
};

// The Call tab keeps its own model memory: a call wants a fast streaming model,
// while the TTS tab may well be set to a slow high-quality one, and sharing the
// slot means choosing in one place silently re-chooses in the other.
const TTS_KEY = "call.model.tts";
const ASR_KEY = "call.model.asr";

/** Remember the setup between sessions — nobody wants to re-pick a voice daily. */
function stored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`call.${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
function store(key: string, value: unknown): void {
  try {
    localStorage.setItem(`call.${key}`, JSON.stringify(value));
  } catch {
    /* private mode */
  }
}

export function CallPanel({ models, registeredIds, serverRunning }: Props) {
  const [config, setConfig] = useState<CallConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  const [ttsModelId, setTtsModelId] = useState<string | null>(null);
  const [asrModelId, setAsrModelId] = useState<string | null>(null);
  const [chatModelId, setChatModelId] = useState<string | null>(stored<string | null>("chatModel", null));
  // A call is the case cloning was built for, so start on a saved voice rather
  // than a built-in one. VoicePicker snaps back to "builtin" for models that
  // can't clone, so this is a preference, not an assumption.
  const [voice, setVoice] = useState<VoiceValue>({
    mode: "clone",
    savedVoiceId: stored<string | null>("savedVoiceId", null),
  });
  const [thinking, setThinking] = useState(stored("thinking", false));
  const [length, setLength] = useState<string>(stored("length", "normal"));
  const [language, setLanguage] = useState<string>(stored("language", ""));
  const [handsFree, setHandsFree] = useState(stored("handsFree", true));
  const [bargeIn, setBargeIn] = useState(stored("bargeIn", false));
  const [fillerEnabled, setFillerEnabled] = useState(stored("filler", true));
  const [speechFactor, setSpeechFactor] = useState<number>(stored("speechFactor", DEFAULT_SPEECH_FACTOR));
  const [setupOpen, setSetupOpen] = useState(true);
  const [typed, setTyped] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);

  // The call lives outside this component (see lib/callSession) — switching
  // tabs must not end it. This only reads it.
  const state = useSyncExternalStore(callSession.subscribe, callSession.getSnapshot);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const ttsModel = models.find((m) => m.id === ttsModelId);
  const phase = state.phase;
  const inCall = phase !== "idle";

  useEffect(() => {
    api
      .getCallConfig()
      .then((c) => {
        setConfig(c);
        setChatModelId((prev) => prev ?? c.defaultChatModel ?? c.chatModels[0]?.id ?? null);
        setLength((prev) => (c.lengths.some((l) => l.id === prev) ? prev : c.defaultLength));
        // ModelSelect may already have auto-picked from its own memory by now.
        // Config wins unless this tab has a remembered choice of its own —
        // [call].default_tts_model exists precisely to steer a call at a
        // streaming model rather than whatever the TTS tab used last.
        if (c.defaultTtsModel && !localStorage.getItem(TTS_KEY)) setTtsModelId(c.defaultTtsModel);
        if (c.defaultAsrModel && !localStorage.getItem(ASR_KEY)) setAsrModelId(c.defaultAsrModel);
      })
      .catch((err) => setConfigError((err as Error).message));
  }, []);

  // A language chosen for the previous model may not exist on this one, and an
  // unsupported code is rejected upstream on every single turn.
  useEffect(() => {
    if (!ttsModel || !language) return;
    if (!ttsModel.languages.includes(language)) {
      setLanguage("");
      store("language", "");
    }
  }, [ttsModel, language]);

  // Deliberately no teardown on unmount: this panel is hidden and re-shown by
  // React's <Activity> whenever you change tabs, and hanging up there would end
  // the call every time you glanced at another tab. The session ends when the
  // user says so, or when the page goes away.
  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [state.messages.length, state.streamingText]);

  const settings: CallSettings = useMemo(
    () => ({
      chatModel: chatModelId ?? "",
      ttsModel: ttsModelId ?? "",
      asrModel: asrModelId ?? "",
      thinking,
      length,
      language: language || undefined,
      handsFree,
      bargeIn,
      fillerEnabled,
      speechFactor,
      voice: {
        voiceId: voice.mode === "builtin" ? voice.voiceId : undefined,
        savedVoiceId: voice.mode === "clone" ? voice.savedVoiceId || undefined : undefined,
      },
    }),
    [
      chatModelId,
      ttsModelId,
      asrModelId,
      thinking,
      length,
      language,
      handsFree,
      bargeIn,
      fillerEnabled,
      speechFactor,
      voice,
    ],
  );

  useEffect(() => {
    callSession.updateSettings(settings);
  }, [settings]);

  const problems = useMemo(() => {
    const out: string[] = [];
    if (!serverRunning) out.push("Start the audio server first (the bar above).");
    if (!ttsModelId) out.push("Pick a TTS model.");
    else if (serverRunning && !registeredIds.includes(ttsModelId)) out.push("The TTS model is not registered.");
    if (!asrModelId) out.push("Pick an ASR model.");
    if (!chatModelId) out.push("Pick a chat model.");
    // A model that offers voices but has none chosen fails on *every* turn
    // upstream ("requires a session voice"), so catch it before the call starts
    // rather than after the first thing you say.
    if (ttsModel) {
      const hasBuiltin = ttsModel.builtinVoices.length > 0;
      if (voice.mode === "builtin" && hasBuiltin && !voice.voiceId) out.push("Pick a built-in voice.");
      if (voice.mode === "clone" && !voice.savedVoiceId)
        out.push("Pick a saved voice (record one in the Saved Voices tab).");
    }
    return out;
  }, [serverRunning, ttsModelId, asrModelId, chatModelId, registeredIds, voice, ttsModel]);

  const startCall = useCallback(async () => {
    if (!config || problems.length > 0) return;
    setSetupOpen(false);
    await callSession.start(config, settings);
  }, [config, problems.length, settings]);

  const hangUp = useCallback(() => {
    callSession.end();
    setSetupOpen(true);
  }, []);

  // Space = push-to-talk, Esc = interrupt. Bound while a call is up only.
  useEffect(() => {
    if (!inCall) return;
    const down = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // BUTTON included: Space on a focused button must activate that button.
      // The orb handles its own keys, so without this both fire for one press.
      if (target && /^(INPUT|TEXTAREA|BUTTON)$/.test(target.tagName)) return;
      if (e.code === "Space" && !e.repeat) {
        e.preventDefault();
        callSession.pressToTalk();
      } else if (e.code === "Escape") {
        callSession.interrupt();
      }
    };
    const up = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // BUTTON included: Space on a focused button must activate that button.
      // The orb handles its own keys, so without this both fire for one press.
      if (target && /^(INPUT|TEXTAREA|BUTTON)$/.test(target.tagName)) return;
      if (e.code === "Space") {
        e.preventDefault();
        callSession.releaseToTalk();
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [inCall]);

  // Conversations are saved *only* here, by hand. Nothing writes one in the
  // background: a call is something you had out loud in your own room, and
  // filing every one of them away automatically is a surprise, not a feature.
  const refreshConversations = useCallback(() => {
    api
      .getConversations()
      .then(setConversations)
      .catch(() => {
        /* the list is a convenience; a call must not depend on it */
      });
  }, []);

  useEffect(() => {
    if (historyOpen) refreshConversations();
  }, [historyOpen, refreshConversations]);

  const saveConversation = async () => {
    const messages = state?.messages ?? [];
    if (messages.length === 0) return;
    setSaving(true);
    try {
      if (savedId) {
        // Re-saving a conversation that was loaded (or already saved this
        // session) updates it instead of leaving a trail of near-duplicates.
        await api.updateConversation(savedId, { messages, chatModel: chatModelId });
        notifications.show({ color: "teal", message: "Conversation updated." });
      } else {
        const saved = await api.createConversation({ messages, chatModel: chatModelId });
        setSavedId(saved.id);
        notifications.show({ color: "teal", message: `Saved as “${saved.name}”.` });
      }
      refreshConversations();
    } catch (err) {
      notifications.show({ color: "red", title: "Save failed", message: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const loadConversation = async (id: string) => {
    try {
      const c = await api.getConversation(id);
      callSession.loadConversation(c.messages);
      setSavedId(c.id);
      if (c.chatModel) setChatModelId(c.chatModel);
      setHistoryOpen(false);
      notifications.show({
        color: "teal",
        message: inCall
          ? `Continuing “${c.name}”.`
          : `Loaded “${c.name}” — start the call to continue it.`,
      });
    } catch (err) {
      notifications.show({ color: "red", title: "Could not load", message: (err as Error).message });
    }
  };

  const removeConversation = async (id: string) => {
    try {
      await api.deleteConversation(id);
      if (savedId === id) setSavedId(null);
      refreshConversations();
    } catch (err) {
      notifications.show({ color: "red", title: "Could not delete", message: (err as Error).message });
    }
  };

  const chatModelData = (config?.chatModels ?? []).map((m) => ({
    value: m.id,
    label: `${m.label}${m.loaded ? "  ·  loaded" : ""}`,
  }));
  const chatModel = config?.chatModels.find((m) => m.id === chatModelId);

  return (
    <Grid gap="md">
      {/* Left: setup */}
      <Grid.Col span={{ base: 12, md: 5 }}>
        <SectionCard
          title="Setup"
          icon={<IconSettings size={14} />}
          actions={
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              onClick={() => setSetupOpen((o) => !o)}
              aria-label={setupOpen ? "Collapse setup" : "Expand setup"}
            >
              {setupOpen ? <IconChevronUp size={16} /> : <IconChevronDown size={16} />}
            </ActionIcon>
          }
        >
          <Collapse expanded={setupOpen}>
            <Stack gap="sm">
              {configError && (
                <Alert color="red" variant="light" title="Call config">
                  {configError}
                </Alert>
              )}
              {config?.chatError && (
                <Alert color="orange" variant="light" title="llama.cpp" icon={<IconAlertTriangle size={18} />}>
                  {config.chatError}
                </Alert>
              )}

              <Select
                label="Chat model"
                description="Discovered from the llama.cpp server"
                data={chatModelData}
                value={chatModelId}
                onChange={(v) => {
                  setChatModelId(v);
                  store("chatModel", v);
                }}
                searchable
                nothingFoundMessage="No chat models"
              />
              {chatModel && !chatModel.loaded && (
                <Text size="xs" c="dimmed">
                  Not loaded yet — starting the call loads it first, so the first reply isn't slowed by it.
                </Text>
              )}

              <ModelSelect
                models={models}
                task="tts"
                registeredIds={registeredIds}
                serverRunning={serverRunning}
                value={ttsModelId}
                onChange={setTtsModelId}
                storageKey={TTS_KEY}
              />
              {ttsModel && (
                <Group gap="xs" mt={-6}>
                  {ttsModel.streaming ? (
                    <Badge size="sm" color="magenta" variant="light">
                      streaming — speaks while generating
                    </Badge>
                  ) : (
                    <Badge size="sm" color="gray" variant="light">
                      renders each sentence before speaking it
                    </Badge>
                  )}
                </Group>
              )}

              <ModelSelect
                models={models}
                task="asr"
                registeredIds={registeredIds}
                serverRunning={serverRunning}
                value={asrModelId}
                onChange={setAsrModelId}
                storageKey={ASR_KEY}
              />

              <VoicePicker
                model={ttsModel}
                value={voice}
                onChange={(v) => {
                  setVoice(v);
                  // Remember the cloned voice across sessions — re-picking it
                  // every call is the kind of friction that kills the feature.
                  if (v.mode === "clone") store("savedVoiceId", v.savedVoiceId ?? null);
                }}
              />

              {/* Language reaches both ASR and TTS. Android has always sent one;
                  Studio sent nothing, so the same call behaved differently
                  depending on which client placed it. */}
              {(ttsModel?.languages.length ?? 0) > 0 && (
                <Select
                  label="Language"
                  description="Used for both listening and speaking"
                  data={[
                    { value: "", label: "Auto (model default)" },
                    ...(ttsModel?.languages ?? []).map((l) => ({ value: l, label: l })),
                  ]}
                  value={language}
                  onChange={(v) => {
                    setLanguage(v ?? "");
                    store("language", v ?? "");
                  }}
                />
              )}

              <div>
                <Text size="sm" fw={500} mb={4}>
                  Response length
                </Text>
                <SegmentedControl
                  fullWidth
                  size="xs"
                  data={(config?.lengths ?? []).map((l) => ({ value: l.id, label: l.label }))}
                  value={length}
                  onChange={(v) => {
                    setLength(v);
                    store("length", v);
                  }}
                />
              </div>

              <Switch
                label="Thinking"
                description="The model reasons before answering — adds seconds before you hear anything. Its reasoning is shown, never spoken."
                checked={thinking}
                onChange={(e) => {
                  setThinking(e.currentTarget.checked);
                  store("thinking", e.currentTarget.checked);
                }}
              />

              <Switch
                label="Hands-free"
                description="Ends your turn after a pause. Off = hold the button (or Space) to talk."
                checked={handsFree}
                onChange={(e) => {
                  setHandsFree(e.currentTarget.checked);
                  store("handsFree", e.currentTarget.checked);
                }}
              />
              <Switch
                label="Let me interrupt by talking"
                description="Keeps the mic open while the assistant speaks. Works best with headphones — over speakers it may hear itself."
                checked={bargeIn}
                onChange={(e) => {
                  setBargeIn(e.currentTarget.checked);
                  store("bargeIn", e.currentTarget.checked);
                }}
              />
              <Switch
                label="Filler while thinking"
                description={`Plays “${config?.fillerText ?? "Moment…"}” in the chosen voice if a reply takes a moment.`}
                checked={fillerEnabled}
                onChange={(e) => {
                  setFillerEnabled(e.currentTarget.checked);
                  store("filler", e.currentTarget.checked);
                }}
              />

              {/* One fixed threshold cannot serve both a quiet talker in a still
                  room and a normal voice over a fan. Live while the call runs,
                  because the only way to tune this is to hear it. */}
              <div>
                <Group justify="space-between" mb={2}>
                  <Text size="sm" fw={500}>
                    Mic sensitivity
                  </Text>
                  <Text size="xs" c="dimmed">
                    {speechFactor <= 2 ? "more sensitive" : speechFactor >= 4 ? "less sensitive" : "balanced"}
                  </Text>
                </Group>
                <Slider
                  min={1.4}
                  max={5}
                  step={0.2}
                  // Inverted: dragging right should mean "pick up more", but a
                  // *higher* factor means the opposite, and a control that runs
                  // backwards is worse than no control.
                  value={6.4 - speechFactor}
                  onChange={(v) => setSpeechFactor(Number((6.4 - v).toFixed(1)))}
                  onChangeEnd={(v) => store("speechFactor", Number((6.4 - v).toFixed(1)))}
                  label={null}
                  // Right = a lower threshold = picks up more, which is what a
                  // quiet talker in a still room needs. Left raises the bar for
                  // a room with a fan or a television in it.
                  // Kept to one word each: Mantine centres a mark label on its
                  // tick, so anything longer hangs outside the panel's padding.
                  marks={[
                    { value: 1.4, label: "Noisy" },
                    { value: 5, label: "Quiet" },
                  ]}
                  mb="lg"
                />
                <Text size="xs" c="dimmed">
                  Turns never start? Drag right. The room keeps ending your turn? Drag left.
                </Text>
              </div>
            </Stack>
          </Collapse>
        </SectionCard>
      </Grid.Col>

      {/* Right: the call itself */}
      <Grid.Col span={{ base: 12, md: 7 }}>
        <Stack gap="md">
          <SectionCard>
            <Stack align="center" gap="xs">
              <CallOrb
                phase={phase}
                level={state?.level ?? 0}
                handsFree={handsFree}
                onStart={startCall}
                onInterrupt={() => callSession.interrupt()}
                onResume={() => callSession.resume()}
                onPressToTalk={() => callSession.pressToTalk()}
                onReleaseToTalk={() => callSession.releaseToTalk()}
                disabled={!config || problems.length > 0}
              />
              <Text fw={600} c={PHASE_COLOR[phase]}>
                {PHASE_LABEL[phase]}
              </Text>
              {!inCall && problems.length > 0 && (
                <Text size="xs" c="dimmed" ta="center">
                  {problems[0]}
                </Text>
              )}
              {inCall && phase !== "error" && (
                <Text size="xs" c="dimmed" ta="center">
                  {handsFree ? "Just talk — a pause ends your turn." : "Hold the button or Space to talk."}
                  {" · Esc interrupts."}
                </Text>
              )}
              {phase === "error" && (
                <Text size="xs" c="dimmed" ta="center">
                  Tap the button to keep talking, or end the call.
                </Text>
              )}
              {state?.hint && (
                <Text size="xs" c="orange" ta="center">
                  {state.hint}
                </Text>
              )}
              {state?.settingsNote && (
                <Text size="xs" c="dimmed" ta="center">
                  {state.settingsNote}
                </Text>
              )}
              {state?.error && (
                <Alert color="red" variant="light" w="100%" title="Call">
                  {state.error}
                </Alert>
              )}

              {inCall && (
                <Group gap="xs" mt="xs">
                  <Button
                    size="xs"
                    variant="light"
                    color="red"
                    leftSection={<IconPhoneOff size={16} />}
                    onClick={hangUp}
                  >
                    End call
                  </Button>
                  <Tooltip label="Stop speaking (Esc)">
                    <Button
                      size="xs"
                      variant="light"
                      leftSection={<IconPlayerStopFilled size={14} />}
                      onClick={() => callSession.interrupt()}
                      disabled={phase !== "speaking" && phase !== "thinking" && phase !== "preparing"}
                    >
                      Interrupt
                    </Button>
                  </Tooltip>
                  <Tooltip label="Redo the last turn — use this when it misheard you">
                    <Button
                      size="xs"
                      variant="subtle"
                      leftSection={<IconRefresh size={14} />}
                      onClick={() => callSession.retryLast()}
                      disabled={!state?.messages.length}
                    >
                      Redo
                    </Button>
                  </Tooltip>
                </Group>
              )}

              {/* Saving is available after hanging up too — that is when most
                  people decide a conversation was worth keeping, and the
                  transcript is deliberately left on screen for it. */}
              <Group gap="xs" mt={inCall ? 0 : "xs"}>
                <Tooltip label={savedId ? "Update the saved copy" : "Save this conversation"}>
                  <Button
                    size="xs"
                    variant="subtle"
                    leftSection={<IconDeviceFloppy size={14} />}
                    onClick={saveConversation}
                    loading={saving}
                    disabled={!state?.messages.length}
                  >
                    {savedId ? "Update" : "Save"}
                  </Button>
                </Tooltip>
                <Button
                  size="xs"
                  variant="subtle"
                  leftSection={<IconHistory size={14} />}
                  onClick={() => setHistoryOpen((o) => !o)}
                >
                  Saved calls
                </Button>
                <Tooltip label="Clear the conversation">
                  <ActionIcon
                    size="md"
                    variant="subtle"
                    color="gray"
                    disabled={!state?.messages.length}
                    onClick={() => {
                      callSession.clearConversation();
                      setSavedId(null);
                    }}
                  >
                    <IconTrash size={16} />
                  </ActionIcon>
                </Tooltip>
              </Group>

              <Collapse expanded={historyOpen} w="100%">
                <Box
                  w="100%"
                  p="xs"
                  style={{
                    background: "var(--app-surface-2)",
                    border: "1px solid var(--app-border)",
                    borderRadius: "var(--mantine-radius-md)",
                  }}
                >
                  {conversations.length === 0 ? (
                    <Text size="xs" c="dimmed" ta="center" py="xs">
                      Nothing saved yet. Calls are kept only when you press Save.
                    </Text>
                  ) : (
                    <ScrollArea.Autosize mah={180}>
                      <Stack gap={4}>
                        {conversations.map((c) => (
                          <Group key={c.id} gap="xs" wrap="nowrap" justify="space-between">
                            <Box style={{ minWidth: 0, flex: 1 }}>
                              <Text size="xs" fw={500} truncate>
                                {c.name}
                              </Text>
                              <Text size="xs" c="dimmed">
                                {c.turnCount} turns · {new Date(c.updatedAt).toLocaleString()}
                              </Text>
                            </Box>
                            <Group gap={4} wrap="nowrap">
                              <Button size="compact-xs" variant="light" onClick={() => loadConversation(c.id)}>
                                {inCall ? "Continue" : "Load"}
                              </Button>
                              <ActionIcon
                                size="sm"
                                variant="subtle"
                                color="red"
                                onClick={() => removeConversation(c.id)}
                              >
                                <IconTrash size={14} />
                              </ActionIcon>
                            </Group>
                          </Group>
                        ))}
                      </Stack>
                    </ScrollArea.Autosize>
                  )}
                </Box>
              </Collapse>

              {state?.stats && (state.stats.listenMs || state.stats.firstAudioMs) && (
                <Text size="xs" c="dimmed" className="app-mono">
                  heard {fmtMs(state.stats.listenMs)} · thought {fmtMs(state.stats.thinkMs)} · first audio{" "}
                  {fmtMs(state.stats.firstAudioMs)}
                </Text>
              )}
            </Stack>
          </SectionCard>

          <SectionCard title="Conversation" icon={<IconMessage size={14} />}>
            <ScrollArea.Autosize mah={380} viewportRef={transcriptRef} offsetScrollbars type="auto">
              <Stack gap="xs">
                {(state?.droppedTurns ?? 0) > 0 && (
                  <Text size="xs" c="dimmed" ta="center">
                    The {state.droppedTurns} oldest turn{state.droppedTurns === 1 ? "" : "s"} are no longer
                    being sent to the model — it can still be read here, but the assistant no longer
                    remembers it.
                  </Text>
                )}
                {(state?.messages ?? []).length === 0 && !state?.streamingText && (
                  <Alert icon={<IconInfoCircle size={18} />} color="gray" variant="light">
                    Start the call and say something — or type below.
                  </Alert>
                )}
                {(state?.messages ?? []).map((m, i) => (
                  <Bubble key={i} role={m.role} text={m.content} />
                ))}
                {state?.streamingReasoning && (
                  <Box
                    p="xs"
                    style={{
                      background: "var(--app-surface-2)",
                      border: "1px dashed var(--app-border)",
                      borderRadius: "var(--mantine-radius-md)",
                    }}
                  >
                    <Group gap={6} mb={4}>
                      <IconBrain size={14} />
                      <Text size="xs" fw={600} c="dimmed">
                        thinking (not spoken)
                      </Text>
                    </Group>
                    <Text size="xs" c="dimmed" lineClamp={6}>
                      {state.streamingReasoning}
                    </Text>
                  </Box>
                )}
                {state?.streamingText && (
                  <Bubble role="assistant" text={state.streamingText} speaking={state.speakingText} />
                )}
                {state?.truncated && (
                  <Text size="xs" c="orange">
                    The answer hit the length cap — try a longer response length.
                  </Text>
                )}
              </Stack>
            </ScrollArea.Autosize>

            <Group mt="sm" align="flex-end" gap="xs">
              <Textarea
                style={{ flex: 1 }}
                autosize
                minRows={1}
                maxRows={4}
                placeholder="…or type instead of talking"
                value={typed}
                onChange={(e) => setTyped(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (typed.trim()) {
                      callSession.sendText(typed);
                      setTyped("");
                    }
                  }
                }}
                disabled={!inCall}
              />
              <ActionIcon
                size="lg"
                variant="filled"
                disabled={!inCall || !typed.trim()}
                onClick={() => {
                  callSession.sendText(typed);
                  setTyped("");
                }}
              >
                <IconSend size={18} />
              </ActionIcon>
            </Group>
          </SectionCard>
        </Stack>
      </Grid.Col>
    </Grid>
  );
}

function fmtMs(ms?: number): string {
  if (ms === undefined) return "–";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function Bubble({ role, text, speaking }: { role: "user" | "assistant"; text: string; speaking?: string }) {
  const isUser = role === "user";
  // Highlight the sentence currently being spoken, so the caller can follow
  // along in the text the same way the reading player does.
  const parts = speaking && text.includes(speaking) ? text.split(speaking) : null;
  return (
    <Group justify={isUser ? "flex-end" : "flex-start"} wrap="nowrap">
      <div className="call-bubble" data-role={role}>
        {parts ? (
          <>
            {parts[0]}
            <span className="call-speaking">{speaking}</span>
            {parts.slice(1).join(speaking)}
          </>
        ) : (
          text
        )}
      </div>
    </Group>
  );
}

/**
 * State indicator and primary control in one. Colour and motion say what is
 * happening; the label under it says it in words, because colour alone doesn't
 * distinguish "listening" from "thinking".
 */
function CallOrb({
  phase,
  level,
  handsFree,
  onStart,
  onInterrupt,
  onResume,
  onPressToTalk,
  onReleaseToTalk,
  disabled,
}: {
  phase: CallPhase;
  level: number;
  handsFree: boolean;
  onStart: () => void;
  onInterrupt: () => void;
  onResume: () => void;
  onPressToTalk: () => void;
  onReleaseToTalk: () => void;
  disabled: boolean;
}) {
  const color = PHASE_COLOR[phase];
  const busy =
    phase === "warming" || phase === "transcribing" || phase === "thinking" || phase === "preparing";
  // The ring breathes with the mic while listening, so it is obvious the
  // microphone is actually live before anyone says anything important.
  const ring = phase === "hearing" || phase === "listening" ? 6 + level * 26 : 6;

  const pushToTalk = phase !== "idle" && phase !== "error" && !handsFree && !busy;
  const handlers =
    phase === "idle"
      ? { onClick: onStart }
      : phase === "error"
        ? { onClick: onResume }
        : phase === "speaking" || phase === "preparing"
          ? { onClick: onInterrupt }
        : pushToTalk
          ? {
              onPointerDown: onPressToTalk,
              onPointerUp: onReleaseToTalk,
              onPointerLeave: onReleaseToTalk,
              // Pointer events don't fire for a keyboard, and this is the
              // primary control of the screen — Space/Enter on the focused
              // button must hold the mic open just like the mouse does.
              onKeyDown: (e: React.KeyboardEvent) => {
                if ((e.key === " " || e.key === "Enter") && !e.repeat) {
                  e.preventDefault();
                  onPressToTalk();
                }
              },
              onKeyUp: (e: React.KeyboardEvent) => {
                if (e.key === " " || e.key === "Enter") {
                  e.preventDefault();
                  onReleaseToTalk();
                }
              },
            }
          : {};

  // A real <button>, not a styled div: this is the only control that matters on
  // this screen, and as a div it had no focus ring, no accessible name and no
  // keyboard route in at all.
  const label = ORB_LABEL[phase] ?? PHASE_LABEL[phase];
  const inert = phase === "listening" || phase === "hearing" ? handsFree : false;
  const hearing = phase === "hearing" || phase === "listening";

  return (
    <div
      className="call-orb-wrap"
      style={{ ["--orb-color" as string]: `var(--mantine-color-${color}-5)` }}
    >
      {/* Driven by the live mic level, so an open microphone is visible. */}
      {hearing && (
        <span
          className="call-ring"
          data-role="level"
          style={{ width: 132 + ring * 2, height: 132 + ring * 2 }}
        />
      )}
      {busy && <span className="call-ring" data-role="busy" />}

      <Box
        component="button"
        type="button"
        className="call-orb"
        aria-label={label}
        aria-busy={busy || undefined}
        aria-live="polite"
        disabled={disabled && phase === "idle"}
        data-inert={inert || undefined}
        {...handlers}
      >
        {busy ? (
          <Loader size="lg" color={color} />
        ) : phase === "idle" ? (
          <IconPhone size={46} />
        ) : phase === "speaking" ? (
          <IconPlayerStopFilled size={40} />
        ) : (
          <IconMicrophone size={46} />
        )}
      </Box>
    </div>
  );
}
