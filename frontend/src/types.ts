export type Task = "tts" | "asr";

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
