import type {
  CallConfig,
  ChatEvent,
  ChatMessage,
  DiscoveredModel,
  Generation,
  MediaSupport,
  OcrModelInfo,
  OcrResult,
  Reading,
  ReadingSummary,
  SavedVoice,
  ServerStatus,
  Telemetry,
  TranscribeResult,
  UploadResult,
  WarmupResult,
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

  /**
   * Upload audio or video. `rate` asks the backend to transcode to that sample
   * rate (ASR wants 16000); without it a .wav is stored untouched.
   *
   * With `onProgress` the request goes out over XMLHttpRequest — `fetch` reports
   * no upload progress, and a video can take minutes to send.
   */
  upload(
    file: File,
    opts: { rate?: number; onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
  ): Promise<UploadResult> {
    const fd = new FormData();
    fd.append("file", file);
    if (opts.rate) fd.append("rate", String(opts.rate));
    if (!opts.onProgress) {
      return fetch("/api/uploads", { method: "POST", body: fd, signal: opts.signal }).then((r) =>
        asJson<UploadResult>(r),
      );
    }
    return new Promise<UploadResult>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/uploads");
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) opts.onProgress!(e.loaded / e.total);
      };
      xhr.onload = () => {
        let body: unknown;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          body = null;
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body as UploadResult);
        else reject(new Error((body as { error?: string })?.error ?? `HTTP ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error("Upload failed — the connection dropped."));
      xhr.onabort = () => reject(new Error("Upload cancelled."));
      opts.signal?.addEventListener("abort", () => xhr.abort());
      xhr.send(fd);
    });
  },

  getMediaSupport(): Promise<MediaSupport> {
    return fetch("/api/media/support").then((r) => asJson<MediaSupport>(r));
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

  // --- voice call ---
  getCallConfig(): Promise<CallConfig> {
    return fetch("/api/call/config").then((r) => asJson<CallConfig>(r));
  },

  /**
   * Stream one assistant turn, calling `onEvent` for each SSE event.
   *
   * Not `EventSource`: this is a POST with a JSON body (the conversation), and
   * EventSource is GET-only. `signal` is how a barge-in cancels the turn —
   * aborting closes the connection, which stops llama.cpp generating.
   */
  async chatStream(
    payload: {
      model: string;
      messages: ChatMessage[];
      thinking?: boolean;
      length?: string;
      systemPrompt?: string;
    },
    onEvent: (event: ChatEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
    if (!res.ok || !res.body) {
      let msg = `HTTP ${res.status}`;
      try {
        const e = await res.json();
        if (e?.error) msg = e.error;
      } catch {
        /* ignore */
      }
      throw new Error(msg);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line; keep the partial tail.
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            onEvent(JSON.parse(line.slice(5).trim()) as ChatEvent);
          } catch {
            /* a malformed frame is not worth killing the turn over */
          }
        }
      }
    }
  },

  /** One turn of speech in, transcript out (upload + ASR in one round trip). */
  async callListen(file: File, model: string, language?: string): Promise<{ text: string; seconds: number }> {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("model", model);
    if (language) fd.append("language", language);
    return asJson<{ text: string; seconds: number }>(
      await fetch("/api/call/listen", { method: "POST", body: fd }),
    );
  },

  /**
   * Synthesise one segment. Returns the raw `Response` — the caller owns the
   * body, because the whole point is to start playing it before it has finished
   * arriving.
   */
  async callSpeak(payload: unknown, signal?: AbortSignal): Promise<Response> {
    const res = await fetch("/api/call/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
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
    return res;
  },

  callWarmup(payload: unknown): Promise<WarmupResult> {
    return fetch("/api/call/warmup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).then((r) => asJson<WarmupResult>(r));
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
