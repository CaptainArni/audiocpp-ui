import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Accordion,
  ActionIcon,
  Alert,
  Badge,
  Button,
  Chip,
  Grid,
  Group,
  NumberInput,
  Paper,
  Progress,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import {
  IconAdjustments,
  IconAlertTriangle,
  IconArrowBackUp,
  IconDice5,
  IconMusic,
  IconSparkles,
} from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { api } from "../api";
import type {
  MusicEnhancement,
  MusicModel,
  MusicPromptProfile,
  MusicSpec,
  MusicTake,
} from "../types";
import { MusicTakes } from "./MusicTakes";

interface Props {
  registeredIds: string[];
  serverRunning: boolean;
}

const LAST_MODEL_KEY = "audiocpp.music.model";
const LAST_LLM_KEY = "audiocpp.music.llm";

/**
 * Structure tags, as documented by ACE-Step. They go on their own line and take
 * at most one modifier — a tag stacked with six adjectives is upstream's own
 * example of what not to write, so the chips deliberately offer the bare form.
 */
const STRUCTURE_TAGS = [
  "[Intro]",
  "[Verse]",
  "[Pre-Chorus]",
  "[Chorus]",
  "[Bridge]",
  "[Outro]",
  "[Instrumental]",
  "[Guitar Solo]",
  "[Build]",
  "[Drop]",
  "[Breakdown]",
  "[Fade Out]",
];

const TIME_SIGNATURES = ["4/4", "3/4", "6/8"];

/** The editable half of a request — everything except the model and take count. */
type Draft = Omit<MusicSpec, "model" | "takes">;

const EMPTY_DRAFT: Draft = {
  caption: "",
  lyrics: "",
  title: "",
  language: "",
  keyscale: "",
  timeSignature: "",
  negativePrompt: "",
  seed: null,
  bpm: null,
};

