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
  loadOptions?: Record<string, string>;
  sessionOptions?: Record<string, string>;
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

/** Per-model telemetry row. `kind` is tts | asr | ocr. */
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
