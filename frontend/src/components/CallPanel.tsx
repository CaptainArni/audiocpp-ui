import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  Paper,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
  Title,
  Tooltip,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconBrain,
  IconChevronDown,
  IconChevronUp,
  IconDeviceFloppy,
  IconInfoCircle,
  IconMicrophone,
  IconPhone,
  IconPhoneOff,
  IconPlayerStopFilled,
  IconRefresh,
  IconSend,
  IconTrash,
} from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { api } from "../api";
import { CallEngine, type CallPhase, type CallSettings, type CallState } from "../lib/callEngine";
import type { CallConfig, DiscoveredModel } from "../types";
import { ModelSelect } from "./ModelSelect";
import { VoicePicker, type VoiceValue } from "./VoicePicker";

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

const PHASE_COLOR: Record<CallPhase, string> = {
  idle: "gray",
  warming: "yellow",
  listening: "blue",
  hearing: "cyan",
  transcribing: "grape",
  thinking: "violet",
  preparing: "indigo",
  speaking: "teal",
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
  const [handsFree, setHandsFree] = useState(stored("handsFree", true));
  const [bargeIn, setBargeIn] = useState(stored("bargeIn", false));
  const [fillerEnabled, setFillerEnabled] = useState(stored("filler", true));
  const [setupOpen, setSetupOpen] = useState(true);
  const [typed, setTyped] = useState("");

  const [state, setState] = useState<CallState | null>(null);
  const engineRef = useRef<CallEngine | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const ttsModel = models.find((m) => m.id === ttsModelId);
  const phase = state?.phase ?? "idle";
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

  // Tear the call down if the tab unmounts — a live mic must not outlive it.
  useEffect(() => () => engineRef.current?.hangUp(), []);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [state?.messages.length, state?.streamingText]);

  const settings: CallSettings = useMemo(
    () => ({
      chatModel: chatModelId ?? "",
      ttsModel: ttsModelId ?? "",
      asrModel: asrModelId ?? "",
      thinking,
      length,
      handsFree,
      bargeIn,
      fillerEnabled,
      voice: {
        voiceId: voice.mode === "builtin" ? voice.voiceId : undefined,
        savedVoiceId: voice.mode === "clone" ? voice.savedVoiceId || undefined : undefined,
      },
    }),
    [chatModelId, ttsModelId, asrModelId, thinking, length, handsFree, bargeIn, fillerEnabled, voice],
  );

  useEffect(() => {
    engineRef.current?.updateSettings(settings);
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
    const engine = new CallEngine(config, settings, setState);
    engineRef.current = engine;
    setSetupOpen(false);
    await engine.start();
  }, [config, problems.length, settings]);

  const hangUp = useCallback(() => {
    engineRef.current?.hangUp();
    engineRef.current = null;
    setState(null);
    setSetupOpen(true);
  }, []);

  // Space = push-to-talk, Esc = interrupt. Bound while a call is up only.
  useEffect(() => {
    if (!inCall) return;
    const down = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      if (e.code === "Space" && !e.repeat) {
        e.preventDefault();
        engineRef.current?.pressToTalk();
      } else if (e.code === "Escape") {
        engineRef.current?.interrupt();
      }
    };
    const up = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      if (e.code === "Space") {
        e.preventDefault();
        engineRef.current?.releaseToTalk();
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [inCall]);

  const saveConversation = async () => {
    const messages = state?.messages ?? [];
    if (messages.length === 0) return;
    const pages = messages.map((m) => `${m.role === "user" ? "Du" : "Assistent"}: ${m.content}`);
    try {
      await api.createReading({ name: `Gespräch ${new Date().toLocaleString()}`, pages });
      notifications.show({ color: "teal", message: "Conversation saved to the Library." });
    } catch (err) {
      notifications.show({ color: "red", title: "Save failed", message: (err as Error).message });
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
        <Paper withBorder p="md" radius="md">
          <Group justify="space-between" mb={setupOpen ? "sm" : 0}>
            <Title order={5}>Setup</Title>
            <ActionIcon variant="subtle" onClick={() => setSetupOpen((o) => !o)}>
              {setupOpen ? <IconChevronUp size={18} /> : <IconChevronDown size={18} />}
            </ActionIcon>
          </Group>

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
                disabled={inCall}
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
                    <Badge size="sm" color="teal" variant="light">
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
            </Stack>
          </Collapse>
        </Paper>
      </Grid.Col>

      {/* Right: the call itself */}
      <Grid.Col span={{ base: 12, md: 7 }}>
        <Stack gap="md">
          <Paper withBorder p="lg" radius="md">
            <Stack align="center" gap="xs">
              <CallOrb
                phase={phase}
                level={state?.level ?? 0}
                handsFree={handsFree}
                onStart={startCall}
                onInterrupt={() => engineRef.current?.interrupt()}
                onPressToTalk={() => engineRef.current?.pressToTalk()}
                onReleaseToTalk={() => engineRef.current?.releaseToTalk()}
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
              {inCall && (
                <Text size="xs" c="dimmed" ta="center">
                  {handsFree ? "Just talk — a pause ends your turn." : "Hold the button or Space to talk."}
                  {" · Esc interrupts."}
                </Text>
              )}
              {state?.hint && (
                <Text size="xs" c="orange" ta="center">
                  {state.hint}
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
                      onClick={() => engineRef.current?.interrupt()}
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
                      onClick={() => engineRef.current?.retryLast()}
                      disabled={!state?.messages.length}
                    >
                      Redo
                    </Button>
                  </Tooltip>
                  <Tooltip label="Save this conversation to the Library">
                    <Button
                      size="xs"
                      variant="subtle"
                      leftSection={<IconDeviceFloppy size={14} />}
                      onClick={saveConversation}
                      disabled={!state?.messages.length}
                    >
                      Save
                    </Button>
                  </Tooltip>
                  <Tooltip label="Clear the conversation">
                    <ActionIcon
                      size="md"
                      variant="subtle"
                      color="gray"
                      onClick={() => engineRef.current?.clearConversation()}
                    >
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              )}

              {state?.stats && (state.stats.listenMs || state.stats.firstAudioMs) && (
                <Text size="xs" c="dimmed">
                  heard {fmtMs(state.stats.listenMs)} · thought {fmtMs(state.stats.thinkMs)} · first audio{" "}
                  {fmtMs(state.stats.firstAudioMs)}
                </Text>
              )}
            </Stack>
          </Paper>

          <Paper withBorder p="md" radius="md">
            <Title order={6} mb="xs">
              Conversation
            </Title>
            <ScrollArea.Autosize mah={380} viewportRef={transcriptRef} offsetScrollbars type="auto">
              <Stack gap="xs">
                {(state?.messages ?? []).length === 0 && !state?.streamingText && (
                  <Alert icon={<IconInfoCircle size={18} />} color="gray" variant="light">
                    Start the call and say something — or type below.
                  </Alert>
                )}
                {(state?.messages ?? []).map((m, i) => (
                  <Bubble key={i} role={m.role} text={m.content} />
                ))}
                {state?.streamingReasoning && (
                  <Paper withBorder p="xs" radius="sm" bg="var(--mantine-color-default-hover)">
                    <Group gap={6} mb={4}>
                      <IconBrain size={14} />
                      <Text size="xs" fw={600} c="dimmed">
                        thinking (not spoken)
                      </Text>
                    </Group>
                    <Text size="xs" c="dimmed" lineClamp={6}>
                      {state.streamingReasoning}
                    </Text>
                  </Paper>
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
                    if (typed.trim() && engineRef.current) {
                      void engineRef.current.sendText(typed);
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
                  void engineRef.current?.sendText(typed);
                  setTyped("");
                }}
              >
                <IconSend size={18} />
              </ActionIcon>
            </Group>
          </Paper>
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
      <Paper
        withBorder
        p="xs"
        radius="md"
        maw="85%"
        bg={isUser ? "var(--mantine-color-blue-light)" : undefined}
      >
        <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
          {parts ? (
            <>
              {parts[0]}
              <Text component="span" size="sm" fw={600} c="teal">
                {speaking}
              </Text>
              {parts.slice(1).join(speaking)}
            </>
          ) : (
            text
          )}
        </Text>
      </Paper>
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
  onPressToTalk,
  onReleaseToTalk,
  disabled,
}: {
  phase: CallPhase;
  level: number;
  handsFree: boolean;
  onStart: () => void;
  onInterrupt: () => void;
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

  const handlers =
    phase === "idle"
      ? { onClick: onStart }
      : phase === "speaking" || phase === "preparing"
        ? { onClick: onInterrupt }
        : !handsFree
          ? {
              onPointerDown: onPressToTalk,
              onPointerUp: onReleaseToTalk,
              onPointerLeave: onReleaseToTalk,
            }
          : {};

  return (
    <Box
      {...handlers}
      style={{
        width: 132,
        height: 132,
        borderRadius: "50%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: disabled && phase === "idle" ? "not-allowed" : "pointer",
        opacity: disabled && phase === "idle" ? 0.5 : 1,
        background: `var(--mantine-color-${color}-light)`,
        boxShadow: `0 0 0 ${ring}px var(--mantine-color-${color}-light)`,
        transition: "box-shadow 90ms linear, background 200ms",
        userSelect: "none",
      }}
    >
      {busy ? (
        <Loader size="lg" color={color} />
      ) : phase === "idle" ? (
        <IconPhone size={46} color={`var(--mantine-color-${color}-filled)`} />
      ) : phase === "speaking" ? (
        <IconPlayerStopFilled size={40} color={`var(--mantine-color-${color}-filled)`} />
      ) : (
        <IconMicrophone size={46} color={`var(--mantine-color-${color}-filled)`} />
      )}
    </Box>
  );
}
