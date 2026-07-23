// Minimal client-side WAV encoding.
//
// The backend and audiocpp only accept WAV, but the browser's MediaRecorder
// produces WebM/Opus. We decode the recording to PCM (via AudioContext) and
// re-encode it here as a mono 16-bit PCM WAV so it flows through the existing
// /api/uploads endpoint unchanged.

/** Downmix an AudioBuffer to a single mono Float32 channel (average of channels). */
export function audioBufferToMono(buffer: AudioBuffer): Float32Array {
  const channels = buffer.numberOfChannels;
  if (channels === 1) return buffer.getChannelData(0);

  const length = buffer.length;
  const mono = new Float32Array(length);
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i++) mono[i] += data[i];
  }
  for (let i = 0; i < length; i++) mono[i] /= channels;
  return mono;
}

/** Encode mono Float32 samples as a 16-bit PCM WAV Blob at the given sample rate. */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  // RIFF header
  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");

  // fmt chunk (PCM, mono)
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, 1, true); // channels = mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, 16, true); // bits per sample

  // data chunk
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([view], { type: "audio/wav" });
}

export interface WavInfo {
  durationSec: number;
  /** Peak amplitude 0..1 for 16-bit PCM; null when it can't be measured. */
  peak: number | null;
}

/**
 * Read duration (and, for 16-bit PCM, peak amplitude) from a WAV blob by parsing
 * its header/chunks — no decoding. Used to spot generations that came back empty
 * or silent. Returns zeros for anything that isn't a parseable RIFF/WAVE.
 */
export async function inspectWav(blob: Blob): Promise<WavInfo> {
  const buf = await blob.arrayBuffer();
  const view = new DataView(buf);
  const tag = (off: number) =>
    String.fromCharCode(
      view.getUint8(off),
      view.getUint8(off + 1),
      view.getUint8(off + 2),
      view.getUint8(off + 3),
    );

  if (buf.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") {
    return { durationSec: 0, peak: null };
  }

  let fmt: { audioFormat: number; channels: number; sampleRate: number; byteRate: number; bits: number } | null = null;
  let dataOffset = 0;
  let dataSize = 0;

  // Walk the word-aligned chunk list, capturing fmt and the first data chunk.
  for (let off = 12; off + 8 <= buf.byteLength; ) {
    const id = tag(off);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === "fmt ") {
      fmt = {
        audioFormat: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        byteRate: view.getUint32(body + 8, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === "data" && dataSize === 0) {
      dataOffset = body;
      dataSize = Math.min(size, buf.byteLength - body);
    }
    off = body + size + (size % 2);
  }

  if (!fmt) return { durationSec: 0, peak: null };
  const byteRate = fmt.byteRate || fmt.sampleRate * fmt.channels * (fmt.bits / 8);
  const durationSec = byteRate > 0 ? dataSize / byteRate : 0;

  let peak: number | null = null;
  if (fmt.audioFormat === 1 && fmt.bits === 16 && dataSize > 0) {
    let max = 0;
    for (let p = dataOffset; p + 1 < dataOffset + dataSize; p += 2) {
      const v = Math.abs(view.getInt16(p, true));
      if (v > max) max = v;
    }
    peak = max / 32768;
  }

  return { durationSec, peak };
}

/** Resample mono Float32 samples to a different rate via OfflineAudioContext. */
async function resampleMono(samples: Float32Array, fromRate: number, toRate: number): Promise<Float32Array> {
  const duration = samples.length / fromRate;
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(duration * toRate)), toRate);
  const buf = off.createBuffer(1, samples.length, fromRate);
  buf.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
  const node = off.createBufferSource();
  node.buffer = buf;
  node.connect(off.destination);
  node.start();
  const rendered = await off.startRendering();
  return rendered.getChannelData(0);
}

/**
 * Decode an arbitrary recorded audio Blob (e.g. WebM/Opus) into a mono 16-bit
 * PCM WAV File, optionally resampled to a fixed rate.
 */
export async function blobToWavFile(blob: Blob, fileName = "recording.wav", targetRate?: number): Promise<File> {
  const arrayBuffer = await blob.arrayBuffer();
  const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();
  try {
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    let mono = audioBufferToMono(audioBuffer);
    let rate = audioBuffer.sampleRate;
    if (targetRate && rate !== targetRate) {
      mono = await resampleMono(mono, rate, targetRate);
      rate = targetRate;
    }
    const wav = encodeWav(mono, rate);
    return new File([wav], fileName, { type: "audio/wav" });
  } finally {
    void ctx.close();
  }
}

/**
 * Prepare any dropped audio file for the WAV-only /api/uploads endpoint.
 * WAV files pass through untouched; anything else (webm/weba, mp3, ogg, m4a,
 * flac, …) is decoded via AudioContext and re-encoded as mono 16-bit PCM WAV.
 * With `targetRate` set, every file (WAVs included) is decoded and resampled —
 * ASR uploads need exactly 16 kHz for the server's VAD chunking.
 */
export async function fileToWavUpload(file: File, targetRate?: number): Promise<File> {
  if (!targetRate && file.name.toLowerCase().endsWith(".wav")) return file;
  const stem = file.name.replace(/\.[^.]*$/, "") || "upload";
  try {
    return await blobToWavFile(file, `${stem}.wav`, targetRate);
  } catch {
    throw new Error(`Could not decode "${file.name}" as audio — is it a supported audio file?`);
  }
}
