import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActionIcon, Box, Group, Text, Tooltip } from "@mantine/core";
import {
  IconArrowBarToDown,
  IconBug,
  IconCopy,
  IconTextWrap,
  IconTrash,
} from "@tabler/icons-react";
import Editor, { type BeforeMount, type OnMount } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import "../lib/monaco"; // side-effect: point Monaco's loader at the CDN
import { LOG_LANGUAGE_ID, LOG_THEME, registerLogLanguage } from "../lib/logLanguage";
import { logStore, type LogLevel, type LogLine, type LogSource } from "../lib/logStore";
import "./LogPanel.css";

const SOURCE_TAG: Record<LogSource, string> = { app: "app", server: "srv" };
// Levels that get a coloured left bar / a tinted background in the gutter.
const BAR_LEVELS = new Set<LogLevel>(["info", "stderr", "warn", "error", "success"]);
const BG_LEVELS = new Set<LogLevel>(["error", "warn"]);

/** Editor height. The dock's footer height in App.tsx is derived from this. */
export const LOG_EDITOR_HEIGHT = 300;

function timeStr(t: number): string {
  const d = new Date(t);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function formatLine(l: LogLine): string {
  return `${timeStr(l.t)} ${SOURCE_TAG[l.source].padEnd(3)}  ${l.line}`;
}

export function LogPanel() {
  // The lines live in a module-scope store, so this component is free to unmount
  // with the dock (which Monaco requires) without dropping the stream.
  const snap = useSyncExternalStore(logStore.subscribe, logStore.getSnapshot);
  const [autoScroll, setAutoScroll] = useState(true);
  const [wrap, setWrap] = useState(true);
  const [showDebug, setShowDebug] = useState(true);
  const [ready, setReady] = useState(false);

  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const decoRef = useRef<string[]>([]);

  const lines = snap.lines;
  const visible = useMemo(
    () => (showDebug ? lines : lines.filter((l) => l.level !== "debug")),
    [lines, showDebug],
  );

  const options = useMemo<Monaco.editor.IStandaloneEditorConstructionOptions>(
    () => ({
      readOnly: true,
      domReadOnly: true,
      minimap: { enabled: false },
      lineNumbers: "off",
      wordWrap: wrap ? "on" : "off",
      scrollBeyondLastLine: false,
      automaticLayout: true,
      fontSize: 12,
      fontFamily: "'JetBrains Mono Variable', 'Cascadia Code', Consolas, monospace",
      renderLineHighlight: "none",
      folding: false,
      glyphMargin: false,
      lineDecorationsWidth: 6,
      lineNumbersMinChars: 0,
      overviewRulerLanes: 0,
      overviewRulerBorder: false,
      scrollbar: { alwaysConsumeMouseWheel: false },
      contextmenu: false,
      guides: { indentation: false },
      renderWhitespace: "none",
      stickyScroll: { enabled: false },
    }),
    [wrap],
  );

  const beforeMount: BeforeMount = (m) => registerLogLanguage(m);

  const onMount: OnMount = (editor, m) => {
    editorRef.current = editor;
    monacoRef.current = m;
    // Auto-pause following when the user scrolls up; resume when back at bottom.
    editor.onDidScrollChange(() => {
      const bottom = editor.getScrollHeight() - editor.getLayoutInfo().height;
      setAutoScroll(editor.getScrollTop() >= bottom - 4);
    });
    setReady(true);
  };

  // Reflect the visible lines into the editor and mark levels via gutter bars /
  // background tints (token colours come from the Monarch language).
  useEffect(() => {
    const editor = editorRef.current;
    const m = monacoRef.current;
    if (!editor || !m) return;
    const model = editor.getModel();
    if (!model) return;

    model.setValue(visible.map(formatLine).join("\n"));

    const decos: Monaco.editor.IModelDeltaDecoration[] = [];
    visible.forEach((l, i) => {
      const ln = i + 1;
      if (BAR_LEVELS.has(l.level)) {
        decos.push({
          range: new m.Range(ln, 1, ln, 1),
          options: { isWholeLine: true, linesDecorationsClassName: `logbar-${l.level}` },
        });
      }
      if (BG_LEVELS.has(l.level)) {
        decos.push({
          range: new m.Range(ln, 1, ln, 1),
          options: { isWholeLine: true, className: `logline-${l.level}` },
        });
      }
    });
    decoRef.current = editor.deltaDecorations(decoRef.current, decos);

    if (autoScroll) editor.revealLine(model.getLineCount());
  }, [visible, ready, autoScroll]);

  const copyAll = useCallback(() => {
    void navigator.clipboard?.writeText(visible.map(formatLine).join("\n"));
  }, [visible]);

  return (
    <Box>
      <Group justify="space-between" mb={6}>
        {/* The line count lives on the dock bar above; repeating it here just
            prints the same number twice. What is worth saying is when the view
            is filtered, because then the count up there no longer matches. */}
        <Text size="xs" c="dimmed">
          {!showDebug && lines.length !== visible.length
            ? `${lines.length - visible.length} debug line${
                lines.length - visible.length === 1 ? "" : "s"
              } hidden`
            : ""}
        </Text>
        <Group gap={4}>
          <Tooltip label={showDebug ? "Hide debug lines" : "Show debug lines"}>
            <ActionIcon
              size="sm"
              variant={showDebug ? "light" : "subtle"}
              color="gray"
              onClick={() => setShowDebug((v) => !v)}
            >
              <IconBug size={15} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={wrap ? "Disable word wrap" : "Enable word wrap"}>
            <ActionIcon
              size="sm"
              variant={wrap ? "light" : "subtle"}
              color="gray"
              onClick={() => setWrap((v) => !v)}
            >
              <IconTextWrap size={15} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={autoScroll ? "Auto-scroll on" : "Auto-scroll off"}>
            <ActionIcon
              size="sm"
              variant={autoScroll ? "light" : "subtle"}
              color="gray"
              onClick={() => setAutoScroll((v) => !v)}
            >
              <IconArrowBarToDown size={15} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Copy logs">
            <ActionIcon
              size="sm"
              variant="subtle"
              color="gray"
              onClick={copyAll}
              disabled={visible.length === 0}
            >
              <IconCopy size={15} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Clear view">
            <ActionIcon
              size="sm"
              variant="subtle"
              color="gray"
              onClick={() => logStore.clear()}
              disabled={lines.length === 0}
            >
              <IconTrash size={15} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>

      <Box
        pos="relative"
        style={{
          height: LOG_EDITOR_HEIGHT,
          borderRadius: "var(--mantine-radius-md)",
          overflow: "hidden",
          border: "1px solid var(--app-border)",
          background: "var(--app-surface-1)",
        }}
      >
        <Editor
          theme={LOG_THEME}
          defaultLanguage={LOG_LANGUAGE_ID}
          beforeMount={beforeMount}
          onMount={onMount}
          options={options}
          height="100%"
          width="100%"
          loading={
            <Text size="sm" c="dimmed">
              Loading log viewer…
            </Text>
          }
        />
        {visible.length === 0 && (
          <Text
            size="sm"
            c="dimmed"
            pos="absolute"
            style={{ top: 10, left: 12, pointerEvents: "none" }}
          >
            Logs from the app and the audiocpp_server process will appear here.
          </Text>
        )}
      </Box>
    </Box>
  );
}
