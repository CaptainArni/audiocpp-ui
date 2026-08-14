// Syntax highlighting for the log viewer.
//
// Registers a small Monarch language ("audiocpp-log") plus a matching dark
// theme. The tokenizer runs statelessly per line (single `root` state, no
// transitions) so every line — including the replayed backlog — highlights
// consistently regardless of what preceded it.
import type * as Monaco from "monaco-editor";

export const LOG_LANGUAGE_ID = "audiocpp-log";
export const LOG_THEME = "audiocpp-logs";

export function registerLogLanguage(m: typeof Monaco): void {
  // Registering twice (e.g. StrictMode double-invoke) is harmless.
  if (!m.languages.getLanguages().some((l) => l.id === LOG_LANGUAGE_ID)) {
    m.languages.register({ id: LOG_LANGUAGE_ID });
  }

  m.languages.setMonarchTokensProvider(LOG_LANGUAGE_ID, {
    ignoreCase: true,
    defaultToken: "",
    tokenizer: {
      root: [
        // Leading "HH:MM:SS.mmm" timestamp (dimmed).
        [/\d{2}:\d{2}:\d{2}\.\d{3}/, "logTime"],
        // Request/response direction arrows.
        [/[←→]/, "logArrow"],
        // HTTP verbs / protocol.
        [/\b(?:POST|GET|DELETE|PUT|PATCH|HTTP)\b/, "logMethod"],
        // Quantities with units come before bare status codes so "512 KB" isn't
        // mistaken for a 5xx status.
        [/\b\d+(?:\.\d+)?\s?(?:ms|kb|mb|gb|bytes?|chars?|s)\b/, "logNum"],
        // HTTP status codes.
        [/\b[45]\d{2}\b/, "logBad"],
        [/\b[23]\d{2}\b/, "logOk"],
        // Remaining numbers (pids, counts, device ids…).
        [/\b\d+(?:\.\d+)?\b/, "logNum"],
        // URL-ish paths: /api/tts, /v1/audio/speech, file paths.
        [/[A-Za-z]?:?\/[A-Za-z0-9_./\\-]+/, "logPath"],
        // Quoted strings.
        [/"([^"\\]|\\.)*"/, "logString"],
        // Outcome keywords.
        [/\b(?:error|errors|failed|failure|exception|rejected|unhandled|timed\s+out|not\s+found)\b/, "logErrorKw"],
        [/\b(?:warn|warning)\b/, "logWarnKw"],
        [/\b(?:healthy|ready|done|success|registered|saved|cleared|starting|started|stopping|stopped|running|spawned)\b/, "logOkKw"],
        // key=value keys and the middle-dot separators used in summaries.
        [/[A-Za-z_][\w-]*(?==)/, "logKey"],
        [/·/, "logSep"],
        // Source tags.
        [/\b(?:app|srv)\b/, "logSource"],
      ],
    },
  } as Monaco.languages.IMonarchLanguage);

  // Painted from the same surface ramp as the rest of the app (theme.ts's
  // `dark` array). The editor used to carry its own near-black and read as a
  // foreign window pasted into the page; matching --app-surface-1 makes the
  // dock look like part of the dock. Level colours are deliberately left as
  // they are — in a log, red and amber carry meaning, not styling.
  m.editor.defineTheme(LOG_THEME, {
    base: "vs-dark",
    inherit: true,
    colors: {
      "editor.background": "#121116",
      "editorGutter.background": "#121116",
      "editorLineNumber.foreground": "#2a2833",
      "editor.selectionBackground": "#a651de40",
      "editor.lineHighlightBorder": "#00000000",
      "scrollbarSlider.background": "#22212b99",
      "scrollbarSlider.hoverBackground": "#2a2833cc",
      "scrollbarSlider.activeBackground": "#35333f",
    },
    rules: [
      { token: "logTime", foreground: "6a6675" },
      { token: "logSource", foreground: "94909f", fontStyle: "italic" },
      // The brand violet, for the request arrows and verbs — the chrome accent
      // doing chrome work inside the log too.
      { token: "logArrow", foreground: "c295f0" },
      { token: "logMethod", foreground: "c295f0", fontStyle: "bold" },
      { token: "logPath", foreground: "79c0ff" },
      { token: "logString", foreground: "a5d6ff" },
      { token: "logNum", foreground: "f2cc60" },
      { token: "logOk", foreground: "7ee787" },
      { token: "logBad", foreground: "ff7b72", fontStyle: "bold" },
      { token: "logErrorKw", foreground: "ff7b72", fontStyle: "bold" },
      { token: "logWarnKw", foreground: "e3b341" },
      { token: "logOkKw", foreground: "7ee787" },
      { token: "logKey", foreground: "ffa657" },
      { token: "logSep", foreground: "3a3745" },
    ],
  });
}
