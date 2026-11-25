// A small stand-in for React's hooks, so a test can run a client component's
// own logic in node, which has no DOM and no client renderer. A test file
// mocks "react" with these hooks (see booking-visitor-flow.test.ts); then
// mount() calls the component function, keeps its state between calls, runs
// the effects whose deps changed (after pointing each ref at a fake node that
// records focus()), and calls it again while state changed. Children aren't
// run: a test reads the elements the component returned and calls the
// handlers they carry, as a click would. Only what the booking pages use.
import type { ReactElement, ReactNode } from "react";

// No runtime import of "react": the test's mock of "react" imports this file.
const ELEMENT = new Set([Symbol.for("react.transitional.element"), Symbol.for("react.element")]);
const isValidElement = (node: unknown): node is ReactElement =>
  typeof node === "object" && node !== null && ELEMENT.has((node as { $$typeof?: symbol }).$$typeof as symbol);

type Slot = {
  value?: unknown;
  deps?: readonly unknown[];
  cleanup?: unknown;
  dispatch?: (action: unknown) => void;
  reducer?: (state: unknown, action: unknown) => unknown;
};

/** What a ref points at: the element's tag and own text, and a focus() that's recorded. */
export type FakeNode = { tag: string; text: string; focus: () => void };

type Any = ReactElement<Record<string, unknown>>;

/** Every element of a tree, children included; nested components aren't run. */
export function elements(node: ReactNode): Any[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const el = node as Any;
  return [el, ...elements(el.props.children as ReactNode)];
}

/** An element's own text: its string children, joined. */
export const ownText = (el: Any) =>
  [el.props.children]
    .flat(Infinity)
    .filter((c) => typeof c === "string" || typeof c === "number")
    .join("")
    .trim();

function createFake() {
  let slots: Slot[] = [];
  let index = 0;
  let dirty = false;
  let pending: (() => void)[] = [];
  let component: ((props: never) => ReactNode) | null = null;
  let props: unknown = null;
  let last: ReactNode = null;
  /** Every node focus() was called on, in order. */
  const focused: FakeNode[] = [];

  const changed = (a?: readonly unknown[], b?: readonly unknown[]) =>
    !a || !b || a.length !== b.length || a.some((x, i) => !Object.is(x, b[i]));

  const hooks = {
    useState(init: unknown) {
      const k = index++;
      if (!slots[k]) slots[k] = { value: typeof init === "function" ? (init as () => unknown)() : init };
      const s = slots[k];
      s.dispatch ??= (v: unknown) => {
        const next = typeof v === "function" ? (v as (p: unknown) => unknown)(s.value) : v;
        if (!Object.is(next, s.value)) {
          s.value = next;
          dirty = true;
        }
      };
      return [s.value, s.dispatch];
    },
    useReducer(reducer: (state: unknown, action: unknown) => unknown, init: unknown) {
      const k = index++;
      if (!slots[k]) slots[k] = { value: init };
      const s = slots[k];
      s.reducer = reducer;
      s.dispatch ??= (action: unknown) => {
        const next = s.reducer!(s.value, action);
        if (!Object.is(next, s.value)) {
          s.value = next;
          dirty = true;
        }
      };
      return [s.value, s.dispatch];
    },
    useRef(init: unknown) {
      const k = index++;
      if (!slots[k]) slots[k] = { value: { current: init } };
      return slots[k].value;
    },
    useMemo(make: () => unknown, deps?: readonly unknown[]) {
      const k = index++;
      const s = slots[k];
      if (!s || changed(s.deps, deps)) slots[k] = { value: make(), deps };
      return slots[k].value;
    },
    useCallback(fn: unknown, deps?: readonly unknown[]) {
      return hooks.useMemo(() => fn, deps);
    },
    useEffect(effect: () => unknown, deps?: readonly unknown[]) {
      const k = index++;
      const s = slots[k];
      if (s && !changed(s.deps, deps)) return;
      const previous = s?.cleanup;
      slots[k] = { deps };
      pending.push(() => {
        if (typeof previous === "function") previous();
        slots[k].cleanup = effect();
      });
    },
    useLayoutEffect(effect: () => unknown, deps?: readonly unknown[]) {
      hooks.useEffect(effect, deps);
    },
    useSyncExternalStore(_subscribe: unknown, getSnapshot: () => unknown) {
      index++;
      return getSnapshot();
    },
    useContext(context: { _currentValue: unknown }) {
      return context._currentValue;
    },
  };

  /** Point each host element's ref at a fake node, as React does before effects run. */
  function attachRefs(tree: ReactNode) {
    for (const el of elements(tree)) {
      if (typeof el.type !== "string") continue;
      const ref = (el.props.ref ?? (el as unknown as { ref?: unknown }).ref) as { current: unknown } | undefined;
      if (!ref || typeof ref !== "object" || !("current" in ref)) continue;
      const node: FakeNode = { tag: el.type, text: ownText(el), focus: () => void focused.push(node) };
      ref.current = node;
    }
  }

  function render(): ReactNode {
    if (!component) throw new Error("nothing mounted");
    for (let n = 0; ; n++) {
      if (n > 100) throw new Error("renders without end");
      dirty = false;
      index = 0;
      last = component(props as never);
      attachRefs(last);
      const run = pending;
      pending = [];
      for (const e of run) e();
      if (!dirty) return last;
    }
  }

  return {
    hooks,
    focused,
    /** Start afresh with `c` and its props; the first render's tree. */
    mount<P>(c: (props: P) => ReactNode, p: P): ReactNode {
      for (const s of slots) if (typeof s?.cleanup === "function") (s.cleanup as () => void)();
      slots = [];
      pending = [];
      focused.length = 0;
      component = c as never;
      props = p;
      return render();
    },
    /** The same component with new props, as a parent's render gives them. */
    update<P>(p: P): ReactNode {
      props = p;
      return render();
    },
    /** Let pending promises run, rendering again whenever state changed; the latest tree. */
    async settle(): Promise<ReactNode> {
      for (let quiet = 0; quiet < 5; ) {
        await new Promise((r) => setImmediate(r));
        if (dirty) {
          render();
          quiet = 0;
        } else quiet++;
      }
      return last;
    },
    /** Render again if state changed meanwhile (a handler or a timer set it); the latest tree. */
    flush(): ReactNode {
      return dirty ? render() : last;
    },
    get tree() {
      return last;
    },
  };
}

export const fake = createFake();
