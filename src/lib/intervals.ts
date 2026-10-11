// Half-open [start, end) ranges in epoch milliseconds. Pure, shared by server
// and client.

export type Interval = [number, number];

export function merge(list: Interval[]): Interval[] {
  const sorted = list
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Interval[] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** Parts of `window` not covered by any interval in `busy`. */
export function subtract(window: Interval, busy: Interval[]): Interval[] {
  const out: Interval[] = [];
  let cursor = window[0];
  for (const [s, e] of merge(busy)) {
    if (e <= cursor) continue;
    if (s >= window[1]) break;
    if (s > cursor) out.push([cursor, Math.min(s, window[1])]);
    cursor = Math.max(cursor, e);
    if (cursor >= window[1]) break;
  }
  if (cursor < window[1]) out.push([cursor, window[1]]);
  return out;
}

export function intersect(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  const x = merge(a);
  const y = merge(b);
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    const s = Math.max(x[i][0], y[j][0]);
    const e = Math.min(x[i][1], y[j][1]);
    if (e > s) out.push([s, e]);
    if (x[i][1] < y[j][1]) i++;
    else j++;
  }
  return out;
}

export function intersectAll(lists: Interval[][]): Interval[] {
  if (lists.length === 0) return [];
  return lists.slice(1).reduce((acc, l) => intersect(acc, l), merge(lists[0]));
}

export function overlaps(list: Interval[], range: Interval): boolean {
  return list.some(([s, e]) => s < range[1] && e > range[0]);
}

export function total(list: Interval[]): number {
  return list.reduce((sum, [s, e]) => sum + (e - s), 0);
}

export function atLeast(list: Interval[], minMs: number): Interval[] {
  return list.filter(([s, e]) => e - s >= minMs);
}
