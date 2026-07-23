// Monaco is loaded from a CDN at runtime by @monaco-editor/react's loader, so it
// is NOT bundled into the app — that keeps the Vite build fast and the bundle
// small. We only pin the version here so the log viewer always gets a known-good
// Monaco build. (Needs network on first load, which is fine for this local tool;
// the `monaco-editor` npm package is kept as a devDependency for types only.)
import { loader } from "@monaco-editor/react";

loader.config({
  paths: { vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs" },
});
