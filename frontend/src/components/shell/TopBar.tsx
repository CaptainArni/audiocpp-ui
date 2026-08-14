import { ActionIcon, Text, Tooltip } from "@mantine/core";
import { IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand } from "@tabler/icons-react";
import type { ServerRunState, ServerStatus } from "../../types";
import { Meta, MetaItem, StatusDot, type DotTone } from "../ui/primitives";
import { VramMenu } from "../VramMenu";
import logo from "../../assets/logo.png";
import "./shell.css";

const TONE: Record<ServerRunState, DotTone> = {
  stopped: "idle",
  starting: "busy",
  running: "ok",
  error: "error",
};

interface Props {
  status: ServerStatus | null;
  navCollapsed: boolean;
  onToggleNav: () => void;
}

/**
 * Identity on the left, the one fact that matters on the right.
 *
 * The old header carried a `SERVER: RUNNING` badge that repeated the badge in
 * the control bar 40px below it. Here the state is a dot, and the space that
 * frees goes to the connection facts — which used to be buried in the card.
 */
export function TopBar({ status, navCollapsed, onToggleNav }: Props) {
  const state = status?.state ?? "stopped";
  const live = state === "running" || state === "starting";

  return (
    <div className="app-topbar">
      <Tooltip label={navCollapsed ? "Expand sidebar" : "Collapse sidebar"}>
        <ActionIcon variant="subtle" color="gray" onClick={onToggleNav} aria-label="Toggle sidebar">
          {navCollapsed ? (
            <IconLayoutSidebarLeftExpand size={18} />
          ) : (
            <IconLayoutSidebarLeftCollapse size={18} />
          )}
        </ActionIcon>
      </Tooltip>

      <div className="app-brand">
        <img src={logo} alt="" />
        <span className="app-brand-name">audio.cpp Studio</span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <StatusDot tone={TONE[state]} pulse={state === "starting"} />
        <Text size="xs" fw={600} c={state === "running" ? "teal.4" : "dimmed"}>
          {state}
        </Text>
        {live && status && (
          <Meta>
            <MetaItem>
              {status.host}:{status.port}
            </MetaItem>
            <MetaItem label="device">{status.device}</MetaItem>
            {status.pid ? <MetaItem label="pid">{status.pid}</MetaItem> : null}
            {state === "running" ? (
              <MetaItem label="slots">{status.healthModels}</MetaItem>
            ) : null}
          </Meta>
        )}
      </div>

      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
        <VramMenu />
      </div>
    </div>
  );
}
