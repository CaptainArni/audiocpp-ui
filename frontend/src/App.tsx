import { useCallback, useEffect, useState } from "react";
import { AppShell, Tabs } from "@mantine/core";
import { useDisclosure, useLocalStorage, useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { api } from "./api";
import type { DiscoveredModel, ServerStatus } from "./types";
import { ServerControlBar } from "./components/ServerControlBar";
import { TtsPanel } from "./components/TtsPanel";
import { AsrPanel } from "./components/AsrPanel";
import { CallPanel } from "./components/CallPanel";
import { MusicPanel } from "./components/MusicPanel";
import { VoicesPanel } from "./components/VoicesPanel";
import { LibraryPanel } from "./components/LibraryPanel";
import { OcrPanel } from "./components/OcrPanel";
import { TelemetryPanel } from "./components/TelemetryPanel";
import { AppNav, NAV_ITEMS } from "./components/shell/AppNav";
import { TopBar } from "./components/shell/TopBar";
import { LogDock } from "./components/shell/LogDock";
import { LOG_EDITOR_HEIGHT } from "./components/LogPanel";
import "./components/shell/shell.css";

const NAV_WIDTH = 208;
const NAV_WIDTH_COLLAPSED = 56;
/** Dock bar + the panel's own toolbar and padding around the editor. */
const DOCK_CLOSED = 38;
const DOCK_OPEN = DOCK_CLOSED + LOG_EDITOR_HEIGHT + 42;

export function App() {
  const [models, setModels] = useState<DiscoveredModel[]>([]);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [registeredIds, setRegisteredIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<string>("tts");
  const [logsOpen, { toggle: toggleLogs }] = useDisclosure(false);
  const [navCollapsed, setNavCollapsed] = useLocalStorage({
    key: "audiocpp.navCollapsed",
    defaultValue: false,
  });
  // The same page is occasionally opened from a phone through the tunnel; there
  // the rail collapses itself rather than eating half the width.
  const narrow = useMediaQuery("(max-width: 62em)");
  const collapsed = navCollapsed || !!narrow;

  const loadModels = useCallback(() => {
    api
      .getModels()
      .then(setModels)
      .catch((err) =>
        notifications.show({ color: "red", title: "Model scan failed", message: err.message }),
      );
  }, []);

  useEffect(() => {
    loadModels();
  }, [loadModels]);

  // Poll server status.
  useEffect(() => {
    let alive = true;
    const tick = () =>
      api
        .getStatus()
        .then((s) => alive && setStatus(s))
        .catch(() => {});
    tick();
    const id = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // Refresh the registered-model list when the server becomes running.
  const state = status?.state;
  useEffect(() => {
    if (state === "running") {
      api.getRegistered().then(setRegisteredIds).catch(() => setRegisteredIds([]));
    } else {
      setRegisteredIds([]);
    }
  }, [state]);

  // Ctrl+1…8 walks the rail, Ctrl+` toggles the dock. Both skip text fields, so
  // they can't fire while someone is writing a caption or a set of lyrics.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      if (e.code === "Backquote") {
        e.preventDefault();
        toggleLogs();
        return;
      }
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= NAV_ITEMS.length) {
        e.preventDefault();
        setTab(NAV_ITEMS[n - 1].value);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleLogs]);

  const onStart = useCallback(async (ids: string[]) => {
    setBusy(true);
    try {
      const s = await api.start(ids);
      setStatus(s);
      notifications.show({ color: "violet", message: "Server starting…" });
    } catch (err) {
      notifications.show({ color: "red", title: "Start failed", message: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }, []);

  const onStop = useCallback(async () => {
    setBusy(true);
    try {
      const s = await api.stop();
      setStatus(s);
    } catch (err) {
      notifications.show({ color: "red", title: "Stop failed", message: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }, []);

  const onRescan = useCallback(() => {
    loadModels();
    notifications.show({ color: "gray", message: "Rescanned models folder." });
  }, [loadModels]);

  const running = state === "running";

  return (
    // Tabs wraps the whole shell so that the rail (Tabs.List, in the navbar) and
    // the panels (in main) can be in different regions while staying one Tabs.
    // This is what keeps every panel mounted across navigation — see
    // docs/plan-ui-redesign.md and lib/callSession.ts.
    <Tabs
      value={tab}
      onChange={(v) => v && setTab(v)}
      orientation="vertical"
      className="app-tabs"
    >
      <AppShell
        header={{ height: 48 }}
        navbar={{
          width: collapsed ? NAV_WIDTH_COLLAPSED : NAV_WIDTH,
          // 0, never a breakpoint: the rail narrows to icons on a small screen
          // rather than disappearing, so there is always a way between tabs.
          breakpoint: 0,
        }}
        footer={{ height: logsOpen ? DOCK_OPEN : DOCK_CLOSED }}
        padding="md"
      >
        <AppShell.Header withBorder={false}>
          <TopBar
            status={status}
            navCollapsed={collapsed}
            onToggleNav={() => setNavCollapsed((c) => !c)}
          />
        </AppShell.Header>

        <AppShell.Navbar withBorder={false}>
          <AppNav collapsed={collapsed} />
        </AppShell.Navbar>

        <AppShell.Main>
          <div className="app-content">
            <ServerControlBar
              status={status}
              models={models}
              onStart={onStart}
              onStop={onStop}
              onRescan={onRescan}
              busy={busy}
            />

            <Tabs.Panel value="tts">
              <TtsPanel models={models} registeredIds={registeredIds} serverRunning={running} />
            </Tabs.Panel>
            <Tabs.Panel value="asr">
              <AsrPanel models={models} registeredIds={registeredIds} serverRunning={running} />
            </Tabs.Panel>
            <Tabs.Panel value="call">
              <CallPanel models={models} registeredIds={registeredIds} serverRunning={running} />
            </Tabs.Panel>
            <Tabs.Panel value="music">
              <MusicPanel registeredIds={registeredIds} serverRunning={running} />
            </Tabs.Panel>
            <Tabs.Panel value="voices">
              <VoicesPanel />
            </Tabs.Panel>
            <Tabs.Panel value="library">
              <LibraryPanel models={models} registeredIds={registeredIds} serverRunning={running} />
            </Tabs.Panel>
            <Tabs.Panel value="ocr">
              <OcrPanel />
            </Tabs.Panel>
            <Tabs.Panel value="telemetry">
              <TelemetryPanel />
            </Tabs.Panel>
          </div>
        </AppShell.Main>

        <AppShell.Footer withBorder={false}>
          <LogDock open={logsOpen} onToggle={toggleLogs} />
        </AppShell.Footer>
      </AppShell>
    </Tabs>
  );
}
