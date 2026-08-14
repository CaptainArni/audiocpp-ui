/** "gen" is music/audio generation — audio.cpp's own task string for it. */
export type Task = "tts" | "asr" | "gen";

export interface DiscoveredModel {
  id: string;
  dir: string;
  path: string;
  known: boolean;
  family: string | null;
  task: Task | null;
  clone: boolean;
  voiceDesign: boolean;
  languages: string[];
  builtinVoices: string[];
  /** Registered `mode: "streaming"` — can emit audio/transcript chunks as they
   *  are produced, which is what the Call tab uses for low-latency replies. */
  streaming?: boolean;
  loadOptions?: Record<string, string>;
  sessionOptions?: Record<string, string>;
  /** Request-option defaults the server applies to every request for this model. */
  defaultRequestOptions?: Record<string, string>;
  /** ASR only: word timestamps available (forced aligner installed). */
  timestamps?: boolean;
  /** task "gen" only — see MusicModel. Null on every speech model. */
  music?: MusicModelTraits | null;
  sizeMB: number;
}

export interface TranscriptWord {
  word: string;
  /** seconds */
  start: number;
  end: number;
}

export interface TranscribeResult {
  text: string;
  language?: string | null;
  words: TranscriptWord[];
}

export type ServerRunState = "stopped" | "starting" | "running" | "error";

export interface ServerStatus {
  state: ServerRunState;
  pid: number | null;
  includedModelIds: string[];
  healthModels: number;
  lastError: string | null;
  host: string;
  port: number;
  device: number;
  configPath: string;
}

export interface Generation {
  name: string;
  url: string;
  sizeKB: number;
  mtime: number;
}

export interface TtsParams {
  seed?: number;
  temperature?: number;
  top_k?: number;
  top_p?: number;
  max_tokens?: number;
  language?: string;
}

export interface UploadResult {
  uploadId: string;
  path: string;
  originalName: string;
  /** Duration of the stored WAV; null when it couldn't be read. */
  durationSec?: number | null;
  /** True when the backend ran ffmpeg on it (i.e. it wasn't already a WAV). */
  converted?: boolean;
  sourceKind?: "wav" | "audio" | "video";
}

/** What the backend can do with non-WAV media (GET /api/media/support). */
export interface MediaSupport {
  ffmpeg: boolean;
  version: string | null;
  maxDurationSec: number;
  maxUploadMb: number;
}

export interface SavedVoice {
  id: string;
  name: string;
  referenceText: string;
  createdAt: number;
  sizeKB: number;
  durationSec: number | null;
}

