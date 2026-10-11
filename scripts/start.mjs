// `npm start`: runs the production build (`npm run build` first) the way the
// Docker image does, from Next.js's standalone output, with `.env` loaded.
// Shell variables win over .env. The database and config paths are relative
// to this folder, as with `npm run dev`.
import { spawn } from "node:child_process";
import { cpSync, existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const out = ".next/standalone";
if (!existsSync(`${out}/server.js`)) {
  console.error("No production build yet: run `npm run build` first.");
  process.exit(1);
}
// The standalone server serves these from its own folder.
cpSync(".next/static", `${out}/.next/static`, { recursive: true });
if (existsSync("public")) cpSync("public", `${out}/public`, { recursive: true });

const fileEnv = existsSync(".env") ? parseEnv(readFileSync(".env", "utf8")) : {};
const env = {
  NODE_ENV: "production",
  ...fileEnv,
  ...process.env,
  // Only this machine can connect (put a reverse proxy in front) unless .env
  // sets HOSTNAME. A HOSTNAME from the shell is the machine's name, not an address.
  HOSTNAME: fileEnv.HOSTNAME || "127.0.0.1",
};

const server = spawn(process.execPath, [`${out}/server.js`], { stdio: "inherit", env });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.kill(signal));
}
server.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
