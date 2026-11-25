// A small client-side renderer for the suite, which runs in node without a DOM.
// React's server renderer can't follow what a component does after an await
// (a fetch's answer, then new state), so tests that press buttons and wait for
// the server mount components here instead.
//
// - Hooks run through React's own dispatcher slot, so components use the real
//   `react` package. State, refs and memos are kept per component between
//   renders, by the component's place in the tree (type and key), as React does.
// - Effects run after each render, children first. With `effects: false` none
//   run and useSyncExternalStore reads the server snapshot: the page as the
//   server renders it, which can still be clicked.
// - Each host element gets a small fake DOM node, kept while it stays in the
//   tree: refs point to it, and it has focus(), scrollIntoView(), closest(),
//   contains() and the attributes React would write.
// - Events capture and bubble through the props' handlers as React's do. What
//   the browser does by default follows unless a handler prevented it: a
//   submit button submits its form, Enter in a text field submits the form
//   implicitly, Enter in a textarea adds a new line, Enter on a button presses
//   it, and a link records the page it would open.
//
// Nothing here knows about the app's components.
import * as React from "react";
import { Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { vi } from "vitest";

type Props = Record<string, unknown>;
type Fn = (...args: unknown[]) => unknown;

const internals = (React as unknown as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

const CONTEXT = Symbol.for("react.context");
const CONSUMER = Symbol.for("react.consumer");
const FORWARD_REF = Symbol.for("react.forward_ref");
const MEMO = Symbol.for("react.memo");
const PORTAL = Symbol.for("react.portal");
const PASS_THROUGH = new Set<unknown>([Fragment, React.StrictMode, React.Suspense, React.Profiler]);

/** Text fields where Enter submits the form implicitly (HTML's implicit submission). */
const IMPLICIT = new Set(["text", "search", "url", "tel", "email", "password", "number", "date", "month", "week", "time", "datetime-local"]);

export const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

export class HostNode {
  children: (HostNode | string)[] = [];
  el!: FakeElement;
  constructor(
    readonly tag: string,
    readonly props: Props,
    readonly parent: HostNode | null,
    readonly path: string,
  ) {}
}

type Simple = { tag: string | null; id: string | null; classes: string[]; attrs: { name: string; value: string | null }[] };

function parseSelector(selector: string): Simple[] {
  return selector.split(",").map((part) => {
    const head = /^([a-zA-Z][\w-]*|\*)?/.exec(part.trim())!;
    const out: Simple = { tag: head[1] && head[1] !== "*" ? head[1].toLowerCase() : null, id: null, classes: [], attrs: [] };
    let rest = part.trim().slice(head[0].length);
    while (rest) {
      const id = /^#([\w-]+)/.exec(rest);
      const cls = /^\.([\w-]+)/.exec(rest);
      const attr = /^\[([\w-]+)(?:="([^"]*)")?\]/.exec(rest);
      const t = id ?? cls ?? attr;
      if (!t) throw new Error(`test: selector not supported: ${selector}`);
      if (id) out.id = id[1];
      else if (cls) out.classes.push(cls[1]);
      else if (attr) out.attrs.push({ name: attr[1], value: attr[2] ?? null });
      rest = rest.slice(t[0].length);
    }
    return out;
  });
}

const PROP_FOR: Record<string, string> = { class: "className", for: "htmlFor", tabindex: "tabIndex", readonly: "readOnly" };

/** The DOM node a host element would have: just enough for the app's handlers, refs and effects. */
export class FakeElement {
  node!: HostNode;
  /** A value or checked state the browser has before React hears of it (during a change event). */
  pending: { value?: string; checked?: boolean } = {};
  constructor(readonly ui: Ui) {}
  get tagName() {
    return this.node.tag.toUpperCase();
  }
  get nodeName() {
    return this.tagName;
  }
  get nodeType() {
    return 1;
  }
  get id() {
    return String(this.node.props.id ?? "");
  }
  get type() {
    const t = this.node.props.type;
    if (typeof t === "string") return t.toLowerCase();
    return this.node.tag === "button" ? "submit" : this.node.tag === "input" ? "text" : "";
  }
  get value(): string {
    if (this.pending.value !== undefined) return this.pending.value;
    const v = this.node.props.value ?? this.node.props.defaultValue;
    return v === undefined || v === null ? "" : String(v);
  }
  get checked(): boolean {
    if (this.pending.checked !== undefined) return this.pending.checked;
    return Boolean(this.node.props.checked ?? this.node.props.defaultChecked);
  }
  get disabled(): boolean {
    return Boolean(this.node.props.disabled);
  }
  get parentElement(): FakeElement | null {
    const p = this.node.parent;
    return p && p.tag !== "#root" ? p.el : null;
  }
  get textContent(): string {
    return textOf(this.node);
  }
  get isConnected(): boolean {
    return this.ui.elementAtPath(this.node.path) === this;
  }
  getAttribute(name: string): string | null {
    const v = this.node.props[PROP_FOR[name] ?? name];
    if (v === undefined || v === null || v === false || typeof v === "function") return null;
    if (v === true) return name.startsWith("aria-") || name.startsWith("data-") ? "true" : "";
    return String(v);
  }
  hasAttribute(name: string): boolean {
    return this.getAttribute(name) !== null;
  }
  matches(selector: string): boolean {
    return parseSelector(selector).some(
      (s) =>
        (s.tag === null || s.tag === this.node.tag) &&
        (s.id === null || s.id === this.id) &&
        s.classes.every((c) => String(this.node.props.className ?? "").split(/\s+/).includes(c)) &&
        s.attrs.every((a) => (a.value === null ? this.hasAttribute(a.name) : this.getAttribute(a.name) === a.value)),
    );
  }
  closest(selector: string): FakeElement | null {
    for (let n: HostNode | null = this.node; n && n.tag !== "#root"; n = n.parent) if (n.el.matches(selector)) return n.el;
    return null;
  }
  contains(other: unknown): boolean {
    if (!(other instanceof FakeElement)) return false;
    for (let n: HostNode | null = other.node; n; n = n.parent) if (n === this.node) return true;
    return false;
  }
  focus() {
    this.ui.activeElement = this;
  }
  blur() {
    if (this.ui.activeElement === this) this.ui.activeElement = null;
  }
  scrollIntoView(options?: unknown) {
    this.ui.scrolledIntoView.push({ el: this, options });
  }
  addEventListener() {}
  removeEventListener() {}
  getBoundingClientRect() {
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
}

/** DOM textContent. */
export function textOf(node: HostNode | string): string {
  return typeof node === "string" ? node : node.children.map(textOf).join("");
}

/** Text as it reads, without subtrees hidden from assistive tech. */
function visibleText(node: HostNode | string): string {
  if (typeof node === "string") return node;
  const hidden = node.props["aria-hidden"];
  if (hidden === true || hidden === "true") return "";
  return node.children.map(visibleText).join("");
}

export class FakeEvent {
  [extra: string]: unknown;
  defaultPrevented = false;
  propagationStopped = false;
  currentTarget: FakeElement | null = null;
  constructor(
    readonly type: string,
    readonly target: FakeElement,
    extra: Props = {},
  ) {
    Object.assign(this, extra);
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {
    this.propagationStopped = true;
  }
  isDefaultPrevented() {
    return this.defaultPrevented;
  }
  isPropagationStopped() {
    return this.propagationStopped;
  }
  persist() {}
  get nativeEvent() {
    return this;
  }
}

const HANDLER: Record<string, string> = { click: "onClick", change: "onChange", keydown: "onKeyDown", submit: "onSubmit", input: "onInput" };

type Hook =
  | { kind: "state"; value: unknown; reducer: (s: unknown, a: unknown) => unknown; dispatch: (a: unknown) => void }
  | { kind: "ref"; ref: { current: unknown } }
  | { kind: "memo"; fresh: boolean; deps: unknown[] | null | undefined; value: unknown }
  | { kind: "effect"; fresh: boolean; deps: unknown[] | null | undefined; cleanup: (() => void) | undefined }
  | { kind: "id"; id: string };
type Instance = { hooks: Hook[] };
type Effect = { layout: boolean; run: () => void };
type Frame = { instance: Instance; index: number; effects: Effect[] };
type Context = { _currentValue: unknown };

const sameDeps = (a: unknown[] | null | undefined, b: unknown[] | null | undefined) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));

export type Mounted = { type: unknown; props: Props; path: string };

export class Ui {
  /** Links the page would open, by a click on them: href, target and rel. */
  readonly opened: { href: string; target: string | null; rel: string | null }[] = [];
  /** Forms submitted without a handler preventing it: a page load in the browser. */
  readonly loads: HostNode[] = [];
  readonly scrolledIntoView: { el: FakeElement; options: unknown }[] = [];
  activeElement: FakeElement | null = null;
  /** Every component rendered in the last render, with its props. */
  mounted: Mounted[] = [];

  private top!: HostNode;
  private dirty = true;
  private ids = 0;
  private frame: Frame | null = null;
  private instances = new Map<string, Instance>();
  private elements = new Map<string, FakeElement>();
  private refs = new Map<string, unknown>();
  private pending: Promise<unknown>[] = [];
  private visited = new Set<string>();
  private hosts = new Set<string>();
  private effects: Effect[] = [];
  private contexts = new Map<unknown, unknown[]>();
  private readonly dispatcher: Record<string, Fn>;

  constructor(
    private readonly element: ReactElement,
    private readonly runEffects: boolean,
  ) {
    this.dispatcher = {
      readContext: (c) => this.readContext(c as Context),
      use: (usable) => {
        const u = usable as { $$typeof?: symbol; status?: string; value?: unknown };
        if (u?.$$typeof === CONTEXT) return this.readContext(usable as Context);
        if (u?.status === "fulfilled") return u.value;
        throw new Error("test: use() of a promise isn't supported");
      },
      useContext: (c) => this.readContext(c as Context),
      useState: (init) =>
        this.reducer(
          (s, a) => (typeof a === "function" ? (a as Fn)(s) : a),
          init,
          (i) => (typeof i === "function" ? (i as Fn)() : i),
        ),
      useReducer: (reducer, arg, init) => this.reducer(reducer as (s: unknown, a: unknown) => unknown, arg, (init as Fn | undefined) ?? ((x) => x)),
      useRef: (initial) => this.hook("ref", () => ({ kind: "ref", ref: { current: initial } })).ref,
      useMemo: (create, deps) => this.memo(create as Fn, deps as unknown[]),
      useCallback: (callback, deps) => this.memo(() => callback, deps as unknown[]),
      useEffect: (create, deps) => this.effect(create as Fn, deps as unknown[], false),
      useLayoutEffect: (create, deps) => this.effect(create as Fn, deps as unknown[], true),
      useInsertionEffect: (create, deps) => this.effect(create as Fn, deps as unknown[], true),
      useImperativeHandle: (ref, create, deps) =>
        this.effect(
          () => {
            const value = (create as Fn)();
            setRef(ref, value);
            return () => setRef(ref, null);
          },
          deps as unknown[],
          true,
        ),
      useSyncExternalStore: (subscribe, getSnapshot, getServerSnapshot) => {
        const value = this.runEffects ? (getSnapshot as Fn)() : ((getServerSnapshot ?? getSnapshot) as Fn)();
        if (this.runEffects) {
          this.effect(
            () =>
              (subscribe as Fn)(() => {
                this.dirty = true;
              }),
            [subscribe],
            true,
          );
        }
        return value;
      },
      useId: () => this.hook("id", () => ({ kind: "id", id: `_r_${++this.ids}_` })).id,
      useTransition: () => [false, (fn: unknown) => this.track((fn as Fn)())],
      useDeferredValue: (value) => value,
      useDebugValue: () => undefined,
      useOptimistic: (value) => [value, () => {}],
      useEffectEvent: (fn) => {
        const h = this.hook("ref", () => ({ kind: "ref", ref: { current: fn } }));
        h.ref.current = fn;
        return (...args: unknown[]) => (h.ref.current as Fn)(...args);
      },
    };
  }

  // ---- rendering --------------------------------------------------------

  private hook<K extends Hook["kind"]>(kind: K, make: () => Extract<Hook, { kind: K }>): Extract<Hook, { kind: K }> {
    const frame = this.frame;
    if (!frame) throw new Error("test: a hook was called outside a component");
    const i = frame.index++;
    let h = frame.instance.hooks[i];
    if (!h) {
      h = make();
      frame.instance.hooks[i] = h;
    } else if (h.kind !== kind) {
      throw new Error(`test: hook ${i} was ${h.kind} and is now ${kind}`);
    }
    return h as Extract<Hook, { kind: K }>;
  }

  private reducer(reducer: (s: unknown, a: unknown) => unknown, arg: unknown, init: Fn) {
    const h = this.hook("state", () => {
      const made: Extract<Hook, { kind: "state" }> = { kind: "state", value: init(arg), reducer, dispatch: () => {} };
      made.dispatch = (action) => {
        const next = made.reducer(made.value, action);
        if (!Object.is(next, made.value)) {
          made.value = next;
          this.dirty = true;
        }
      };
      return made;
    });
    h.reducer = reducer;
    return [h.value, h.dispatch];
  }

  private memo(create: Fn, deps: unknown[] | null | undefined) {
    const h = this.hook("memo", () => ({ kind: "memo", fresh: true, deps: undefined, value: undefined }));
    if (h.fresh || deps == null || !sameDeps(h.deps, deps)) {
      h.value = create();
      h.deps = deps;
      h.fresh = false;
    }
    return h.value;
  }

  private effect(create: Fn, deps: unknown[] | null | undefined, layout: boolean) {
    const h = this.hook("effect", () => ({ kind: "effect", fresh: true, deps: undefined, cleanup: undefined }));
    if (h.fresh || deps == null || !sameDeps(h.deps, deps)) {
      h.fresh = false;
      h.deps = deps;
      this.frame!.effects.push({
        layout,
        run: () => {
          h.cleanup?.();
          const out = create();
          h.cleanup = typeof out === "function" ? (out as () => void) : undefined;
        },
      });
    }
  }

  private readContext(c: Context) {
    const stack = this.contexts.get(c);
    return stack && stack.length > 0 ? stack[stack.length - 1] : c._currentValue;
  }

  elementAtPath(path: string): FakeElement | undefined {
    return this.elements.get(path);
  }

  private elementAt(path: string): FakeElement {
    let el = this.elements.get(path);
    if (!el) {
      el = new FakeElement(this);
      this.elements.set(path, el);
    }
    return el;
  }

  private renderNode(node: ReactNode, parent: HostNode, path: string): (HostNode | string)[] {
    if (node === null || node === undefined || typeof node === "boolean") return [];
    if (typeof node === "string" || typeof node === "number" || typeof node === "bigint") return [String(node)];
    if (Array.isArray(node)) {
      return node.flatMap((child, i) => {
        const key = isValidElement(child) && child.key !== null ? `k:${child.key}` : String(i);
        return this.renderNode(child as ReactNode, parent, `${path}[${key}]`);
      });
    }
    if (typeof node === "object" && (node as { $$typeof?: unknown }).$$typeof === PORTAL) {
      return this.renderNode((node as unknown as { children: ReactNode }).children, parent, `${path}/portal`);
    }
    if (!isValidElement(node)) throw new Error(`test: can't render ${String(node)}`);
    const el = node as ReactElement<Props>;
    return this.renderType(el.type, el.props, parent, path);
  }

  private renderType(type: unknown, props: Props, parent: HostNode, path: string): (HostNode | string)[] {
    if (typeof type === "string") {
      const here = `${path}/${type}`;
      const host = new HostNode(type, props, parent, here);
      host.el = this.elementAt(here);
      host.el.node = host;
      this.hosts.add(here);
      host.children = this.renderNode(props.children as ReactNode, host, here);
      return [host];
    }
    if (PASS_THROUGH.has(type)) return this.renderNode(props.children as ReactNode, parent, `${path}/~`);
    if (typeof type === "function") {
      const fn = type as Fn & { prototype?: { isReactComponent?: unknown } };
      if (fn.prototype?.isReactComponent) throw new Error(`test: class components aren't supported (${fn.name})`);
      return this.renderComponent(type, props, `${path}/${fn.name || "anonymous"}`, () => fn(props) as ReactNode, parent);
    }
    const t = type as { $$typeof?: symbol; render?: Fn; type?: unknown; _context?: Context } | null;
    if (t?.$$typeof === CONTEXT) {
      const stack = this.contexts.get(t) ?? [];
      this.contexts.set(t, stack);
      stack.push(props.value);
      try {
        return this.renderNode(props.children as ReactNode, parent, `${path}/ctx`);
      } finally {
        stack.pop();
      }
    }
    if (t?.$$typeof === CONSUMER) {
      return this.renderNode((props.children as Fn)(this.readContext(t._context!)) as ReactNode, parent, `${path}/consumer`);
    }
    if (t?.$$typeof === FORWARD_REF) {
      const { ref, ...rest } = props;
      return this.renderComponent(type, props, `${path}/${t.render!.name || "forwardRef"}`, () => t.render!(rest, ref ?? null) as ReactNode, parent);
    }
    if (t?.$$typeof === MEMO) return this.renderType(t.type, props, parent, path);
    throw new Error(`test: can't render element type ${String(type)}`);
  }

  private renderComponent(type: unknown, props: Props, here: string, call: () => ReactNode, parent: HostNode) {
    let instance = this.instances.get(here);
    if (!instance) {
      instance = { hooks: [] };
      this.instances.set(here, instance);
    }
    this.visited.add(here);
    this.mounted.push({ type, props, path: here });
    const frame: Frame = { instance, index: 0, effects: [] };
    const outerFrame = this.frame;
    const outerDispatcher = internals.H;
    this.frame = frame;
    internals.H = this.dispatcher;
    let out: ReactNode;
    try {
      out = call();
    } finally {
      this.frame = outerFrame;
      internals.H = outerDispatcher;
    }
    const children = this.renderNode(out, parent, here);
    // Children's effects first, as React runs them.
    this.effects.push(...frame.effects);
    return children;
  }

  private render() {
    this.dirty = false;
    this.visited = new Set();
    this.hosts = new Set();
    this.effects = [];
    this.contexts = new Map();
    this.mounted = [];
    const top = new HostNode("#root", {}, null, "");
    top.el = this.elementAt("");
    top.el.node = top;
    top.children = this.renderNode(this.element, top, "");
    this.top = top;
    for (const [here, instance] of this.instances) {
      if (this.visited.has(here)) continue;
      this.instances.delete(here);
      for (const h of instance.hooks) if (h.kind === "effect") h.cleanup?.();
    }
    for (const here of [...this.elements.keys()]) if (here !== "" && !this.hosts.has(here)) this.elements.delete(here);
    this.attachRefs();
    if (this.runEffects) {
      for (const e of this.effects) if (e.layout) e.run();
      for (const e of this.effects) if (!e.layout) e.run();
    }
  }

  private attachRefs() {
    const now = new Map<string, unknown>();
    const walk = (n: HostNode) => {
      if (n.props.ref) now.set(n.path, n.props.ref);
      for (const c of n.children) if (typeof c !== "string") walk(c);
    };
    walk(this.top);
    for (const [here, ref] of this.refs) if (now.get(here) !== ref) setRef(ref, null);
    for (const [here, ref] of now) if (this.refs.get(here) !== ref) setRef(ref, this.elements.get(here));
    this.refs = now;
  }

  private track(result: unknown) {
    if (result && typeof (result as Promise<unknown>).then === "function") this.pending.push(result as Promise<unknown>);
  }

  /** Render until nothing changes; wait for what handlers started (fetches and their answers). */
  async settle() {
    for (let round = 0; round < 200; round++) {
      this.flush();
      const waiting = this.pending.splice(0);
      if (waiting.length > 0) {
        await Promise.all(waiting);
        continue;
      }
      await new Promise((resolve) => setImmediate(resolve));
      if (!this.dirty && this.pending.length === 0) return;
    }
    throw new Error("test: the page didn't settle");
  }

  private flush() {
    for (let n = 0; this.dirty; n++) {
      if (n > 50) throw new Error("test: too many renders in a row");
      this.render();
    }
  }

  unmount() {
    for (const instance of this.instances.values()) for (const h of instance.hooks) if (h.kind === "effect") h.cleanup?.();
    this.instances.clear();
  }

  // ---- queries ----------------------------------------------------------

  get root(): HostNode {
    return this.top;
  }

  /** Every host element, in document order. */
  all(within: HostNode = this.top): HostNode[] {
    const out: HostNode[] = [];
    const walk = (n: HostNode) => {
      for (const c of n.children) {
        if (typeof c === "string") continue;
        out.push(c);
        walk(c);
      }
    };
    walk(within);
    return out;
  }

  find(test: (n: HostNode) => boolean, within: HostNode = this.top): HostNode | null {
    return this.all(within).find(test) ?? null;
  }

  get(test: (n: HostNode) => boolean, what: string, within: HostNode = this.top): HostNode {
    const found = this.find(test, within);
    if (!found) throw new Error(`test: no ${what} in:\n${this.html(within)}`);
    return found;
  }

  /** The accessible name of an element, roughly as browsers work it out. */
  nameOf(n: HostNode): string {
    const by = n.props["aria-labelledby"];
    if (typeof by === "string") {
      return collapse(
        by
          .split(/\s+/)
          .map((id) => this.find((x) => x.props.id === id))
          .map((x) => (x ? visibleText(x) : ""))
          .join(" "),
      );
    }
    const label = n.props["aria-label"];
    if (typeof label === "string" && label.trim()) return collapse(label);
    if (["input", "select", "textarea"].includes(n.tag)) {
      for (let p = n.parent; p; p = p.parent) {
        if (p.tag === "label") return collapse(p.children.map((c) => (c === n || (typeof c !== "string" && ["select", "textarea"].includes(c.tag)) ? "" : visibleText(c))).join(""));
      }
      return collapse(String(n.props.placeholder ?? n.props.title ?? ""));
    }
    return collapse(visibleText(n)) || collapse(String(n.props.title ?? ""));
  }

  /** The element with this accessible name (a button, a link, a field…). */
  named(name: string | RegExp, within: HostNode = this.top): HostNode | null {
    const interactive = (n: HostNode) =>
      ["a", "button", "input", "select", "textarea"].includes(n.tag) || typeof n.props.role === "string";
    const all = this.all(within).filter(interactive);
    return all.find((n) => (typeof name === "string" ? this.nameOf(n) === name : name.test(this.nameOf(n)))) ?? null;
  }

  getNamed(name: string | RegExp, within: HostNode = this.top): HostNode {
    const found = this.named(name, within);
    if (!found) {
      const names = this.all(within)
        .filter((n) => ["a", "button", "input", "select", "textarea"].includes(n.tag))
        .map((n) => `${n.tag} "${this.nameOf(n)}"`);
      throw new Error(`test: nothing named ${String(name)}; there are: ${names.join(", ")}`);
    }
    return found;
  }

  /** Every element whose whole text reads exactly `text` (spaces collapsed); the innermost come last. */
  withText(text: string | RegExp, within: HostNode = this.top): HostNode[] {
    return this.all(within).filter((n) => {
      const t = collapse(textOf(n));
      return typeof text === "string" ? t === text : text.test(t);
    });
  }

  text(n: HostNode = this.top): string {
    return collapse(textOf(n));
  }

  /** Rough markup, for failure messages. */
  html(n: HostNode | string = this.top): string {
    if (typeof n === "string") return n;
    const inner = n.children.map((c) => this.html(c)).join("");
    if (n.tag === "#root") return inner;
    const attrs = Object.entries(n.props)
      .filter(([k, v]) => k !== "children" && k !== "ref" && typeof v !== "function" && v !== undefined && v !== null && v !== false)
      .map(([k, v]) => (v === true ? ` ${k}` : ` ${k === "className" ? "class" : k}="${typeof v === "object" ? JSON.stringify(v) : String(v)}"`))
      .join("");
    return `<${n.tag}${attrs}>${inner}</${n.tag}>`;
  }

  /** The props each rendered `type` was last given. */
  propsOf(type: unknown): Props[] {
    return this.mounted.filter((m) => m.type === type).map((m) => m.props);
  }

  // ---- events -----------------------------------------------------------

  private dispatch(target: HostNode, type: string, extra: Props = {}): FakeEvent {
    const path: HostNode[] = [];
    for (let n: HostNode | null = target; n && n.tag !== "#root"; n = n.parent) path.unshift(n);
    const event = new FakeEvent(type, target.el, extra);
    const name = HANDLER[type];
    for (const n of path) {
      if (event.propagationStopped) break;
      const h = n.props[`${name}Capture`];
      if (typeof h === "function") {
        event.currentTarget = n.el;
        this.track(h(event));
      }
    }
    for (const n of [...path].reverse()) {
      if (event.propagationStopped) break;
      const h = n.props[name];
      if (typeof h === "function") {
        event.currentTarget = n.el;
        this.track(h(event));
      }
    }
    return event;
  }

  private disabledControl(n: HostNode): HostNode | null {
    for (let p: HostNode | null = n; p && p.tag !== "#root"; p = p.parent) {
      if (["button", "input", "select", "textarea", "fieldset"].includes(p.tag) && p.props.disabled) return p;
    }
    return null;
  }

  private assertUsable(n: HostNode, what: string) {
    const off = this.disabledControl(n);
    if (off) throw new Error(`test: ${what} a disabled ${off.tag} (${this.nameOf(off)})`);
  }

  private isSubmitButton(n: HostNode) {
    return (n.tag === "button" && n.el.type === "submit") || (n.tag === "input" && ["submit", "image"].includes(n.el.type));
  }

  private formOf(n: HostNode): HostNode | null {
    for (let p: HostNode | null = n; p; p = p.parent) if (p.tag === "form") return p;
    return null;
  }

  private submitForm(form: HostNode, submitter: HostNode | null) {
    const event = this.dispatch(form, "submit", { submitter: submitter?.el ?? null });
    this.flush();
    if (!event.defaultPrevented) this.loads.push(form);
  }

  /** A click, then what the browser does by default. */
  private press(n: HostNode) {
    const event = this.dispatch(n, "click", { button: 0, detail: 1 });
    this.flush();
    if (event.defaultPrevented) return;
    for (let p: HostNode | null = n; p && p.tag !== "#root"; p = p.parent) {
      if (p.tag === "a" && typeof p.props.href === "string") {
        this.opened.push({
          href: p.props.href,
          target: typeof p.props.target === "string" ? p.props.target : null,
          rel: typeof p.props.rel === "string" ? p.props.rel : null,
        });
        return;
      }
      if (this.isSubmitButton(p)) {
        const form = this.formOf(p);
        if (form) this.submitForm(form, p);
        return;
      }
      if (p.tag === "button") return;
    }
  }

  async click(n: HostNode) {
    this.assertUsable(n, "clicked");
    this.press(n);
    await this.settle();
  }

  /** Type a field's whole new value, or pick a select's option. */
  async change(n: HostNode, value: string) {
    this.assertUsable(n, "changed");
    if (n.tag === "select") {
      const options = this.all(n).filter((o) => o.tag === "option").map((o) => String(o.props.value ?? textOf(o)));
      if (!options.includes(value)) throw new Error(`test: ${this.nameOf(n) || "the select"} offers no ${value} (it offers ${options.join(", ")})`);
    }
    n.el.pending.value = value;
    try {
      this.dispatch(n, "change");
    } finally {
      n.el.pending = {};
    }
    await this.settle();
  }

  /** Tick or untick a check box, by clicking it. */
  async toggle(n: HostNode) {
    this.assertUsable(n, "ticked");
    n.el.pending.checked = !n.el.checked;
    try {
      const event = this.dispatch(n, "click", { button: 0 });
      if (!event.defaultPrevented) this.dispatch(n, "change");
    } finally {
      n.el.pending = {};
    }
    await this.settle();
  }

  /** A key pressed in an element, then what the browser does by default (Enter only). */
  async keyDown(n: HostNode, key: string): Promise<FakeEvent> {
    const event = this.dispatch(n, "keydown", { key, code: key });
    this.flush();
    if (!event.defaultPrevented && key === "Enter") {
      if (n.tag === "textarea") {
        n.el.pending.value = `${n.el.value}\n`;
        try {
          this.dispatch(n, "change");
        } finally {
          n.el.pending = {};
        }
      } else if (n.tag === "input" && IMPLICIT.has(n.el.type)) {
        const form = this.formOf(n);
        if (form) {
          const fallback = this.all(form).find((x) => this.isSubmitButton(x));
          if (fallback) {
            if (!this.disabledControl(fallback)) this.press(fallback);
          } else if (this.all(form).filter((x) => x.tag === "input" && IMPLICIT.has(x.el.type)).length === 1) {
            this.submitForm(form, null);
          }
        }
      } else if (n.tag === "button" || n.tag === "a") {
        if (!this.disabledControl(n)) this.press(n);
      }
    }
    await this.settle();
    return event;
  }
}

function setRef(ref: unknown, value: unknown) {
  if (typeof ref === "function") ref(value);
  else if (ref && typeof ref === "object") (ref as { current: unknown }).current = value ?? null;
}

/**
 * Mount `element`. With `effects` (the default), as in the browser after
 * hydration; without, as the server renders it.
 */
export async function mount(element: ReactElement, { effects = true }: { effects?: boolean } = {}): Promise<Ui> {
  const ui = new Ui(element, effects);
  await ui.settle();
  return ui;
}

/**
 * A browser window at `href`, for components' handlers and effects: location,
 * history (replaceState and pushState change the address; each entry keeps its
 * state, and back(), forward() and go() move between entries and fire
 * popstate at the window's listeners), the clipboard, window.open and
 * matchMedia for a screen `width` px wide.
 */
export function fakeBrowser(href: string, { width = 1280 }: { width?: number } = {}) {
  let url = new URL(href);
  /** Every history entry's address, oldest first; `at` is the one shown. */
  const entries = [url.href];
  const states: unknown[] = [null];
  let at = 0;
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const clipboard: string[] = [];
  const opened: { url: string; target: string | null; features: string | null }[] = [];
  const location = {
    get href() {
      return url.href;
    },
    get origin() {
      return url.origin;
    },
    get protocol() {
      return url.protocol;
    },
    get host() {
      return url.host;
    },
    get hostname() {
      return url.hostname;
    },
    get port() {
      return url.port;
    },
    get pathname() {
      return url.pathname;
    },
    get search() {
      return url.search;
    },
    get hash() {
      return url.hash;
    },
    assign: (to: string) => {
      throw new Error(`test: the page navigated to ${to}`);
    },
    replace: (to: string) => {
      throw new Error(`test: the page navigated to ${to}`);
    },
    reload: () => {
      throw new Error("test: the page reloaded");
    },
    toString: () => url.href,
  };
  const history = {
    state: null as unknown,
    get length() {
      return entries.length;
    },
    replaceState(state: unknown, _unused: string, next?: string | URL | null) {
      if (next !== undefined && next !== null) url = new URL(String(next), url);
      entries[at] = url.href;
      states[at] = state;
      history.state = state;
    },
    pushState(state: unknown, _unused: string, next?: string | URL | null) {
      if (next !== undefined && next !== null) url = new URL(String(next), url);
      // A new entry drops the ones Back had left ahead.
      entries.splice(at + 1);
      states.splice(at + 1);
      entries.push(url.href);
      states.push(state);
      at = entries.length - 1;
      history.state = state;
    },
    back() {
      history.go(-1);
    },
    forward() {
      history.go(1);
    },
    /** Move `delta` entries, then fire popstate with that entry's state. go(0) (a reload) does nothing. */
    go(delta = 0) {
      const to = at + delta;
      if (delta === 0 || to < 0 || to >= entries.length) return;
      at = to;
      url = new URL(entries[at]);
      history.state = states[at];
      for (const listener of [...(listeners.get("popstate") ?? [])]) listener({ type: "popstate", state: history.state });
    },
  };
  const media = (query: string) => {
    const min = /\(min-width:\s*(\d+)px\)/.exec(query);
    const max = /\(max-width:\s*(\d+)px\)/.exec(query);
    const matches = (!min || width >= Number(min[1])) && (!max || width <= Number(max[1])) && !/prefers-color-scheme:\s*dark/.test(query);
    return { matches, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
  };
  const window = {
    location,
    history,
    isSecureContext: true,
    innerWidth: width,
    matchMedia: media,
    open: (to: string, target?: string, features?: string) => {
      opened.push({ url: String(to), target: target ?? null, features: features ?? null });
      return null;
    },
    addEventListener(type: string, listener: (event: unknown) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: (event: unknown) => void) {
      listeners.get(type)?.delete(listener);
    },
    scrollTo() {},
  };
  const navigator = {
    userAgent: "test",
    language: "en-GB",
    languages: ["en-GB"],
    clipboard: {
      writeText: async (text: string) => {
        clipboard.push(text);
      },
      readText: async () => clipboard[clipboard.length - 1] ?? "",
    },
  };
  return {
    window,
    navigator,
    history,
    clipboard,
    opened,
    entries,
    get url() {
      return url;
    },
    /** Make it the global window, navigator, location and history (undone by vi.unstubAllGlobals). */
    install() {
      vi.stubGlobal("window", window);
      vi.stubGlobal("navigator", navigator);
      vi.stubGlobal("location", location);
      vi.stubGlobal("history", history);
      return this;
    },
  };
}
