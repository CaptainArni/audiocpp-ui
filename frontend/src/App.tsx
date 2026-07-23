import { useCallback, useEffect, useState } from "react";
import {
  ActionIcon,
  AppShell,
  Badge,
  Collapse,
  Container,
  Group,
  Paper,
  Stack,
  Tabs,
  Text,
  Title,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
  IconActivity,
  IconBooks,
  IconChevronDown,
  IconChevronUp,
  IconMicrophone,
  IconScan,
  IconUsers,
  IconWaveSine,
} from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { api } from "./api";
import type { DiscoveredModel, ServerRunState, ServerStatus } from "./types";
import { ServerControlBar } from "./components/ServerControlBar";
import { TtsPanel } from "./components/TtsPanel";
import { AsrPanel } from "./components/AsrPanel";
import { VoicesPanel } from "./components/VoicesPanel";
import { LibraryPanel } from "./components/LibraryPanel";
import { OcrPanel } from "./components/OcrPanel";
import { TelemetryPanel } from "./components/TelemetryPanel";
import { LogPanel } from "./components/LogPanel";
import logo from "./assets/logo.png";

const STATE_COLOR: Record<ServerRunState, string> = {
  stopped: "gray",
  starting: "yellow",
  running: "green",
  error: "red",
};

export function App() {
  const [models, setModels] = useState<DiscoveredModel[]>([]);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [registeredIds, setRegisteredIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [logsOpen, { toggle: toggleLogs }] = useDisclosure(true);

  const loadModels = useCallback(() => {
    api
      .getModels()
      .then(setModels)
      .catch((err) => notifications.show({ color: "red", title: "Model scan failed", message: err.message }));
  }, []);

  useEffect(() => {
    loadModels();
  }, [loadModels]);

  // Poll server status.
  useEffect(() => {
    let alive = true;
    const tick = () => api.getStatus().then((s) => alive && setStatus(s)).catch(() => {});
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

  const onStart = useCallback(async (ids: string[]) => {
    setBusy(true);
    try {
      const s = await api.start(ids);
      setStatus(s);
      notifications.show({ color: "blue", message: "Server starting…" });
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
    <AppShell header={{ height: 60 }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group gap="sm">
            <img src={logo} alt="" height={34} style={{ display: "block" }} />
            <Title order={4}>audio.cpp Studio</Title>
            <Text size="sm" c="dimmed">
              local TTS · voice cloning · ASR
            </Text>
          </Group>
          <Badge color={STATE_COLOR[state ?? "stopped"]} variant={running ? "filled" : "light"} size="lg">
            server: {state ?? "…"}
          </Badge>
        </Group>
      </AppShell.Header>

      <AppShell.Main>
        <Container size="lg" px={0}>
          <Stack gap="lg">
            <ServerControlBar
              status={status}
              models={models}
              onStart={onStart}
              onStop={onStop}
              onRescan={onRescan}
              busy={busy}
            />

            <Tabs defaultValue="tts">
              <Tabs.List>
                <Tabs.Tab value="tts" leftSection={<IconWaveSine size={16} />}>
                  Text to Speech
                </Tabs.Tab>
                <Tabs.Tab value="asr" leftSection={<IconMicrophone size={16} />}>
                  Transcribe
                </Tabs.Tab>
                <Tabs.Tab value="voices" leftSection={<IconUsers size={16} />}>
                  Saved Voices
                </Tabs.Tab>
                <Tabs.Tab value="library" leftSection={<IconBooks size={16} />}>
                  Library
                </Tabs.Tab>
                <Tabs.Tab value="ocr" leftSection={<IconScan size={16} />}>
                  OCR
                </Tabs.Tab>
                <Tabs.Tab value="telemetry" leftSection={<IconActivity size={16} />}>
                  Telemetry
                </Tabs.Tab>
              </Tabs.List>

              <Tabs.Panel value="tts" pt="md">
                <TtsPanel models={models} registeredIds={registeredIds} serverRunning={running} />
              </Tabs.Panel>
              <Tabs.Panel value="asr" pt="md">
                <AsrPanel models={models} registeredIds={registeredIds} serverRunning={running} />
              </Tabs.Panel>
              <Tabs.Panel value="voices" pt="md">
                <VoicesPanel />
              </Tabs.Panel>
              <Tabs.Panel value="library" pt="md">
                <LibraryPanel models={models} registeredIds={registeredIds} serverRunning={running} />
              </Tabs.Panel>
              <Tabs.Panel value="ocr" pt="md">
                <OcrPanel />
              </Tabs.Panel>
              <Tabs.Panel value="telemetry" pt="md">
                <TelemetryPanel />
              </Tabs.Panel>
            </Tabs>

            <Paper withBorder p="md" radius="md">
              <Group justify="space-between">
                <Text size="sm" fw={500}>
                  Logs
                </Text>
                <ActionIcon variant="subtle" onClick={toggleLogs}>
                  {logsOpen ? <IconChevronUp size={18} /> : <IconChevronDown size={18} />}
                </ActionIcon>
              </Group>
              <Collapse expanded={logsOpen}>
                <LogPanel />
              </Collapse>
            </Paper>
          </Stack>
        </Container>
      </AppShell.Main>
    </AppShell>
  );
}
