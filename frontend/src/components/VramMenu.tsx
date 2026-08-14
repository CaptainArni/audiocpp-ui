import { useCallback, useEffect, useState } from "react";
import { Button, Menu, Text } from "@mantine/core";
import { IconChevronDown, IconFlame } from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { api } from "../api";
import type { VramStatus, VramTarget } from "../types";

/**
 * Free GPU memory on either inference server, from anywhere in the app.
 *
 * It lives in the header rather than on the Telemetry tab because the workflow
 * it exists for spans tabs: free the audio models, write a music prompt with a
 * big chat model, free *that*, then generate. Walking to another tab twice in
 * the middle of that is the whole friction.
 *
 * Entries appear only for a server that is actually holding something, so the
 * control is a truthful readout as well as a button — and it disappears
 * entirely when the GPU is already clear, instead of offering a no-op.
 */

const LABELS: Record<VramTarget, string> = {
  audiocpp: "audio.cpp",
  llama: "llama.cpp",
};

// Slower than the 2s server-status poll: this reaches a second, external
// process, and residency changes on the scale of a generation, not a tick.
const POLL_MS = 5000;

export function VramMenu() {
  const [status, setStatus] = useState<VramStatus | null>(null);
  const [busy, setBusy] = useState<VramTarget | "all" | null>(null);

  const refresh = useCallback(
    () => api.getVram().then(setStatus).catch(() => setStatus(null)),
    [],
  );

  useEffect(() => {
    let alive = true;
    const tick = () => {
      void api
        .getVram()
        .then((s) => alive && setStatus(s))
        .catch(() => alive && setStatus(null));
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const holders = (["audiocpp", "llama"] as VramTarget[]).filter(
    (t) => (status?.[t].loaded.length ?? 0) > 0,
  );
  const total = holders.reduce((n, t) => n + (status?.[t].loaded.length ?? 0), 0);

  async function free(targets: VramTarget[], key: VramTarget | "all") {
    setBusy(key);
    try {
      const { freed } = await api.freeVram(targets);
      const names = Object.values(freed).flat();
      notifications.show({
        color: names.length ? "teal" : "gray",
        message: names.length
          ? `Freed ${names.length} model${names.length === 1 ? "" : "s"}: ${names.join(", ")}`
          : "Nothing was loaded.",
      });
      await refresh();
    } catch (err) {
      notifications.show({
        color: "red",
        title: "Free VRAM failed",
        message: (err as Error).message,
      });
    } finally {
      setBusy(null);
    }
  }

  // Nothing resident anywhere — a button here could only do nothing.
  if (holders.length === 0) return null;

  return (
    <Menu position="bottom-end" width={280} withArrow>
      <Menu.Target>
        <Button
          variant="light"
          color="orange"
          size="compact-sm"
          leftSection={<IconFlame size={16} />}
          rightSection={<IconChevronDown size={14} />}
          loading={busy !== null}
        >
          Free VRAM · {total}
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Loaded models</Menu.Label>
        {holders.map((target) => (
          <Menu.Item key={target} onClick={() => free([target], target)}>
            <Text size="sm" fw={500}>
              {LABELS[target]} · {status![target].loaded.length}
            </Text>
            <Text size="xs" c="dimmed" lineClamp={2}>
              {status![target].loaded.join(", ")}
            </Text>
          </Menu.Item>
        ))}
        {holders.length > 1 && (
          <>
            <Menu.Divider />
            <Menu.Item onClick={() => free(holders, "all")}>
              <Text size="sm" fw={500}>
                Both
              </Text>
            </Menu.Item>
          </>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
