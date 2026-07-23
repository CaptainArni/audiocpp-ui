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

  m.editor.defineTheme(LOG_THEME, {
    base: "vs-dark",
    inherit: true,
    colors: {
      "editor.background": "#0d0e11",
      "editorGutter.background": "#0d0e11",
      "editorLineNumber.foreground": "#30363d",
    },
    rules: [
      { token: "logTime", foreground: "6e7681" },
      { token: "logSource", foreground: "8b949e", fontStyle: "italic" },
      { token: "logArrow", foreground: "d2a8ff" },
      { token: "logMethod", foreground: "d2a8ff", fontStyle: "bold" },
      { token: "logPath", foreground: "79c0ff" },
      { token: "logString", foreground: "a5d6ff" },
      { token: "logNum", foreground: "f2cc60" },
      { token: "logOk", foreground: "7ee787" },
      { token: "logBad", foreground: "ff7b72", fontStyle: "bold" },
      { token: "logErrorKw", foreground: "ff7b72", fontStyle: "bold" },
      { token: "logWarnKw", foreground: "e3b341" },
      { token: "logOkKw", foreground: "7ee787" },
      { token: "logKey", foreground: "ffa657" },
      { token: "logSep", foreground: "484f58" },
    ],
  });
}
