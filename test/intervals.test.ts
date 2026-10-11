import { describe, expect, it } from "vitest";
import { atLeast, intersectAll, merge, subtract, total } from "@/lib/intervals";

describe("intervals", () => {
  it("merges overlapping and touching ranges", () => {
    expect(merge([[5, 8], [1, 3], [3, 4], [7, 10], [12, 12]])).toEqual([[1, 4], [5, 10]]);
  });

  it("subtracts busy time from a window", () => {
    expect(subtract([0, 24], [[9, 13], [14, 18], [-5, 1], [23, 30]])).toEqual([
      [1, 9], [13, 14], [18, 23],
    ]);
    expect(subtract([0, 10], [])).toEqual([[0, 10]]);
    expect(subtract([0, 10], [[0, 10]])).toEqual([]);
  });

  it("intersects free time across people", () => {
    const ahmet = subtract([8, 22], [[9, 13], [14, 18]]);
    const elif = subtract([8, 22], [[10, 17]]);
    const mert = subtract([8, 22], [[8, 12], [13, 16.5], [19, 20]]);
    expect(intersectAll([ahmet, elif, mert])).toEqual([[18, 19], [20, 22]]);
    expect(intersectAll([])).toEqual([]);
  });

  it("filters by minimum length and totals", () => {
    const list: [number, number][] = [[0, 1], [2, 5], [6, 6.5]];
    expect(atLeast(list, 1)).toEqual([[0, 1], [2, 5]]);
    expect(total(list)).toBe(4.5);
  });
});
