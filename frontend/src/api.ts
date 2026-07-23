import type {
  DiscoveredModel,
  Generation,
  OcrModelInfo,
  OcrResult,
  Reading,
  ReadingSummary,
  SavedVoice,
  ServerStatus,
  Telemetry,
  TranscribeResult,
  UploadResult,
} from "./types";

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const e = await res.json();
      if (e?.error) msg = e.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export const api = {
  async getModels(): Promise<DiscoveredModel[]> {
    const r = await asJson<{ models: DiscoveredModel[] }>(await fetch("/api/models"));
    return r.models;
  },

  getStatus(): Promise<ServerStatus> {
    return fetch("/api/server/status").then((r) => asJson<ServerStatus>(r));
  },

  start(modelIds?: string[]): Promise<ServerStatus> {
    return fetch("/api/server/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelIds }),
    }).then((r) => asJson<ServerStatus>(r));
  },

  stop(): Promise<ServerStatus> {
    return fetch("/api/server/stop", { method: "POST" }).then((r) => asJson<ServerStatus>(r));
  },

  async getRegistered(): Promise<string[]> {
    const r = await asJson<{ models: { id: string }[] }>(await fetch("/api/server/registered"));
    return r.models.map((m) => m.id);
  },

  upload(file: File): Promise<UploadResult> {
    const fd = new FormData();
    fd.append("file", file);
    return fetch("/api/uploads", { method: "POST", body: fd }).then((r) => asJson<UploadResult>(r));
  },

  async getVoices(): Promise<SavedVoice[]> {
    const r = await asJson<{ voices: SavedVoice[] }>(await fetch("/api/voices"));
    return r.voices;
  },

  saveVoice(payload: { uploadId: string; name: string; referenceText?: string }): Promise<{ id: string }> {
    return fetch("/api/voices", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).then((r) => asJson<{ id: string }>(r));
  },

  deleteVoice(id: string): Promise<{ ok: boolean }> {
    return fetch(`/api/voices/${id}`, { method: "DELETE" }).then((r) => asJson<{ ok: boolean }>(r));
  },

  voiceAudioUrl(id: string): string {
    return `/api/voices/${id}/audio`;
  },

  async tts(payload: unknown): Promise<{ blob: Blob; name: string | null }> {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const e = await res.json();
        if (e?.error) msg = e.error;
      } catch {
        /* ignore */
      }
      throw new Error(msg);
    }
    return { blob: await res.blob(), name: res.headers.get("X-Generation-Name") };
  },

  transcribe(payload: unknown): Promise<TranscribeResult> {
    return fetch("/api/transcribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).then((r) => asJson<TranscribeResult>(r));
  },

  uploadAudioUrl(uploadId: string): string {
    return `/api/uploads/${uploadId}/audio`;
  },

  // --- saved readings (shared with the Android app) ---
  async getReadings(): Promise<ReadingSummary[]> {
    const r = await asJson<{ readings: ReadingSummary[] }>(await fetch("/api/readings"));
    return r.readings;
  },

  createReading(payload: { name: string; pages: string[]; lastVoiceId?: string | null }): Promise<Reading> {
    return fetch("/api/readings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).then((r) => asJson<Reading>(r));
  },

  getReading(id: string): Promise<Reading> {
    return fetch(`/api/readings/${id}`).then((r) => asJson<Reading>(r));
  },

  updateReading(
    id: string,
    patch: { name?: string; pages?: string[]; lastVoiceId?: string | null },
  ): Promise<Reading> {
    return fetch(`/api/readings/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => asJson<Reading>(r));
  },

  deleteReading(id: string): Promise<{ ok: boolean }> {
    return fetch(`/api/readings/${id}`, { method: "DELETE" }).then((r) => asJson<{ ok: boolean }>(r));
  },

  // --- OCR test bench ---
  async getOcrModels(): Promise<{ models: OcrModelInfo[]; default: string }> {
    return asJson<{ models: OcrModelInfo[]; default: string }>(await fetch("/api/ocr/models"));
  },

  ocr(file: File, model?: string, prompt?: string): Promise<OcrResult> {
    const fd = new FormData();
    fd.append("file", file);
    if (model) fd.append("model", model);
    if (prompt) fd.append("prompt", prompt);
    return fetch("/api/ocr", { method: "POST", body: fd }).then((r) => asJson<OcrResult>(r));
  },

  // --- telemetry ---
  getTelemetry(): Promise<Telemetry> {
    return fetch("/api/telemetry").then((r) => asJson<Telemetry>(r));
  },

  async getGenerations(): Promise<Generation[]> {
    const r = await asJson<{ generations: Generation[] }>(await fetch("/api/generations"));
    return r.generations;
  },

  clearGenerations(): Promise<{ removed: number }> {
    return fetch("/api/generations", { method: "DELETE" }).then((r) => asJson<{ removed: number }>(r));
  },
};