/** A saved reading as listed by GET /api/readings (no page bodies). */
export interface ReadingSummary {
  id: string;
  name: string;
  pageCount: number;
  lastVoiceId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A full saved reading (page texts) from GET /api/readings/{id}. */
export interface Reading {
  id: string;
  name: string;
  pages: string[];
  lastVoiceId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A selectable OCR model from GET /api/ocr/models (with its effective prompt). */
export interface OcrModelInfo {
  id: string;
  label: string;
  prompt: string;
}

/** Result of POST /api/ocr (the test bench and the phone share this shape). */
export interface OcrResult {
  text: string;
  model: string;
  seconds: number;
  truncated: boolean;
}

// --- music generation ------------------------------------------------------

/**
 * What one music model variant can do.
 *
 * A package like ACE-Step ships two DiT variants and picks between them with a
 * *load* option, so each is registered as its own model and appears as its own
 * row — the picker chooses a model, it does not set a parameter.
 */
export interface MusicModelTraits {
  variant: string;
  variantLabel: string;
  isDefault: boolean;
  routes: string[];
  /** Sensible step count for this variant (turbo is distilled to ~8). */
  steps: number | null;
  guidanceScale: number | null;
  /** Turbo is guidance-distilled and ignores the scale, so the panel hides it
   *  rather than offering a dial that does nothing. */
  supportsGuidance: boolean;
}

export interface MusicModel extends MusicModelTraits {
  id: string;
  label: string;
  family: string;
  sizeMB: number;
}

export interface MusicModelsResponse {
  models: MusicModel[];
  default: string;
  maxTakes: number;
  defaultDurationSec: number;
}

/** An enhancement profile: the system prompt that turns an idea into a request.
 *  Bound to a music *family*, so switching model switches the rules with it. */
export interface MusicPromptProfile {
  id: string;
  label: string;
  family: string;
  model: string;
  systemPrompt: string;
}

export interface MusicPromptsResponse {
  chatModels: ChatModelInfo[];
  /** Non-null when llama.cpp is unreachable. Generation still works; only
   *  Enhance does not. */
  chatError: string | null;
  prompts: MusicPromptProfile[];
  default: string;
  lyricsInstruction: { on: string; off: string };
}

/** ACE-Step's internal planner LM — *not* the llama.cpp model that writes the
 *  caption. It infers metadata and semantic codes inside the music model. */
export interface MusicPlannerParams {
  temperature?: number;
  cfgScale?: number;
  topK?: number;
  topP?: number;
  repetitionPenalty?: number;
}

/** One generation request, and — saved verbatim in a take's sidecar — the only
 *  thing that makes a good result reproducible later. */
export interface MusicSpec {
  model: string;
  route?: string;
  title?: string;
  caption: string;
  lyrics?: string;
  language?: string;
  durationSeconds?: number;
  steps?: number;
  guidanceScale?: number;
  seed?: number | null;
  takes?: number;
  bpm?: number | null;
  keyscale?: string;
  timeSignature?: string;
  negativePrompt?: string;
  samplerMode?: string;
  retakeSeed?: number;
  retakeVariance?: number;
  planner?: MusicPlannerParams;
  /** Audio-conditioned routes (cover, repaint, extract, lego, complete). */
  uploadId?: string;
  trackName?: string;
  repaintStart?: number;
  repaintEnd?: number;
  repaintMode?: string;
  repaintStrength?: number;
  audioCoverStrength?: number;
  coverNoiseStrength?: number;
}

/** A rendered take, as stored beside its WAV. */
export interface MusicTake {
  id: string;
  createdAt: number;
  model: string;
  seed: number;
  title: string;
  sizeBytes: number;
  durationSec: number | null;
  sampleRate: number | null;
  channels: number | null;
  spec: MusicSpec;
  /** What actually went upstream — the tie-breaker when a result and the spec
   *  seem to disagree. */
  request: Record<string, unknown>;
  timing: { wall_ms?: number; audio_duration_ms?: number; rtf?: number };
}

/** One event from the POST /api/music/generate SSE stream. Takes arrive one at
 *  a time so a failure on the fourth does not discard the first three. */
export type MusicEvent =
  | { type: "start"; takes: number; seeds: number[] }
  | { type: "take"; index: number; take: MusicTake }
  | { type: "error"; message: string }
  | { type: "done"; rendered: number };

/** What the enhancer made of an idea. `parsed` is false when the model did not
 *  answer with JSON and its whole reply became the caption. */
export interface MusicEnhancement {
  fields: Partial<MusicSpec> & { caption: string };
  raw: string;
  model: string;
  profile: string;
  seconds: number;
  parsed: boolean;
}

// --- voice call ------------------------------------------------------------

/** A chat model the llama.cpp server can serve (GET /api/call/config). */
export interface ChatModelInfo {
  id: string;
  label: string;
  /** Already loaded — an unloaded model costs a llama-swap load before the
   *  first token, which lands inside the reply time unless it's warmed first. */
  loaded: boolean;
  vision: boolean;
}

/** A response-length preset: a token cap *and* the instruction that makes the
 *  answer actually end at that length. */
export interface LengthPreset {
  id: string;
  label: string;
  max_tokens: number;
  instruction: string;
}

export interface CallConfig {
  chatModels: ChatModelInfo[];
  /** Non-null when llama.cpp couldn't be reached; the tab still renders. */
  chatError: string | null;
  defaultChatModel: string;
  defaultTtsModel: string;
  defaultAsrModel: string;
  lengths: LengthPreset[];
  defaultLength: string;
  systemPrompt: string;
  vadHangoverMs: number;
  vadPrerollMs: number;
  fillerAfterMs: number;
  fillerText: string;
  streamSampleRate: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** One event from the POST /api/chat SSE stream. */
export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  /** A complete, speakable segment — the unit of playback for every client. */
  | { type: "speak"; index: number; text: string }
  /** Older turns were dropped before sending ([call].context_messages). Sent
   *  first, so the client can say so rather than let the model quietly forget. */
  | { type: "context"; dropped: number; kept: number }
  | { type: "truncated" }
  | { type: "error"; message: string }
  | {
      type: "done";
      text: string;
      seconds: number;
      tokens: number | null;
      firstTokenMs: number | null;
      truncated: boolean;
    };

export interface WarmupResult {
  chat?: number | null;
  tts?: number | null;
  asr?: number | null;
  chatError?: string;
  ttsError?: string;
  asrError?: string;
  /** base64 WAV of the filler phrase, synthesised in the selected voice. */
  filler?: string;
}

/** A saved call as listed by GET /api/conversations (no transcript). */
export interface ConversationSummary {
  id: string;
  name: string;
  turnCount: number;
  preview: string;
  chatModel: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A full saved call. `messages` is exactly what /api/chat takes back, which is
 *  what makes one resumable rather than only readable. */
export interface Conversation extends ConversationSummary {
  messages: ChatMessage[];
}

/** Result of POST /api/server/unload. */
export interface UnloadResult {
  unloaded: string[];
  not_found?: string[];
}

/** One inference server's GPU residency (GET /api/vram).
 *
 *  `loaded` is what the server itself reports holding — not what Studio has
 *  served, which is a different question and goes stale across restarts. */
export interface VramServer {
  running: boolean;
  loaded: string[];
}

export interface VramStatus {
  audiocpp: VramServer;
  llama: VramServer;
}

export type VramTarget = "audiocpp" | "llama";

/** Per-model telemetry row. `kind` is tts | asr | ocr | chat. */
export interface TelemetryModel {
  model: string;
  kind: string;
  count: number;
  warmed: boolean;
  lastMs?: number;
  lastAt?: number;
  lastThroughput?: number;
  throughputUnit?: string;
}

export interface TelemetryEvent {
  at: number;
  model: string;
  kind: string;
  ms: number;
  throughput: number | null;
  unit: string | null;
  detail: string;
}

export interface Telemetry {
  server: ServerStatus;
  metrics: {
    models: TelemetryModel[];
    events: TelemetryEvent[];
    serverEpoch: number;
  };
}

/**
 * The companion app's debug APK, as Studio found it on disk.
 *
 * `versionName` is hand-maintained in build.gradle.kts and repeats across
 * builds, so `builtAt` — and `stale`, which compares it against the newest file
 * under app/src — is what actually answers "is this the build I just made?".
 */
export interface AndroidApkInfo {
  available: boolean;
  reason?: string;
  url?: string;
  fileName?: string;
  sizeBytes?: number;
  builtAt?: number;
  versionName?: string;
  versionCode?: number;
  sourceChangedAt?: number;
  stale?: boolean;
}
