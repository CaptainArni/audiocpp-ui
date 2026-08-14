import {
  Accordion,
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Chip,
  type CSSVariablesResolver,
  createTheme,
  Menu,
  Modal,
  MultiSelect,
  NumberInput,
  Paper,
  Select,
  SegmentedControl,
  Slider,
  Switch,
  Table,
  Textarea,
  TextInput,
  Tooltip,
} from "@mantine/core";

/**
 * The Studio console theme.
 *
 * The two accents are the logo's own colours, sampled out of `assets/logo.png`:
 * the speech-bubble outline is violet `#a651de`, the waveform bars inside it are
 * magenta `#ef1ac4`. They are kept to two different jobs on purpose —
 *
 *   violet  = chrome. Selection, focus, primary actions, the active rail item.
 *   magenta = audio.  Playheads, waveforms, recording, "this is rendering".
 *
 * so that "something is live" is legible from across the room instead of being
 * one more purple button among several.
 */

/** Brand violet, hsl(276 68% 59%) at index 6. */
const violet = [
  "#f6edff",
  "#e8d7fc",
  "#d3b3f8",
  "#be8ef3",
  "#ad6fee",
  "#a35ce4",
  "#a651de",
  "#9040c6",
  "#7c33ab",
  "#682a91",
] as const;

/** Brand magenta, hsl(312 87% 52%) at index 6. */
const magenta = [
  "#ffe8fb",
  "#ffcaf3",
  "#fe97e6",
  "#fb62d7",
  "#f836ca",
  "#f533cc",
  "#ef1ac4",
  "#d10fa9",
  "#ad0a8b",
  "#8a076e",
] as const;

/**
 * The surface ramp. Mantine reads specific indices out of `dark`, so this array
 * is not free-form: 0 is body text, 2 is dimmed text, 3 is placeholders, 4 is
 * every default border, 6 is input backgrounds and hover, and **7 becomes
 * `--mantine-color-body`** — which is what every Paper, dropdown and modal
 * paints itself with. The app background is set one step darker than 7 on the
 * `body` element in global.css, which is what gives cards something to sit on.
 */
const dark = [
  "#ebe9f2", // 0  primary text
  "#c8c5d3", // 1
  "#94909f", // 2  dimmed text
  "#6a6675", // 3  placeholders
  "#2a2833", // 4  default border  (hairline)
  "#22212b", // 5
  "#1a1922", // 6  surface-2: inputs, hover, raised rows
  "#121116", // 7  surface-1: cards, dropdowns, modals  → --mantine-color-body
  "#0e0d12", // 8
  "#0a0a0d", // 9  surface-0: the app background itself
] as const;

