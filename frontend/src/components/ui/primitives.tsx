import type { ReactNode } from "react";
import { Text } from "@mantine/core";
import "./ui.css";

/**
 * The four pieces every panel is built out of. They exist so that "a card with
 * a heading" is one decision made once, rather than eight panels each spelling
 * out a Paper, a Title and a Group in slightly different ways.
 */

export type DotTone = "ok" | "busy" | "warn" | "error" | "idle" | "audio";

const DOT_COLOR: Record<DotTone, string> = {
  ok: "var(--mantine-color-teal-5)",
  busy: "var(--mantine-color-yellow-5)",
  warn: "var(--mantine-color-orange-5)",
  error: "var(--mantine-color-red-5)",
  idle: "var(--app-surface-3)",
  audio: "var(--app-audio)",
};

/** A state light. `pulse` is for states that are actually in motion. */
export function StatusDot({ tone, pulse }: { tone: DotTone; pulse?: boolean }) {
  return (
    <span
      className="app-dot"
      data-pulse={pulse || undefined}
      style={{ ["--dot-color" as string]: DOT_COLOR[tone] }}
    />
  );
}

/** A run of mono key/value facts, dot-separated. Values only, or `label` + value. */
export function Meta({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`app-meta${className ? ` ${className}` : ""}`}>{children}</div>;
}

export function MetaItem({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <span className="app-meta-item">
      {label ? `${label} ` : ""}
      <b>{children}</b>
    </span>
  );
}

interface SectionCardProps {
  title?: string;
  icon?: ReactNode;
  /** Right-aligned controls in the card header. */
  actions?: ReactNode;
  /** Drop the body padding — for cards whose body is its own scroller or table. */
  flush?: boolean;
  className?: string;
  style?: React.CSSProperties;
  children: ReactNode;
}

/** A titled surface. One border, one radius, one header rhythm, everywhere. */
export function SectionCard({
  title,
  icon,
  actions,
  flush,
  className,
  style,
  children,
}: SectionCardProps) {
  return (
    <div className={`app-card${className ? ` ${className}` : ""}`} style={style}>
      {(title || actions) && (
        <div className="app-card-head">
          {icon && <span className="app-card-head-icon">{icon}</span>}
          {title && <span className="app-card-title">{title}</span>}
          {actions && <span className="app-card-actions">{actions}</span>}
        </div>
      )}
      <div className="app-card-body" data-flush={flush || undefined}>
        {children}
      </div>
    </div>
  );
}

/**
 * What a panel shows when it has nothing to show. Every panel gets one — a
 * stopped server used to produce nothing but greyed-out buttons, which says
 * "broken" rather than "press Start".
 */
export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon?: ReactNode;
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="app-empty">
      {icon && <span className="app-empty-icon">{icon}</span>}
      <Text size="sm" fw={600} c="dark.1">
        {title}
      </Text>
      {hint && (
        <Text size="xs" c="dimmed" maw={420}>
          {hint}
        </Text>
      )}
      {action}
    </div>
  );
}
