# Development

You need Node.js 22.13 or newer. CI and the Docker image use 24, and `nvm use` picks it up from `.nvmrc`.

```bash
npm ci
npm run demo
```

## Commands

| Command | What it does |
|---|---|
| `npm run demo` | Dev server with the demo database at http://localhost:3000. No Google needed. |
| `npm run dev` | Dev server with your own `.env`, config and database |
| `npm test` | Vitest: config, database, sessions, Google event rules, interval maths, invites, Access tokens |
| `npm run lint` | ESLint |
| `npm run typecheck` | Generates Next.js route types, then runs `tsc` |
| `npm run build` | Production build (Next.js standalone output) |
| `npm start` | Runs the production build like the Docker image does, with `.env` loaded |
| `docker compose -f compose.demo.yaml up --build` | The production image, running the demo |

## The demo

`npm run demo` fills a throwaway database (`.demo-data/demo.sqlite`) with six made-up people from `src/lib/server/demo.ts`, the way real sign-ins and syncs would, and starts from scratch every time. **Sign in (demo)** at the top right lets you be any of them.

The demo is built so that every case shows up somewhere:
- **Finding time:** days with and without a shared free slot, and "almost works" suggestions.
- **Kinds of events:** a tentative meeting, single-day and two-day out-of-office, an overnight shift, evening and weekend events, and a skipped and a moved occurrence of a recurring meeting.
- **Kinds of people:** someone free all day and someone busy all day, people in three time zones, and a person with no team.
- **Calendars:** one shared as free/busy only, calendars that don't count, one that fails to sync, and a person whose Google access lapsed.

The day-by-day plan is at the top of `src/lib/server/demo.ts`. `DEMO_HOST` and `DEMO_APP_PORT` move the demo server, e.g. `DEMO_APP_PORT=3100 npm run demo`.

## Against real Google calendars

1. Create an OAuth client as in [Google setup](google-setup.md), with the redirect URI `http://localhost:3000/auth/google/callback`.
2. Run:
   ```bash
   cp .env.example .env              # GOOGLE_*, SESSION_SECRET, APP_URL=http://localhost:3000
   cp config/app.example.yaml config/app.yaml
   npm run dev
   ```

The database is `data/ekip-takvim.sqlite`. Both it and `config/app.yaml` are git-ignored.

## How it works

- **The app:** a Next.js app (App Router), running as one Node.js process.
- **Sync** (`src/lib/server/sync.ts`): starts with the server (`src/instrumentation.ts`). Every `refresh_minutes` it reads each person's ticked calendars from Google with their own refresh token, and stores their busy times in SQLite (`node:sqlite`, `src/lib/server/db.ts`).
- **The views** ask `/api/availability` for busy blocks per person. The server decides which titles each viewer may see (`mayShowTitle`).
- **Free-time maths** run in the browser and are shared by every view: free time, shared slots and "almost works" (`src/lib/availability.ts`, `src/lib/intervals.ts`).
- **Sign-in** (`src/app/auth/*`, `src/lib/server/google.ts`) is a standard OAuth code flow. Refresh tokens are encrypted, and sessions are signed cookies checked against the database (`src/lib/server/secrets.ts`, `src/lib/server/viewer.ts`).
- **Access checks** (`src/proxy.ts`): the optional Cloudflare Access token check and basic auth run before any page or API.

```
src/
  app/               pages, /settings, /auth/* (sign-in), /api/*, /healthz, icons, manifest
  components/        the calendar UI: views, time grid, sidebar, settings, dialogs
  lib/
    availability.ts  free/busy maths shared by all views
    intervals.ts     interval merge, subtract and intersect
    time.ts          time-zone-safe day helpers
    invite.ts        Google Calendar and Outlook links, .ics files
    server/          server only: config, database, Google, sync, sessions, demo data, Access check
  instrumentation.ts starts the sync loop
  proxy.ts           optional Cloudflare Access check and basic auth
scripts/             demo, backup and restore
config/              example and demo config
test/                Vitest
```

This project uses Next.js 16, which differs from older versions in places. [AGENTS.md](../AGENTS.md) points to the docs that ship with it.

## Conventions

- **Commits and PR titles** follow [Conventional Commits](https://www.conventionalcommits.org/): `feat(ui): …`, `fix(sync): …`, `docs: …`.
- **Text in the UI** is plain and short, in English.
- **Changes people would notice** go in `CHANGELOG.md`, under *Unreleased*.
