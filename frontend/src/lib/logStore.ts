/**
 * The log buffer, owned at module scope.
 *
 * It lives outside React for the same reason `callSession` does: the Monaco
 * viewer must be free to unmount (`Collapse keepMounted={false}` — React 19's
 * <Activity> otherwise disposes the editor and then calls setModel() on the
 * disposed instance), while the dock's collapsed bar still has to show the line
 * count and the newest line. A store the components only subscribe to keeps one
 * EventSource open for the life of the page and lets either half come and go.
 */

export type LogSource = "app" | "server";
export type LogLevel =
  | "debug"
  | "info"
  | "success"
  | "warn"
  | "error"
  | "stdout"
  | "stderr";

export interface LogLine {
  t: number;
  source: LogSource;
  level: LogLevel;
  line: string;
}

const MAX_LINES = 1000;

export interface LogSnapshot {
  lines: LogLine[];
  /** Newest line, or null — what the collapsed dock bar reads out. */
  last: LogLine | null;
}

const EMPTY: LogSnapshot = { lines: [], last: null };

let snapshot: LogSnapshot = EMPTY;
let listeners: (() => void)[] = [];
let source: EventSource | null = null;
let pending: LogLine[] = [];
let frame: number | null = null;

function emit(): void {
  for (const l of listeners) l();
}

function flush(): void {
  frame = null;
  if (pending.length === 0) return;
  const batch = pending;
  pending = [];
  const next = snapshot.lines.concat(batch);
  const lines = next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
  snapshot = { lines, last: lines[lines.length - 1] ?? null };
  emit();
}

function connect(): void {
  if (source) return;
  const es = new EventSource("/api/server/logs");
  es.onmessage = (ev) => {
    try {
      pending.push(JSON.parse(ev.data) as LogLine);
      if (frame === null) frame = requestAnimationFrame(flush);
    } catch {
      /* keep-alive comment */
    }
  };
  source = es;
}

export const logStore = {
  subscribe(listener: () => void): () => void {
    listeners.push(listener);
    // Opened on first interest and then kept — the backend replays its backlog
    // on connect, so reconnecting per mount would only re-deliver what we have.
    connect();
    return () => {
      listeners = listeners.filter((l) => l !== listener);
    };
  },

  getSnapshot(): LogSnapshot {
    return snapshot;
  },

  /** Clears the view only; the backend keeps its own backlog. */
  clear(): void {
    snapshot = EMPTY;
    emit();
  },
};
