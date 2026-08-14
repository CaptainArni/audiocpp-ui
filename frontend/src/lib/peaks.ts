/**
 * Waveform peaks for the audio player.
 *
 * The peaks are **decoded from the actual audio**, never synthesised: a
 * decorative waveform that does not match what you are about to hear is worse
 * than no waveform, because it looks like information.
 *
 * That honesty has a cost, so it is bounded twice — by file size (a three-minute
 * stereo music take is ~33 MB, and decoding 33 MB to draw 200 bars is absurd)
 * and by visibility (the caller only asks once a row is actually on screen).
 * Over the limit the player falls back to a plain seek bar, which is a fine
 * control; it just isn't a picture.
 */

/** Above this, don't decode. Comfortably clears any TTS clip, excludes music. */
export const PEAKS_MAX_BYTES = 4 * 1024 * 1024;

/** How many bars a waveform is reduced to. More is invisible at these widths. */
export const PEAKS_BUCKETS = 240;

/**
 * How many clips may be fetched at once.
 *
 * Chrome allows six connections per origin over HTTP/1.1 and the log SSE stream
 * holds one of them for the life of the page. Letting a forty-row list fetch
 * forty clips at once therefore does not just make the waveforms slow — it
 * starves the app's own 2s status poll behind the queue.
 */
const MAX_PARALLEL = 3;

let active = 0;
const queue: (() => void)[] = [];

function acquire(): Promise<void> {
  if (active < MAX_PARALLEL) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => queue.push(resolve));
}

function release(): void {
  const next = queue.shift();
  if (next) next();
  else active--;
}

export interface PeakData {
  peaks: Float32Array;
  /**
   * Exact duration, straight off the decoded buffer.
   *
   * This is why the player never sets `preload="metadata"`: the decode has the
   * duration already, so asking the media element for it as well would double
   * the requests to learn something we know.
   */
  duration: number;
}

/** null = decided against (too big, or it failed) — distinct from "not tried". */
const cache = new Map<string, PeakData | null>();
const inflight = new Map<string, Promise<PeakData | null>>();

let ctx: AudioContext | null = null;

/**
 * One context for the whole app, created on first use and never closed.
 * Browsers cap how many can exist, and a history list is a lot of rows.
 * It stays suspended until something plays; decodeAudioData does not care.
 */
function audioContext(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  return ctx;
}

/** Reduce a decoded buffer to per-bucket peak amplitude, normalised to 0..1. */
function reduce(buffer: AudioBuffer, buckets: number): Float32Array {
  // Channel 0 only. Averaging channels costs a second pass over the samples to
  // change the picture by almost nothing.
  const data = buffer.getChannelData(0);
  const out = new Float32Array(buckets);
  const per = data.length / buckets;
  let max = 0;
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * per);
    const end = Math.min(data.length, Math.floor((b + 1) * per));
    let peak = 0;
    for (let i = start; i < end; i++) {
      const v = data[i] < 0 ? -data[i] : data[i];
      if (v > peak) peak = v;
    }
    out[b] = peak;
    if (peak > max) max = peak;
  }
  // Normalise so a quiet clip still draws a waveform rather than a flat line.
  if (max > 0) for (let b = 0; b < buckets; b++) out[b] /= max;
  return out;
}

export interface PeaksOptions {
  /** Size the caller already knows, so no extra request is needed to check it. */
  knownBytes?: number;
  maxBytes?: number;
  buckets?: number;
}

/**
 * Peaks for `url`, or null if they were declined. Cached per URL; concurrent
 * callers for the same URL share one decode.
 */
export function loadPeaks(url: string, opts: PeaksOptions = {}): Promise<PeakData | null> {
  const cached = cache.get(url);
  if (cached !== undefined) return Promise.resolve(cached);
  const existing = inflight.get(url);
  if (existing) return existing;

  const maxBytes = opts.maxBytes ?? PEAKS_MAX_BYTES;
  const buckets = opts.buckets ?? PEAKS_BUCKETS;

  if (opts.knownBytes != null && opts.knownBytes > maxBytes) {
    cache.set(url, null);
    return Promise.resolve(null);
  }

  const task = (async (): Promise<PeakData | null> => {
    await acquire();
    try {
      const context = audioContext();
      if (!context) return null;
      const res = await fetch(url);
      if (!res.ok) return null;
      const blob = await res.blob();
      // Size was unknown up front; this is the backstop.
      if (blob.size > maxBytes) return null;
      const buffer = await context.decodeAudioData(await blob.arrayBuffer());
      return { peaks: reduce(buffer, buckets), duration: buffer.duration };
    } catch {
      // A codec the browser won't decode is not an error worth surfacing — the
      // player still plays it, it just draws a bar instead of a waveform.
      return null;
    } finally {
      release();
    }
  })().then((data) => {
    cache.set(url, data);
    inflight.delete(url);
    return data;
  });

  inflight.set(url, task);
  return task;
}

/** Drop a URL's cached peaks — for blob: URLs that are about to be revoked. */
export function forgetPeaks(url: string): void {
  cache.delete(url);
  inflight.delete(url);
}
