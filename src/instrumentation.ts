export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { ensureStarted } = await import("@/lib/server/sync");
  // Kick off the first sync without blocking server start-up.
  ensureStarted();
}
