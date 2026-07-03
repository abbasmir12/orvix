// Shared fixed-height scroll window + terminal mouse hit-testing helpers.
// Used by MissionCockpit's activity/inspector panels and PlanningConsole's
// broadcast/book/trace panels so both screens scroll the same way.

export function bottomWindow<T>(items: T[], visibleRows: number, scrollOffset: number) {
  const rows = Math.max(1, visibleRows);
  const maxStart = Math.max(0, items.length - rows);
  const start = Math.max(0, maxStart - Math.max(0, scrollOffset));
  return {
    visible: items.slice(start, start + rows),
    start,
    total: items.length,
    maxOffset: maxStart
  };
}

export function scrollbarGlyph(row: number, rows: number, total: number, start: number) {
  if (total <= rows) return " ";
  const maxStart = Math.max(1, total - rows);
  const thumbSize = Math.max(1, Math.floor((rows / total) * rows));
  const thumbTop = Math.round((start / maxStart) * Math.max(0, rows - thumbSize));
  return row >= thumbTop && row < thumbTop + thumbSize ? "█" : "│";
}

export type Rect = { x0: number; y0: number; x1: number; y1: number };

export function pointInRect(x: number, y: number, rect: Rect) {
  return x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1;
}

/** First region (in insertion order) whose rect contains (x, y), or null. */
export function hitTestRegions<K extends string>(x: number, y: number, regions: Partial<Record<K, Rect>>): K | null {
  for (const key of Object.keys(regions) as K[]) {
    const rect = regions[key];
    if (rect && pointInRect(x, y, rect)) return key;
  }
  return null;
}

export type MouseEvent =
  | { kind: "wheel"; delta: number; x: number; y: number }
  | { kind: "move"; x: number; y: number };

/**
 * Parses SGR mouse sequences (`\x1b[<Cb;Cx;CyM/m`). Requires alt-screen mode
 * (see enableAltScreen) so (x, y) are absolute coordinates matching a
 * from-scratch-rendered frame, not offsets into scrollback.
 */
export function parseMouseEvents(input: string): MouseEvent[] {
  const events: MouseEvent[] = [];
  const sgrPattern = /\[<(\d+);(\d+);(\d+)([mM])/g;
  for (const match of input.matchAll(sgrPattern)) {
    const button = Number(match[1]);
    const x = Number(match[2]);
    const y = Number(match[3]);
    if (button === 64) events.push({ kind: "wheel", delta: 3, x, y });
    else if (button === 65) events.push({ kind: "wheel", delta: -3, x, y });
    else if (button === 35) events.push({ kind: "move", x, y });
  }
  return events;
}

export const enableAltScreenAndMouse = "[?1049h[?1000h[?1003h[?1006h";
export const disableAltScreenAndMouse = "[?1000l[?1003l[?1006l[?1049l";
