// Orvix terminal design system. Existing keys keep their names so every
// component that already references theme.X gets the richer palette for
// free; new keys support the redesigned launch/cockpit chrome.
export const theme = {
  // Brand (Orvix primary — warm signal color, used for identity and focus)
  accent: "#e0793f",
  accentDim: "#8a5a3c",
  accentBright: "#ffb27a",

  // Cloud/Qwen accent — marks anything that is a real live Qwen call or
  // cloud-backed state, kept visually distinct from local/static chrome.
  cloud: "#7aa2f7",
  cloudDim: "#41537a",

  // Text hierarchy
  text: "#f4f4f4",
  muted: "#8a8a8a",
  faint: "#4a4a4a",

  // Status semantics
  success: "#5fd97a",
  warning: "#f5c451",
  danger: "#f2555a",

  // Chrome
  border: "#3a3a3a",
  borderActive: "#e0793f"
} as const;

export const glyphs = {
  done: "✓",
  active: "◐",
  blocked: "✗",
  queued: "○",
  degraded: "!",
  chevron: "›",
  arrow: "→",
  dot: "•",
  ring: "◆"
} as const;
