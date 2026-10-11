import type { CSSProperties } from "react";

// Person colours. Everyone has their own: no two people share one. These are
// the suggestions; anyone can also pick their own with the colour picker.
// There's no green on purpose: green always means "free".
export const PRESET_COLORS = [
  { name: "blue", hex: "#2f7de1" },
  { name: "red", hex: "#e5484d" },
  { name: "purple", hex: "#8e4ec6" },
  { name: "orange", hex: "#f76b15" },
  { name: "pink", hex: "#d6409f" },
  { name: "teal", hex: "#12a594" },
  { name: "yellow", hex: "#e2a300" },
  { name: "brown", hex: "#a07553" },
  { name: "gray", hex: "#6e6e7a" },
  { name: "cyan", hex: "#0797b9" },
] as const;

const FALLBACK = PRESET_COLORS[0].hex;

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

/** `#AbC123` → `#abc123`, so the same colour always compares equal. */
export function normalizeColor(value: string): string {
  return value.toLowerCase();
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Text colour on a solid fill of `hex`: white, unless the fill is too light for it. */
export function textOn(hex: string): string {
  return luminance(hex) > 0.3 ? "#1c1b22" : "#ffffff";
}

/** Inline style that sets --pc (the colour) and --pc-on (text on a solid fill). */
export function colorStyle(hex: string): CSSProperties {
  const color = isHexColor(hex) ? hex : FALLBACK;
  return { "--pc": color, "--pc-on": textOn(color) } as CSSProperties;
}

/**
 * A colour nobody has: a random free suggestion, or, once those are all
 * taken, a random colour (never green-ish, never one already in use).
 */
export function pickColor(taken: Iterable<string>, random: () => number = Math.random): string {
  const used = new Set([...taken].map(normalizeColor));
  const free = PRESET_COLORS.map((c) => c.hex).filter((hex) => !used.has(hex));
  if (free.length) return free[Math.floor(random() * free.length)];
  for (;;) {
    // Hue outside 90–160° (green), saturated and mid-light so it reads on both themes.
    const hue = (160 + random() * 290) % 360;
    const hex = hslToHex(hue, 0.55 + random() * 0.3, 0.42 + random() * 0.14);
    if (!used.has(hex)) return hex;
  }
}

function hslToHex(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return `#${[f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("")}`;
}
