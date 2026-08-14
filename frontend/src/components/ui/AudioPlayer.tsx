import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { ActionIcon, Popover, Slider, Tooltip } from "@mantine/core";
import {
  IconDownload,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconVolume,
  IconVolume2,
  IconVolume3,
} from "@tabler/icons-react";
import { loadPeaks, PEAKS_BUCKETS } from "../../lib/peaks";
import "./AudioPlayer.css";

/**
 * One <audio> plays at a time.
 *
 * The history list used to be eight independent native players, every one of
 * which would happily play over the others. Starting one now stops whatever was
 * already going.
 */
let playing: HTMLAudioElement | null = null;

function claim(el: HTMLAudioElement): void {
  if (playing && playing !== el) playing.pause();
  playing = el;
}

/**
 * `play()` returns a promise that **rejects with AbortError** when something
 * pauses the element before it settles — which is precisely what `claim()` does
 * to the previous row every time you start a new one. That is the designed
 * behaviour, not a failure, but discarding the promise with `void` leaves an
 * unhandled rejection in the console on every switch. Anything else is a real
 * problem and still gets reported.
 */
function safePlay(el: HTMLAudioElement | null | undefined): void {
  void el?.play().catch((err: unknown) => {
    if ((err as DOMException | null)?.name === "AbortError") return;
    console.warn("audio playback failed", err);
  });
}

/**
 * `total` rounds instead of truncating.
 *
 * TTS output here is routinely under a second — a run that stops early is one of
 * the failure modes this app warns about — and a truncating clock labels a real
 * 0.96s clip "0:00", which reads as an empty file rather than a short one. The
 * running counter still truncates, so it never claims a second that has not
 * happened yet.
 */
export function formatTime(sec: number, total = false): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const s = total ? Math.round(sec) : Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export interface AudioPlayerHandle {
  seek(seconds: number): void;
  play(): void;
  pause(): void;
  readonly element: HTMLAudioElement | null;
}

interface Props {
  src: string;
  /** Compact list row, or the larger single player for a "latest" slot. */
  variant?: "row" | "full";
  /**
   * Size in bytes when the caller knows it. Used to decline peak decoding up
   * front for anything large — see lib/peaks.ts.
   */
  sizeBytes?: number;
  /**
   * Duration the caller already knows (music takes and saved voices both carry
   * one). Given this, a clip whose peaks were declined for size still shows a
   * real length instead of 0:00 — and costs no request to find out.
   */
  durationSec?: number | null;
  /** Never decode peaks; draw the plain bar. */
  noWaveform?: boolean;
  /** Extra controls at the right end (download, delete, expand…). */
  actions?: ReactNode;
  /** Fires on every animation frame while playing — for karaoke highlighting. */
  onProgress?: (seconds: number) => void;
  onEnded?: () => void;
  ref?: Ref<AudioPlayerHandle>;
}

