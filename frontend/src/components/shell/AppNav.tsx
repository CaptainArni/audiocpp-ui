import { Tabs, Tooltip } from "@mantine/core";
import {
  IconActivity,
  IconBooks,
  IconMicrophone,
  IconMusic,
  IconPhone,
  IconScan,
  IconUsers,
  IconWaveSine,
  type IconProps,
} from "@tabler/icons-react";
import type { ComponentType } from "react";
import "./shell.css";

export interface NavItem {
  value: string;
  label: string;
  Icon: ComponentType<IconProps>;
}

/**
 * The eight panels, grouped by what you came here to do. Eight flat items is a
 * list you read every time; three groups of two-to-four is one you learn.
 */
export const NAV_GROUPS: { group: string; items: NavItem[] }[] = [
  {
    group: "Generate",
    items: [
      { value: "tts", label: "Text to Speech", Icon: IconWaveSine },
      { value: "music", label: "Music", Icon: IconMusic },
    ],
  },
  {
    group: "Listen",
    items: [
      { value: "asr", label: "Transcribe", Icon: IconMicrophone },
      { value: "call", label: "Call", Icon: IconPhone },
    ],
  },
  {
    group: "Manage",
    items: [
      { value: "voices", label: "Saved Voices", Icon: IconUsers },
      { value: "library", label: "Library", Icon: IconBooks },
      { value: "ocr", label: "OCR", Icon: IconScan },
      { value: "telemetry", label: "Telemetry", Icon: IconActivity },
    ],
  },
];

/** Flat order, so Ctrl+1…8 lines up with what the eye sees. */
export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/**
 * The rail is `Tabs.List`, relocated into the navbar and restyled — not a
 * hand-rolled nav. Mantine's Tabs is only context, so the list and the panels do
 * not have to be siblings, and keeping it means mount behaviour is byte for byte
 * what it was: panels stay mounted under React 19's <Activity>, and a glance at
 * another tab does not tear down the running call.
 */
export function AppNav({ collapsed }: { collapsed: boolean }) {
  return (
    <nav className="app-nav" data-collapsed={collapsed || undefined}>
      <Tabs.List>
        {NAV_GROUPS.map(({ group, items }) => (
          <div key={group} style={{ display: "contents" }}>
            <div className="app-nav-group" aria-hidden>
              {group}
            </div>
            {items.map(({ value, label, Icon }) => {
              const tab = (
                <Tabs.Tab
                  key={value}
                  value={value}
                  leftSection={
                    <span className="app-nav-icon">
                      <Icon size={17} stroke={1.7} />
                    </span>
                  }
                >
                  {!collapsed && <span className="app-nav-label">{label}</span>}
                </Tabs.Tab>
              );
              // Collapsed to icons, the label has to live somewhere.
              return collapsed ? (
                <Tooltip key={value} label={label} position="right">
                  {tab}
                </Tooltip>
              ) : (
                tab
              );
            })}
          </div>
        ))}
      </Tabs.List>
    </nav>
  );
}