export const theme = createTheme({
  primaryColor: "violet",
  // Index 6 in both schemes. Mantine's dark default is 8, which would hand the
  // primary button a shade darker than the logo it is meant to echo.
  primaryShade: { light: 6, dark: 6 },
  colors: { violet: [...violet], magenta: [...magenta], dark: [...dark] },

  fontFamily:
    "'Inter Variable', ui-sans-serif, system-ui, 'Segoe UI', Roboto, sans-serif",
  fontFamilyMonospace:
    "'JetBrains Mono Variable', ui-monospace, 'Cascadia Code', Consolas, monospace",
  headings: {
    fontFamily:
      "'Inter Variable', ui-sans-serif, system-ui, 'Segoe UI', Roboto, sans-serif",
    fontWeight: "650",
    sizes: {
      h1: { fontSize: "1.75rem", lineHeight: "1.2" },
      h2: { fontSize: "1.4rem", lineHeight: "1.25" },
      h3: { fontSize: "1.15rem", lineHeight: "1.3" },
      h4: { fontSize: "1.02rem", lineHeight: "1.35" },
      h5: { fontSize: "0.92rem", lineHeight: "1.4" },
      h6: { fontSize: "0.82rem", lineHeight: "1.4" },
    },
  },

  defaultRadius: "md",
  radius: { xs: "4px", sm: "6px", md: "9px", lg: "13px", xl: "20px" },

  components: {
    // Cards sit on the body, so they get the surface tint and a hairline rather
    // than the heavier default border.
    Paper: Paper.extend({ defaultProps: { radius: "lg" } }),
    Card: Card.extend({ defaultProps: { radius: "lg" } }),

    Button: Button.extend({ defaultProps: { radius: "md", fw: 600 } }),
    ActionIcon: ActionIcon.extend({ defaultProps: { radius: "md" } }),

    // Model ids and voice names live in badges; uppercasing them (Mantine's
    // default) makes `Ace-Step1.5@turbo` unreadable.
    Badge: Badge.extend({
      defaultProps: { radius: "sm", tt: "none", fw: 600 },
    }),
    Chip: Chip.extend({ defaultProps: { radius: "sm" } }),

    TextInput: TextInput.extend({ defaultProps: { radius: "md" } }),
    Textarea: Textarea.extend({ defaultProps: { radius: "md" } }),
    NumberInput: NumberInput.extend({ defaultProps: { radius: "md" } }),
    Select: Select.extend({ defaultProps: { radius: "md" } }),
    MultiSelect: MultiSelect.extend({ defaultProps: { radius: "md" } }),
    SegmentedControl: SegmentedControl.extend({ defaultProps: { radius: "md" } }),
    Switch: Switch.extend({ defaultProps: { radius: "xl" } }),
    Slider: Slider.extend({ defaultProps: { radius: "xl" } }),

    Alert: Alert.extend({ defaultProps: { radius: "md", variant: "light" } }),
    Tooltip: Tooltip.extend({
      defaultProps: { radius: "sm", fz: "xs", withArrow: true, openDelay: 250 },
    }),
    Menu: Menu.extend({ defaultProps: { radius: "md", shadow: "xl" } }),
    Modal: Modal.extend({
      defaultProps: { radius: "lg", centered: true, overlayProps: { blur: 3 } },
    }),
    Accordion: Accordion.extend({ defaultProps: { radius: "md" } }),
    Table: Table.extend({ defaultProps: { verticalSpacing: "xs" } }),
  },
});

/**
 * Publishes the surface ramp as plain CSS variables so that hand-written CSS
 * (the rail, the log dock, the player) and the Monaco log theme can read the
 * same values the components do, instead of each re-deciding what "the card
 * colour" is.
 */
export const cssVariablesResolver: CSSVariablesResolver = () => ({
  // Declared scheme-independently: Studio is a dark-only tool (see
  // docs/plan-ui-redesign.md), and putting them here means they resolve even
  // before Mantine has stamped a colour scheme onto the html element.
  variables: {
    "--app-surface-0": dark[9],
    "--app-surface-1": dark[7],
    "--app-surface-2": dark[6],
    "--app-surface-3": dark[5],
    "--app-border": "rgba(255, 255, 255, 0.07)",
    "--app-border-strong": "rgba(255, 255, 255, 0.14)",
    "--app-accent": violet[6],
    "--app-accent-soft": "rgba(166, 81, 222, 0.16)",
    "--app-audio": magenta[6],
    "--app-audio-soft": "rgba(239, 26, 196, 0.16)",
    // The unplayed half of a waveform. Deliberately lighter than any surface in
    // the ramp: at 28px tall most bars are only a few pixels, so a colour that
    // merely differs from the card is not a colour you can see.
    "--app-wave": "#413e50",
    "--app-shadow-card": "0 1px 2px rgba(0, 0, 0, 0.4)",
    "--app-shadow-pop": "0 12px 32px -8px rgba(0, 0, 0, 0.7)",
    // Motion. Everything that animates uses one of these two, so a single
    // reduced-motion rule in global.css can neutralise the lot.
    "--app-fast": "120ms",
    "--app-slow": "180ms",
    "--app-ease": "cubic-bezier(0.2, 0, 0, 1)",
  },
  light: {},
  dark: {},
});
