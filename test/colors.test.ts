import { describe, expect, it } from "vitest";
import { PRESET_COLORS, isHexColor, pickColor, textOn } from "@/lib/colors";

const presets: string[] = PRESET_COLORS.map((c) => c.hex);

describe("person colours", () => {
  it("hands out a free suggested colour", () => {
    const taken = presets.slice(0, 9);
    expect(pickColor(taken)).toBe(presets[9]);
    // Taken ones are compared case-insensitively.
    expect(pickColor(taken.map((c) => c.toUpperCase()))).toBe(presets[9]);
  });

  it("picks at random among the free ones", () => {
    expect(pickColor([], () => 0)).toBe(presets[0]);
    expect(pickColor([], () => 0.99)).toBe(presets[9]);
  });

  it("makes up a new colour once every suggestion is taken, never a used one", () => {
    const used = new Set(presets);
    for (let i = 0; i < 50; i++) {
      const c = pickColor(used);
      expect(isHexColor(c)).toBe(true);
      expect(used.has(c)).toBe(false);
      used.add(c);
    }
  });

  it("puts dark text on light colours and white on dark ones", () => {
    expect(textOn("#e2a300")).toBe("#1c1b22");
    expect(textOn("#2f7de1")).toBe("#ffffff");
  });
});