export function AudioPlayer({
  src,
  variant = "row",
  sizeBytes,
  durationSec,
  noWaveform,
  actions,
  onProgress,
  onEnded,
  ref,
}: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const seekRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  const peaksRef = useRef<Float32Array | null>(null);
  const progressRef = useRef(0);

  const [isPlaying, setPlaying] = useState(false);
  const [duration, setDuration] = useState(durationSec ?? 0);
  const [current, setCurrent] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [hasPeaks, setHasPeaks] = useState(false);
  const [needsMeta, setNeedsMeta] = useState(false);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [volume, setVolume] = useState(1);

  useImperativeHandle(
    ref,
    () => ({
      seek(seconds: number) {
        const el = audioRef.current;
        if (!el) return;
        el.currentTime = seconds;
        safePlay(el);
      },
      play() {
        safePlay(audioRef.current);
      },
      pause() {
        audioRef.current?.pause();
      },
      get element() {
        return audioRef.current;
      },
    }),
    [],
  );

  // ---- waveform ---------------------------------------------------------

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const peaks = peaksRef.current;
    if (!canvas || !peaks) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const g = canvas.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const styles = getComputedStyle(canvas);
    const idle = styles.getPropertyValue("--wave-idle").trim() || "#35333f";
    const live = styles.getPropertyValue("--wave-live").trim() || "#ef1ac4";

    const n = peaks.length;
    const step = w / n;
    const barW = Math.max(1, step - 1);
    const mid = h / 2;
    const played = progressRef.current * w;

    for (let i = 0; i < n; i++) {
      const x = i * step;
      // A floor of 1px: silence should still read as a track, not a gap.
      const barH = Math.max(1.5, peaks[i] * (h - 2));
      g.fillStyle = x + barW / 2 <= played ? live : idle;
      g.fillRect(x, mid - barH / 2, barW, barH);
    }
  }, []);

  /**
   * Nothing is fetched until the row is actually on screen, and then exactly
   * once: the peaks decode yields the duration too, so the player never asks
   * the media element to preload metadata.
   *
   * That is not a micro-optimisation. Chrome allows six connections per origin,
   * the log SSE stream permanently holds one, and the generations list runs to
   * dozens of rows — `preload="metadata"` on all of them queued so deep that
   * every row sat at 0:00 / 0:00 indefinitely *and* the app's own status poll
   * starved behind it.
   *
   * `needsMeta` is the fallback for the few clips whose peaks were declined
   * (anything over the size limit — a music take), which have no other way to
   * learn how long they are.
   */
  useEffect(() => {
    let alive = true;
    const el = seekRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer.disconnect();
        if (noWaveform) {
          if (!durationSec) setNeedsMeta(true);
          return;
        }
        void loadPeaks(src, { knownBytes: sizeBytes, buckets: PEAKS_BUCKETS }).then((data) => {
          if (!alive) return;
          if (!data) {
            // Peaks were declined (too large). Only pay for a metadata request
            // if the caller could not tell us the duration itself.
            if (!durationSec) setNeedsMeta(true);
            return;
          }
          peaksRef.current = data.peaks;
          setHasPeaks(true);
          setDuration((d) => d || data.duration);
          draw();
        });
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, [src, sizeBytes, noWaveform, durationSec, draw]);

  // Flipping `preload` after the element has settled on "none" does not make
  // Chrome fetch anything — it has to be told to reload.
  useEffect(() => {
    if (needsMeta) audioRef.current?.load();
  }, [needsMeta]);

  // Draw once the canvas actually exists. `draw()` cannot be called straight
  // after the peaks resolve: setHasPeaks is what *renders* the canvas, so at
  // that point canvasRef is still null and the call is a no-op with nothing to
  // trigger a retry.
  useEffect(() => {
    if (hasPeaks) draw();
  }, [hasPeaks, draw]);

  // Redraw on resize — the canvas is fluid inside the card.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(el);
    return () => ro.disconnect();
  }, [draw, hasPeaks]);

  // ---- playback ---------------------------------------------------------

  const tick = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    const d = el.duration || 0;
    progressRef.current = d > 0 ? el.currentTime / d : 0;
    setCurrent(el.currentTime);
    onProgress?.(el.currentTime);
    draw();
    if (!el.paused && !el.ended) rafRef.current = requestAnimationFrame(tick);
  }, [draw, onProgress]);

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  // A new source is a new clip: reset, don't inherit the old one's position.
  useEffect(() => {
    progressRef.current = 0;
    peaksRef.current = null;
    setHasPeaks(false);
    setNeedsMeta(false);
    setCurrent(0);
    setDuration(durationSec ?? 0);
    setBuffered(0);
  }, [src, durationSec]);

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      claim(el);
      safePlay(el);
    } else {
      el.pause();
    }
  };

  const seekToClientX = (clientX: number) => {
    const el = audioRef.current;
    const box = seekRef.current?.getBoundingClientRect();
    // `el.duration` is NaN until the clip has actually been loaded, which now
    // only happens on play — so seeking before the first play falls back to the
    // duration the peaks decode reported.
    const total = el?.duration || duration;
    if (!el || !box || !total) return;
    const ratio = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    el.currentTime = ratio * total;
    progressRef.current = ratio;
    setCurrent(ratio * total);
    draw();
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    seekToClientX(e.clientX);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const box = seekRef.current?.getBoundingClientRect();
    if (box) setHoverX(e.clientX - box.left);
    if (e.buttons === 1) seekToClientX(e.clientX);
  };

  const ratio = duration > 0 ? current / duration : 0;
  const VolumeIcon = volume === 0 ? IconVolume3 : volume < 0.5 ? IconVolume2 : IconVolume;

  return (
    <div className="app-player" data-variant={variant}>
      {/* The two duration handlers below read `duration` off the event *now*,
          never inside the state updater. React invokes an updater during a later
          render, by which point it has nulled `currentTarget` on the event — so
          the functional form threw "Cannot read properties of null (reading
          'duration')" the moment a clip was played. They also keep whatever
          duration is already known when the element reports nothing useful (NaN
          before load, 0 for a stream), so a `durationSec` the caller supplied is
          never clobbered back to zero. */}
      <audio
        ref={audioRef}
        src={src}
        preload={needsMeta ? "metadata" : "none"}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          setDuration((prev) => (Number.isFinite(d) && d > 0 ? d : prev));
        }}
        onDurationChange={(e) => {
          const d = e.currentTarget.duration;
          setDuration((prev) => (Number.isFinite(d) && d > 0 ? d : prev));
        }}
        onPlay={() => {
          const el = audioRef.current;
          if (el) claim(el);
          setPlaying(true);
          cancelAnimationFrame(rafRef.current);
          rafRef.current = requestAnimationFrame(tick);
        }}
        onPause={() => {
          setPlaying(false);
          cancelAnimationFrame(rafRef.current);
        }}
        onEnded={() => {
          setPlaying(false);
          progressRef.current = 0;
          setCurrent(0);
          draw();
          onEnded?.();
        }}
        onProgress={(e) => {
          const a = e.currentTarget;
          if (a.buffered.length > 0 && a.duration) {
            setBuffered(a.buffered.end(a.buffered.length - 1) / a.duration);
          }
        }}
        onSeeked={(e) => {
          setCurrent(e.currentTarget.currentTime);
          onProgress?.(e.currentTarget.currentTime);
        }}
      >
        <track kind="captions" />
      </audio>

      <button
        type="button"
        className="app-player-play"
        data-playing={isPlaying || undefined}
        onClick={toggle}
        aria-label={isPlaying ? "Pause" : "Play"}
      >
        {isPlaying ? (
          <IconPlayerPauseFilled size={variant === "full" ? 18 : 13} />
        ) : (
          <IconPlayerPlayFilled size={variant === "full" ? 18 : 13} />
        )}
      </button>

      <div
        ref={seekRef}
        className="app-player-seek"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHoverX(null)}
        role="slider"
        tabIndex={0}
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(current)}
        onKeyDown={(e) => {
          const el = audioRef.current;
          if (!el || !el.duration) return;
          if (e.key === "ArrowRight") {
            e.preventDefault();
            el.currentTime = Math.min(el.duration, el.currentTime + 5);
          } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            el.currentTime = Math.max(0, el.currentTime - 5);
          } else if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            toggle();
          }
        }}
        style={
          {
            "--wave-idle": "var(--app-wave)",
            "--wave-live": "var(--app-audio)",
          } as React.CSSProperties
        }
      >
        {hasPeaks ? (
          <canvas ref={canvasRef} />
        ) : (
          <div className="app-player-bar">
            <div className="app-player-bar-buffered" style={{ width: `${buffered * 100}%` }} />
            <div className="app-player-bar-fill" style={{ width: `${ratio * 100}%` }} />
          </div>
        )}
        <div
          className="app-player-head"
          data-active={isPlaying || undefined}
          style={{ left: hoverX ?? `${ratio * 100}%` }}
        />
      </div>

      <span className="app-player-time">
        {formatTime(current)} / {formatTime(duration, true)}
      </span>

      <div className="app-player-actions">
        <Popover position="top" withArrow width={40}>
          <Popover.Target>
            <ActionIcon variant="subtle" color="gray" size="sm" aria-label="Volume">
              <VolumeIcon size={15} />
            </ActionIcon>
          </Popover.Target>
          <Popover.Dropdown p="xs">
            <Slider
              orientation="vertical"
              h={90}
              min={0}
              max={1}
              step={0.05}
              value={volume}
              label={(v) => `${Math.round(v * 100)}%`}
              onChange={(v) => {
                setVolume(v);
                if (audioRef.current) audioRef.current.volume = v;
              }}
            />
          </Popover.Dropdown>
        </Popover>
        {actions}
      </div>
    </div>
  );
}

/** A download button shaped like the player's other actions. */
export function DownloadAction({ href, name }: { href: string; name: string }) {
  return (
    <Tooltip label="Download">
      <ActionIcon
        component="a"
        href={href}
        download={name}
        variant="subtle"
        color="gray"
        size="sm"
        aria-label="Download"
      >
        <IconDownload size={15} />
      </ActionIcon>
    </Tooltip>
  );
}
