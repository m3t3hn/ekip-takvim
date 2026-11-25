// Shared by the visitor page tests (run 2026-11-25-ekip-quick-wins-visitor):
// the HTML React's server renderer gives, read back as a tree, so a test can
// ask for elements by tag, attribute and text. The suite has no DOM.
import { createElement, type ComponentType, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

export type El = { tag: string; attrs: Record<string, string>; children: (El | string)[] };

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

export function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** Markup as a tree under a root of tag "#root". */
export function parse(html: string): El {
  const root: El = { tag: "#root", attrs: {}, children: [] };
  const stack: El[] = [root];
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  for (const m of html.matchAll(re)) {
    const top = stack[stack.length - 1];
    if (m[0].startsWith("<!--")) continue;
    if (m[1]) {
      const closing = m[1].toLowerCase();
      while (stack.length > 1 && stack[stack.length - 1].tag !== closing) stack.pop();
      if (stack.length > 1) stack.pop();
    } else if (m[2]) {
      const attrs: Record<string, string> = {};
      for (const a of (m[3] ?? "").matchAll(/([^\s=>/]+)(?:="([^"]*)")?/g)) attrs[a[1].toLowerCase()] = decode(a[2] ?? "");
      const el: El = { tag: m[2].toLowerCase(), attrs, children: [] };
      top.children.push(el);
      if (!m[4] && !VOID.has(el.tag)) stack.push(el);
    } else if (m[5]) {
      top.children.push(decode(m[5]));
    }
  }
  return root;
}

/** Elements that start a line of their own: their text is set apart from what's around it. */
const BLOCK = new Set(["div", "p", "h1", "h2", "h3", "h4", "h5", "h6", "section", "main", "ul", "ol", "li", "form", "label", "button", "input", "textarea", "br", "hr"]);

/** An element's text, its descendants' included, with runs of whitespace as one space. */
export function textOf(n: El | string): string {
  const raw = (x: El | string): string => {
    if (typeof x === "string") return x;
    if (x.tag === "svg") return "";
    const inner = x.children.map(raw).join("");
    return BLOCK.has(x.tag) ? ` ${inner} ` : inner;
  };
  return raw(n).replace(/\s+/g, " ").trim();
}

/** Every element under `n` (n included) that `test` accepts, in document order. */
export function all(n: El, test: (e: El) => boolean): El[] {
  const out: El[] = [];
  const walk = (e: El) => {
    if (test(e)) out.push(e);
    for (const c of e.children) if (typeof c !== "string") walk(c);
  };
  walk(n);
  return out;
}

export const byTag = (n: El, tag: string) => all(n, (e) => e.tag === tag);
export const classesOf = (e: El) => (e.attrs.class ?? "").split(/\s+/).filter(Boolean);

/** The one element `test` accepts; throws when there are none or several. */
export function one(n: El, test: (e: El) => boolean, what = "element"): El {
  const found = all(n, test);
  if (found.length !== 1) throw new Error(`expected one ${what}, found ${found.length}`);
  return found[0];
}

/** Render a component on the server, as Next does for a client component's first HTML. */
export function render<P extends object>(component: ComponentType<P>, props: P): { html: string; root: El; text: string } {
  const html = renderToStaticMarkup(createElement(component, props) as ReactElement);
  const root = parse(html);
  return { html, root, text: textOf(root) };
}

/** Render an element tree on the server. */
export function renderElement(element: ReactElement): { html: string; root: El; text: string } {
  const html = renderToStaticMarkup(element);
  const root = parse(html);
  return { html, root, text: textOf(root) };
}

/**
 * How tall an element is under 640 px wide, in px, from its Tailwind classes:
 * the larger of its height and min-height there (max-sm: ones win under
 * 640 px), with Tailwind's spacing of 4 px a step. Null when it sets none.
 */
export function phoneHeight(e: El): number | null {
  const cls = classesOf(e);
  const read = (prefix: string) => {
    let base: number | null = null;
    let phone: number | null = null;
    for (const c of cls) {
      const small = c.startsWith("max-sm:");
      const name = small ? c.slice("max-sm:".length) : c;
      const m = new RegExp(`^${prefix}-(\\d+(?:\\.\\d+)?)$`).exec(name);
      if (!m) continue;
      if (small) phone = Number(m[1]) * 4;
      else if (!c.includes(":")) base = Number(m[1]) * 4;
    }
    return phone ?? base;
  };
  const h = read("h");
  const min = read("min-h");
  if (h === null && min === null) return null;
  return Math.max(h ?? 0, min ?? 0);
}
