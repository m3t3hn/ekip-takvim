// A stand-in for Next's root Router in the browser, for what it does with
// history only. Written from next/dist/client/components/app-router.js in
// Next 16.4.6, keeping its history code as it is there:
//
// - HistoryUpdater (:73-118) writes the router's state into the history entry
//   in an insertion effect, { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE },
//   at the router's own address (canonicalUrl). A navigation that pushes gets
//   a new entry.
// - The Router's effect (:273-320) patches history.pushState and replaceState.
//   A call that isn't Next's own (no __NA) gets the entry's Next state copied
//   in (copyNextJsInternalHistoryState, :128-139) and tells the router its new
//   address (a restore), then the browser's own function runs. The effect also
//   listens for popstate.
// - handlePopState (:61-72) does nothing for an entry without state, reloads
//   the page for one without __NA, and otherwise restores the router to the
//   tree the entry holds (navigator.traverse).
//
// Next renders HistoryUpdater first and the page after it, both inside the
// Router, so on a first load without loading.tsx the page's effects run in the
// Router's commit, before the Router's own (a parent's effects run after its
// children's). The harness runs effects in that order.
//
// The router's state is its address, its tree (here only which page it shows:
// My settings is `children`, the calendar is a heading) and whether a
// navigation is waiting to push. A restore of the same tree fetches nothing in
// Next, and nothing here does either. `onRouter` gets the router useRouter()
// gives: push, replace and refresh act on this state as Next's do.
import { Fragment, createElement, useEffect, useInsertionEffect, useReducer, useRef, type ReactNode } from "react";

export type Page = "settings" | "calendar";
type Tree = { page: Page };
type AppHistoryState = { tree: Tree; renderedSearch: string };
export type RouterState = { canonicalUrl: string; tree: Tree; renderedSearch: string; pushRef: { pendingPush: boolean } };
type Action =
  | { type: "restore"; url: URL; historyState: AppHistoryState | undefined }
  | { type: "navigate"; url: URL; push: boolean }
  | { type: "refresh" };
type NextHistoryState = { __NA?: boolean; _N?: boolean; __PRIVATE_NEXTJS_INTERNALS_TREE?: AppHistoryState } & Record<string, unknown>;

export type Router = {
  push(href: string): void;
  replace(href: string): void;
  refresh(): void;
  back(): void;
  forward(): void;
  prefetch(): void;
  /** The router's state now: its address, and the page it shows. */
  state(): RouterState;
};

/** router-reducer/create-href-from-url.js: the address the router keeps, hash and all. */
export const createHrefFromUrl = (url: URL) => url.pathname + url.search + url.hash;

const treeAt = (url: URL): Tree => ({ page: url.pathname === "/settings" ? "settings" : "calendar" });

function reducer(state: RouterState, action: Action): RouterState {
  switch (action.type) {
    // restore-reducer.js: the tree the entry holds (or the one shown), at the given address.
    case "restore":
      return {
        canonicalUrl: createHrefFromUrl(action.url),
        tree: action.historyState?.tree ?? state.tree,
        renderedSearch: action.historyState?.renderedSearch ?? state.renderedSearch,
        pushRef: { pendingPush: false },
      };
    // router.push / router.replace, and a next/link: the page at that address.
    case "navigate":
      return { canonicalUrl: createHrefFromUrl(action.url), tree: treeAt(action.url), renderedSearch: action.url.search, pushRef: { pendingPush: action.push } };
    // router.refresh: the same address and tree, as a new state, so HistoryUpdater writes the entry again.
    case "refresh":
      return { ...state, pushRef: { pendingPush: false } };
  }
}

/** app-router.js:128-139 */
function copyNextJsInternalHistoryState(data: NextHistoryState | null | undefined): NextHistoryState {
  const out: NextHistoryState = data ?? {};
  const currentState = window.history.state as NextHistoryState | null;
  const __NA = currentState?.__NA;
  if (__NA) out.__NA = __NA;
  const tree = currentState?.__PRIVATE_NEXTJS_INTERNALS_TREE;
  if (tree) out.__PRIVATE_NEXTJS_INTERNALS_TREE = tree;
  return out;
}