export function MusicPanel({ registeredIds, serverRunning }: Props) {
  const [models, setModels] = useState<MusicModel[]>([]);
  const [modelId, setModelId] = useState<string | null>(null);
  const [maxTakes, setMaxTakes] = useState(8);

  const [profiles, setProfiles] = useState<MusicPromptProfile[]>([]);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [llmModels, setLlmModels] = useState<{ id: string; label: string; loaded: boolean }[]>([]);
  const [llmError, setLlmError] = useState<string | null>(null);
  const [llmModel, setLlmModel] = useState<string | null>(null);

  const [idea, setIdea] = useState("");
  const [withLyrics, setWithLyrics] = useState(true);
  const [enhancing, setEnhancing] = useState(false);
  const [enhancement, setEnhancement] = useState<MusicEnhancement | null>(null);
  const [undoDraft, setUndoDraft] = useState<Draft | null>(null);

  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [takes, setTakes] = useState(1);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [fresh, setFresh] = useState<MusicTake[]>([]);
  const [takesKey, setTakesKey] = useState(0);

  const lyricsRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const model = models.find((m) => m.id === modelId) ?? null;
  const set = useCallback(<K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
  }, []);

  // --- discovery -----------------------------------------------------------
  useEffect(() => {
    api
      .getMusicModels()
      .then((r) => {
        setModels(r.models);
        setMaxTakes(r.maxTakes);
        const remembered = localStorage.getItem(LAST_MODEL_KEY);
        const pick = r.models.some((m) => m.id === remembered) ? remembered! : r.default;
        setModelId(pick || r.models[0]?.id || null);
        setDraft((d) => ({ ...d, durationSeconds: r.defaultDurationSec }));
      })
      .catch((err) =>
        notifications.show({ color: "red", title: "Music models", message: err.message }),
      );
  }, []);

  // Enhancement rules are bound to the *family*, so a different music model
  // brings different prompting rules with it rather than reusing ACE-Step's.
  const family = model?.family ?? null;
  useEffect(() => {
    if (!family) return;
    api
      .getMusicPrompts(family)
      .then((r) => {
        setProfiles(r.prompts);
        setLlmModels(r.chatModels);
        setLlmError(r.chatError);
        setProfileId(r.default || r.prompts[0]?.id || null);
        const remembered = localStorage.getItem(LAST_LLM_KEY);
        setLlmModel((cur) =>
          cur ?? (r.chatModels.some((m) => m.id === remembered) ? remembered : r.chatModels[0]?.id ?? null),
        );
      })
      .catch((err) => setLlmError(err.message));
  }, [family]);

  // The prompt box shows the profile's own text and stays editable — the same
  // deal as the OCR test bench, where seeing the prompt is half the point.
  useEffect(() => {
    const profile = profiles.find((p) => p.id === profileId);
    if (profile) setSystemPrompt(profile.systemPrompt);
  }, [profileId, profiles]);

  // Step count and guidance are genuinely different per variant (turbo is
  // distilled to ~8 steps and ignores guidance; base wants ~30 and uses it), so
  // switching model resets them instead of carrying the wrong ones across.
  useEffect(() => {
    if (!model) return;
    localStorage.setItem(LAST_MODEL_KEY, model.id);
    setDraft((d) => ({
      ...d,
      steps: model.steps ?? d.steps,
      guidanceScale: model.supportsGuidance ? model.guidanceScale ?? undefined : undefined,
    }));
  }, [model]);

  useEffect(() => {
    if (llmModel) localStorage.setItem(LAST_LLM_KEY, llmModel);
  }, [llmModel]);

  // --- enhance -------------------------------------------------------------
  async function enhance() {
    if (!idea.trim()) {
      notifications.show({ color: "yellow", message: "Describe what you want to hear first." });
      return;
    }
    if (!llmModel) {
      notifications.show({ color: "yellow", message: "Pick a llama.cpp model to write the prompt." });
      return;
    }
    setEnhancing(true);
    try {
      const result = await api.enhanceMusicPrompt({
        idea,
        family: family ?? undefined,
        profileId: profileId ?? undefined,
        model: llmModel,
        systemPrompt,
        withLyrics,
      });
      // Enhancing overwrites hand-written lyrics, so the previous draft is kept
      // one click away. Losing a verse to a button press is a bug, not a retry.
      setUndoDraft(draft);
      setDraft((d) => ({ ...d, ...result.fields }));
      setEnhancement(result);
      notifications.show({
        color: result.parsed ? "teal" : "yellow",
        message: result.parsed
          ? `Prompt written in ${result.seconds.toFixed(1)}s.`
          : "The model didn't answer with JSON — its whole reply became the caption.",
      });
    } catch (err) {
      notifications.show({ color: "red", title: "Enhance failed", message: (err as Error).message });
    } finally {
      setEnhancing(false);
    }
  }

  function undo() {
    if (!undoDraft) return;
    setDraft(undoDraft);
    setUndoDraft(null);
    setEnhancement(null);
  }

  // --- generate ------------------------------------------------------------
  async function generate() {
    if (!model) return;
    if (!serverRunning) {
      notifications.show({ color: "yellow", message: "Start the server first." });
      return;
    }
    if (!registeredIds.includes(model.id)) {
      notifications.show({
        color: "yellow",
        message: "This model isn't registered in the running server. Include it and restart.",
      });
      return;
    }
    if (!draft.caption.trim()) {
      notifications.show({ color: "yellow", message: "A caption is required — describe the music." });
      return;
    }

    const spec: MusicSpec = {
      ...draft,
      model: model.id,
      takes,
      // Blank fields mean "let ACE-Step's planner decide"; sending "" would
      // override that with an empty value.
      bpm: draft.bpm || undefined,
      keyscale: draft.keyscale || undefined,
      timeSignature: draft.timeSignature || undefined,
      language: draft.language || undefined,
      negativePrompt: draft.negativePrompt || undefined,
      seed: draft.seed ?? undefined,
    };

    const controller = new AbortController();
    abortRef.current = controller;
    setGenerating(true);
    setFresh([]);
    setProgress({ done: 0, total: takes });
    try {
      await api.generateMusic(
        spec,
        (event) => {
          if (event.type === "take") {
            setFresh((t) => [event.take, ...t]);
            setProgress({ done: event.index + 1, total: takes });
          } else if (event.type === "error") {
            notifications.show({
              color: "red",
              title: "Generation failed",
              message: event.message,
              autoClose: 10000,
            });
          } else if (event.type === "done") {
            setTakesKey((k) => k + 1);
            if (event.rendered) {
              notifications.show({
                color: "teal",
                message: `Rendered ${event.rendered} take${event.rendered === 1 ? "" : "s"}.`,
              });
            }
          }
        },
        controller.signal,
      );
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        notifications.show({ color: "red", title: "Generation failed", message: (err as Error).message });
      }
    } finally {
      abortRef.current = null;
      setGenerating(false);
      setProgress(null);
    }
  }

  function cancel() {
    abortRef.current?.abort();
  }

  /** Load a saved take's parameters back into the form. */
  const reuse = useCallback((take: MusicTake, mode: "reproduce" | "vary") => {
    const { model: takeModel, takes: _takes, ...rest } = take.spec;
    setDraft({ ...rest, seed: mode === "reproduce" ? take.seed : null });
    if (takeModel) setModelId(takeModel);
    setUndoDraft(null);
    setEnhancement(null);
    notifications.show({
      color: "gray",
      message:
        mode === "reproduce"
          ? `Loaded take ${take.seed} — Generate renders it again.`
          : `Loaded take ${take.seed} with a fresh seed.`,
    });
  }, []);

  function insertTag(tag: string) {
    const el = lyricsRef.current;
    const text = draft.lyrics ?? "";
    if (!el) {
      set("lyrics", `${text}${text && !text.endsWith("\n") ? "\n" : ""}${tag}\n`);
      return;
    }
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? start;
    const before = text.slice(0, start);
    const prefix = before && !before.endsWith("\n") ? "\n" : "";
    const insert = `${prefix}${tag}\n`;
    set("lyrics", before + insert + text.slice(end));
    // Focus now, move the caret after the re-render. Focusing inside the frame
    // callback instead would leave the chip button focused until then, and
    // anything typed in between goes nowhere.
    el.focus();
    requestAnimationFrame(() => {
      const at = start + insert.length;
      el.setSelectionRange(at, at);
    });
  }

  const llmData = useMemo(
    () => llmModels.map((m) => ({ value: m.id, label: m.loaded ? `${m.label} · loaded` : m.label })),
    [llmModels],
  );

  return (
    <Grid gap="md">
      <Grid.Col span={{ base: 12, md: 7 }}>
        <Stack gap="md">
          {/* --- idea + enhance --- */}
          <Paper withBorder p="md" radius="md">
            <Stack gap="sm">
              <Title order={5}>Idea</Title>
              <Textarea
                placeholder="a slow, hopeful song about leaving a city at dawn"
                description="One line is enough — the model below turns it into a caption, lyrics and metadata."
                autosize
                minRows={2}
                value={idea}
                onChange={(e) => setIdea(e.currentTarget.value)}
              />
              <Group grow align="flex-end">
                <Select
                  label="Prompt writer"
                  placeholder={llmModels.length ? "Select a model" : "llama.cpp unavailable"}
                  data={llmData}
                  value={llmModel}
                  onChange={setLlmModel}
                  disabled={llmModels.length === 0}
                  searchable
                  nothingFoundMessage="No models"
                />
                <Select
                  label="Prompt style"
                  data={profiles.map((p) => ({ value: p.id, label: p.label }))}
                  value={profileId}
                  onChange={setProfileId}
                  disabled={profiles.length === 0}
                />
              </Group>
              <Group justify="space-between">
                <Switch
                  label="Write lyrics"
                  checked={withLyrics}
                  onChange={(e) => setWithLyrics(e.currentTarget.checked)}
                />
                <Group gap="xs">
                  {undoDraft && (
                    <Tooltip label="Restore the caption and lyrics from before" withArrow>
                      <ActionIcon variant="subtle" onClick={undo} aria-label="Undo enhancement">
                        <IconArrowBackUp size={18} />
                      </ActionIcon>
                    </Tooltip>
                  )}
                  <Button
                    leftSection={<IconSparkles size={18} />}
                    onClick={enhance}
                    loading={enhancing}
                    disabled={!llmModel}
                    variant="light"
                  >
                    Enhance
                  </Button>
                </Group>
              </Group>
              {llmError && (
                <Alert color="yellow" icon={<IconAlertTriangle size={16} />} p="xs">
                  <Text size="xs">{llmError} Generation still works — only Enhance needs it.</Text>
                </Alert>
              )}
              {enhancement && !enhancement.parsed && (
                <Alert color="yellow" p="xs">
                  <Text size="xs">
                    {enhancement.model} replied with prose instead of JSON, so its whole answer became
                    the caption. Metadata fields were left alone.
                  </Text>
                </Alert>
              )}
              <Accordion variant="separated">
                <Accordion.Item value="prompt">
                  <Accordion.Control icon={<IconAdjustments size={16} />}>
                    System prompt
                  </Accordion.Control>
                  <Accordion.Panel>
                    <Textarea
                      description="Sent with every Enhance. Edits apply to this session only; change config.toml to keep them."
                      autosize
                      minRows={6}
                      maxRows={18}
                      value={systemPrompt}
                      onChange={(e) => setSystemPrompt(e.currentTarget.value)}
                      styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)", fontSize: 12 } }}
                    />
                  </Accordion.Panel>
                </Accordion.Item>
              </Accordion>
            </Stack>
          </Paper>

          {/* --- the request itself --- */}
          <Paper withBorder p="md" radius="md">
            <Stack gap="md">
              <Title order={5}>Track</Title>
              <Stack gap={4}>
                <Select
                  label="Music model"
                  placeholder={models.length ? "Select a model" : "No music models downloaded"}
                  data={models.map((m) => ({
                    value: m.id,
                    label: `${m.label} · ${m.variantLabel}`,
                  }))}
                  value={modelId}
                  onChange={setModelId}
                  disabled={models.length === 0}
                />
                {model && (
                  <Group gap="xs">
                    <Badge variant="light" color="grape">
                      {model.family}
                    </Badge>
                    {!model.supportsGuidance && (
                      <Badge variant="light" color="gray">
                        no guidance
                      </Badge>
                    )}
                    {serverRunning &&
                      (registeredIds.includes(model.id) ? (
                        <Badge variant="dot" color="green">
                          registered
                        </Badge>
                      ) : (
                        <Badge variant="dot" color="yellow">
                          not registered
                        </Badge>
                      ))}
                  </Group>
                )}
              </Stack>

              <TextInput
                label="Title"
                placeholder="optional — names the take in the list"
                value={draft.title ?? ""}
                onChange={(e) => set("title", e.currentTarget.value)}
              />

              <Textarea
                label="Caption"
                description="Style, mood, instruments, timbre, vocals. Leave tempo and key out — they have their own fields below."
                autosize
                minRows={3}
                value={draft.caption}
                onChange={(e) => set("caption", e.currentTarget.value)}
              />

              <Stack gap={6}>
                <Textarea
                  ref={lyricsRef}
                  label="Lyrics"
                  description="Structure tags on their own line. 6–10 syllables per line; blank line between sections."
                  autosize
                  minRows={4}
                  maxRows={20}
                  value={draft.lyrics ?? ""}
                  onChange={(e) => set("lyrics", e.currentTarget.value)}
                />
                <Group gap={4}>
                  {STRUCTURE_TAGS.map((tag) => (
                    <Chip
                      key={tag}
                      size="xs"
                      checked={false}
                      onClick={() => insertTag(tag)}
                      variant="light"
                    >
                      {tag}
                    </Chip>
                  ))}
                </Group>
              </Stack>

              {/* Headline controls: the four that get touched every run. */}
              <Group grow align="flex-end">
                <NumberInput
                  label="Duration"
                  description="seconds; blank = the model decides"
                  placeholder="auto"
                  value={draft.durationSeconds ?? ""}
                  onChange={(v) => set("durationSeconds", v === "" ? undefined : Number(v))}
                  min={5}
                  max={600}
                />
                <NumberInput
                  label="Steps"
                  value={draft.steps ?? ""}
                  onChange={(v) => set("steps", v === "" ? undefined : Number(v))}
                  min={1}
                  max={120}
                  allowDecimal={false}
                />
                <NumberInput
                  label="Takes"
                  description="rendered one after another"
                  value={takes}
                  onChange={(v) => setTakes(Math.max(1, Math.min(maxTakes, Number(v) || 1)))}
                  min={1}
                  max={maxTakes}
                  allowDecimal={false}
                />
              </Group>

              <Group align="flex-end" gap="xs">
                <NumberInput
                  label="Seed"
                  description="Pin it before tuning anything else, or you can't tell a change from a different roll. Takes walk upward from it."
                  placeholder="random"
                  value={draft.seed ?? ""}
                  onChange={(v) => set("seed", v === "" ? null : Number(v))}
                  min={0}
                  allowDecimal={false}
                  style={{ flex: 1 }}
                />
                <Tooltip label="Roll a seed" withArrow>
                  <ActionIcon
                    variant="light"
                    size="lg"
                    onClick={() => set("seed", Math.floor(Math.random() * 2 ** 31))}
                    aria-label="Roll a random seed"
                  >
                    <IconDice5 size={18} />
                  </ActionIcon>
                </Tooltip>
              </Group>

              <Accordion variant="separated" multiple>
                <Accordion.Item value="metadata">
                  <Accordion.Control icon={<IconAdjustments size={16} />}>
                    Metadata — blank lets the model infer it
                  </Accordion.Control>
                  <Accordion.Panel>
                    <Stack gap="sm">
                      <Group grow>
                        <NumberInput
                          label="BPM"
                          placeholder="inferred"
                          value={draft.bpm ?? ""}
                          onChange={(v) => set("bpm", v === "" ? null : Number(v))}
                          min={30}
                          max={300}
                          allowDecimal={false}
                        />
                        <TextInput
                          label="Key"
                          placeholder="inferred, e.g. Am"
                          value={draft.keyscale ?? ""}
                          onChange={(e) => set("keyscale", e.currentTarget.value)}
                        />
                        <Select
                          label="Time signature"
                          placeholder="inferred"
                          data={TIME_SIGNATURES}
                          value={draft.timeSignature || null}
                          onChange={(v) => set("timeSignature", v ?? "")}
                          clearable
                        />
                      </Group>
                      <Group grow>
                        <TextInput
                          label="Lyric language"
                          placeholder="detected, e.g. en"
                          value={draft.language ?? ""}
                          onChange={(e) => set("language", e.currentTarget.value)}
                        />
                        <TextInput
                          label="Negative prompt"
                          placeholder="what to avoid"
                          value={draft.negativePrompt ?? ""}
                          onChange={(e) => set("negativePrompt", e.currentTarget.value)}
                        />
                      </Group>
                    </Stack>
                  </Accordion.Panel>
                </Accordion.Item>

                <Accordion.Item value="advanced">
                  <Accordion.Control icon={<IconAdjustments size={16} />}>
                    Diffusion and planner
                  </Accordion.Control>
                  <Accordion.Panel>
                    <Stack gap="sm">
                      <Group grow>
                        <NumberInput
                          label="Guidance scale"
                          description={
                            model?.supportsGuidance
                              ? "Higher follows the caption more closely"
                              : "This variant is guidance-distilled and ignores it"
                          }
                          value={draft.guidanceScale ?? ""}
                          onChange={(v) => set("guidanceScale", v === "" ? undefined : Number(v))}
                          disabled={!model?.supportsGuidance}
                          min={0}
                          max={20}
                          step={0.5}
                        />
                        <Select
                          label="Sampler"
                          data={["euler", "heun"]}
                          value={draft.samplerMode || null}
                          onChange={(v) => set("samplerMode", v ?? "")}
                          placeholder="euler"
                          clearable
                        />
                      </Group>
                      <Text size="xs" c="dimmed">
                        Planner LM — the model's own internal LM that infers metadata and semantic
                        codes. Not the prompt writer above.
                      </Text>
                      <Group grow>
                        <NumberInput
                          label="Temperature"
                          placeholder="0.85"
                          value={draft.planner?.temperature ?? ""}
                          onChange={(v) =>
                            set("planner", { ...draft.planner, temperature: v === "" ? undefined : Number(v) })
                          }
                          min={0}
                          max={2}
                          step={0.05}
                        />
                        <NumberInput
                          label="CFG scale"
                          placeholder="2.0"
                          value={draft.planner?.cfgScale ?? ""}
                          onChange={(v) =>
                            set("planner", { ...draft.planner, cfgScale: v === "" ? undefined : Number(v) })
                          }
                          min={0}
                          max={10}
                          step={0.1}
                        />
                        <NumberInput
                          label="Top-p"
                          placeholder="0.9"
                          value={draft.planner?.topP ?? ""}
                          onChange={(v) =>
                            set("planner", { ...draft.planner, topP: v === "" ? undefined : Number(v) })
                          }
                          min={0}
                          max={1}
                          step={0.05}
                        />
                        <NumberInput
                          label="Top-k"
                          placeholder="0 = off"
                          value={draft.planner?.topK ?? ""}
                          onChange={(v) =>
                            set("planner", { ...draft.planner, topK: v === "" ? undefined : Number(v) })
                          }
                          min={0}
                          allowDecimal={false}
                        />
                      </Group>
                    </Stack>
                  </Accordion.Panel>
                </Accordion.Item>
              </Accordion>

              <Group>
                <Button
                  leftSection={<IconMusic size={18} />}
                  onClick={generate}
                  loading={generating}
                  disabled={!model || !serverRunning}
                  size="md"
                >
                  Generate
                </Button>
                {generating && (
                  <Button variant="subtle" color="gray" onClick={cancel}>
                    Cancel
                  </Button>
                )}
              </Group>
              {progress && (
                <Stack gap={4}>
                  <Progress value={(progress.done / progress.total) * 100} size="sm" animated />
                  <Text size="xs" c="dimmed">
                    Take {Math.min(progress.done + 1, progress.total)} of {progress.total} — the first
                    request for a model also loads it into VRAM.
                  </Text>
                </Stack>
              )}
            </Stack>
          </Paper>
        </Stack>
      </Grid.Col>

      <Grid.Col span={{ base: 12, md: 5 }}>
        <MusicTakes highlight={fresh} refreshKey={takesKey} onReuse={reuse} />
      </Grid.Col>
    </Grid>
  );
}
