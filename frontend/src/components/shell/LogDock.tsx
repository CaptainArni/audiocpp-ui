import { useSyncExternalStore } from "react";
import { ActionIcon, Collapse, Kbd, Text, Tooltip } from "@mantine/core";
import { IconChevronDown, IconChevronUp, IconTerminal2 } from "@tabler/icons-react";
import { logStore } from "../../lib/logStore";
import { LogPanel } from "../LogPanel";
import "./shell.css";

/**
 * The log viewer's home: a dock at the foot of the window, shut by default.
 *
 * It used to be an always-expanded slab that owned the bottom third of the page.
 * Collapsed, the bar still earns its 37px — it carries the line count and the
 * newest line, colour-coded by level, so closing the logs is not the same as
 * going blind. That readout comes from `logStore`, which holds the stream open
 * whether or not the Monaco editor below is mounted.
 */
export function LogDock({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const snap = useSyncExternalStore(logStore.subscribe, logStore.getSnapshot);
  const count = snap.lines.length;

  return (
    <div className="app-dock">
      <div className="app-dock-bar">
        <button
          type="button"
          className="app-dock-toggle"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={open ? "Collapse logs" : "Expand logs"}
        >
          <IconTerminal2 size={15} />
          <span style={{ flex: "none", fontWeight: 600 }}>Logs</span>
          <span style={{ flex: "none", opacity: 0.6 }}>
            {count} line{count === 1 ? "" : "s"}
          </span>
          {!open && snap.last && (
            <span className="app-dock-tail" data-level={snap.last.level}>
              {snap.last.line}
            </span>
          )}
        </button>

        <Tooltip
          label={
            <Text size="xs" component="span">
              Toggle logs <Kbd size="xs">Ctrl</Kbd> + <Kbd size="xs">`</Kbd>
            </Text>
          }
        >
          <ActionIcon variant="subtle" color="gray" size="sm" onClick={onToggle}>
            {open ? <IconChevronDown size={16} /> : <IconChevronUp size={16} />}
          </ActionIcon>
        </Tooltip>
      </div>

      {/* keepMounted={false} is required, and always was: Mantine's default
          hides the collapsed subtree with React 19's <Activity>, which tears
          down and re-runs effects while keeping refs and state. That makes
          @monaco-editor/react dispose its editor on collapse and then call
          setModel() on the disposed instance on expand ("InstantiationService
          has been disposed"). A real unmount is free here now — the lines live
          in logStore, not in the panel. */}
      <Collapse expanded={open} keepMounted={false} className="app-dock-body">
        <LogPanel />
      </Collapse>
    </div>
  );
}