/** app-router.js:73-118, its history write. (Next also keeps an app's own fields of the entry when a restore asks it to; this page has none.) */
function HistoryUpdater({ appRouterState }: { appRouterState: RouterState }) {
  const pushed = useRef<RouterState | null>(null);
  useInsertionEffect(() => {
    const { tree, pushRef, canonicalUrl, renderedSearch } = appRouterState;
    const historyState = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree, renderedSearch } };
    // Next clears pushRef.pendingPush once it has pushed; this remembers the state it pushed for.
    if (pushRef.pendingPush && pushed.current !== appRouterState && createHrefFromUrl(new URL(window.location.href)) !== canonicalUrl) {
      pushed.current = appRouterState;
      window.history.pushState(historyState, "", canonicalUrl);
    } else {
      window.history.replaceState(historyState, "", canonicalUrl);
    }
  }, [appRouterState]);
  return null;
}

/** The mounted router's state, for Router.state(): its insertion effect keeps it. One router at a time. */
let mountedState: RouterState | null = null;

/** Next's root Router at `initialUrl`, showing `children` while it's on My settings. */
export function NextRouter({ initialUrl, onRouter, children }: { initialUrl: string; onRouter: (router: Router) => void; children?: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialUrl, (href: string): RouterState => {
    const url = new URL(href);
    return { canonicalUrl: createHrefFromUrl(url), tree: treeAt(url), renderedSearch: url.search, pushRef: { pendingPush: false } };
  });
  useInsertionEffect(() => {
    mountedState = state;
  });
  const go = (href: string, push: boolean) => dispatch({ type: "navigate", url: new URL(href, window.location.href), push });
  // During render, as the page's useRouter() reads it during its own.
  onRouter({
    push: (href) => go(href, true),
    replace: (href) => go(href, false),
    refresh: () => dispatch({ type: "refresh" }),
    back: () => window.history.back(),
    forward: () => window.history.forward(),
    prefetch: () => {},
    state: () => mountedState!,
  });

  // app-router.js:273-320
  useEffect(() => {
    const originalPushState = window.history.pushState.bind(window.history);
    const originalReplaceState = window.history.replaceState.bind(window.history);
    const restore = (url: URL, historyState: AppHistoryState | undefined) => dispatch({ type: "restore", url, historyState });
    // Ensure the canonical URL in the Next.js Router is updated when the URL is changed.
    const applyUrlFromHistoryPushReplace = (url: string | URL) => {
      const href = window.location.href;
      const appHistoryState = (window.history.state as NextHistoryState | null)?.__PRIVATE_NEXTJS_INTERNALS_TREE;
      restore(new URL(url ?? href, href), appHistoryState);
    };
    window.history.pushState = function pushState(data: NextHistoryState | null, unused: string, url?: string | URL | null) {
      // Avoid a loop when Next.js internals trigger pushState/replaceState
      if (data?.__NA || data?._N) return originalPushState(data, unused, url);
      data = copyNextJsInternalHistoryState(data);
      if (url) applyUrlFromHistoryPushReplace(url);
      return originalPushState(data, unused, url);
    };
    window.history.replaceState = function replaceState(data: NextHistoryState | null, unused: string, url?: string | URL | null) {
      if (data?.__NA || data?._N) return originalReplaceState(data, unused, url);
      data = copyNextJsInternalHistoryState(data);
      if (url) applyUrlFromHistoryPushReplace(url);
      return originalReplaceState(data, unused, url);
    };
    // app-router.js:61-72
    const handlePopState = (popped: NextHistoryState | null) => {
      // "this case only happens when pushState/replaceState was called outside of Next.js"
      if (!popped) return;
      if (!popped.__NA) {
        window.location.reload();
        return;
      }
      restore(new URL(window.location.href), popped.__PRIVATE_NEXTJS_INTERNALS_TREE);
    };
    const onPopState = (event: PopStateEvent) => handlePopState(event.state as NextHistoryState | null);
    window.addEventListener("popstate", onPopState);
    return () => {
      window.history.pushState = originalPushState;
      window.history.replaceState = originalReplaceState;
      window.removeEventListener("popstate", onPopState);
    };
  }, []);

  return createElement(
    Fragment,
    null,
    createElement(HistoryUpdater, { appRouterState: state }),
    state.tree.page === "settings" ? children : createElement("main", null, createElement("h1", null, "Calendar")),
  );
}
