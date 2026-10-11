// `npm run demo`: `next dev` with made-up people, no Google needed. The app
// fills a throwaway SQLite database (.demo-data/demo.sqlite) with the demo
// people, calendars and busy times on start — see src/lib/server/demo.ts.
// DEMO_HOST and DEMO_APP_PORT (from the environment or .env) move it.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

// Shell variables win over .env.
if (existsSync(".env")) process.loadEnvFile(".env");
const host = process.env.DEMO_HOST || "localhost";
const port = process.env.DEMO_APP_PORT || "3000";

const next = spawn("npx", ["next", "dev", "--hostname", host, "--port", port, ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: {
    ...process.env,
    DEMO_MODE: "true",
    CONFIG_PATH: "config/app.demo.yaml",
    DATABASE_PATH: ".demo-data/demo.sqlite",
    // The demo never talks to Google, whatever .env says.
    GOOGLE_CLIENT_ID: "",
    GOOGLE_CLIENT_SECRET: "",
    APP_URL: "",
  },
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => next.kill(signal));
}
next.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
