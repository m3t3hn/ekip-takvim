# Install

Ekip Takvim is one container with a SQLite database inside a Docker volume. To run it for your team you need:

- **A server with Docker and Docker Compose:** any small Linux machine, amd64 or arm64. Half a gigabyte of RAM is plenty.
- **A Google OAuth client.** Creating one takes about ten minutes: see [Google setup](google-setup.md).
- **An HTTPS address for the app,** such as `calendar.example.com`, served through a reverse proxy. Google only sends people back to `https://` addresses, apart from `http://localhost`.
- **A way to keep the app to your team:** a VPN, Cloudflare Access or basic auth. Anyone who can open the app can see everyone's busy times without signing in. See [access control](access-control.md).

Just want to look around first? [Try the demo](#try-the-demo).

## With Docker Compose

1. **Get the code** at the latest release:
   ```bash
   git clone --branch v1.0.0 https://github.com/m3t3hn/ekip-takvim.git
   cd ekip-takvim
   ```
2. **Create the Google OAuth client** as in [Google setup](google-setup.md), with the redirect URI `https://calendar.example.com/auth/google/callback` (your address).
3. **Create `.env`** and fill in the four required values:
   ```bash
   cp .env.example .env
   ```
   ```bash
   GOOGLE_CLIENT_ID=…apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=…
   SESSION_SECRET=…     # the output of: openssl rand -base64 32
   APP_URL=https://calendar.example.com
   ```
   Keep a copy of `SESSION_SECRET` in your password manager. Restoring a backup needs it.
4. **Optionally, write a config.** Set the team's time zone, working hours, teams, and which Google domain can sign in:
   ```bash
   cp config/app.example.yaml config/app.yaml
   ```
   Without it the defaults apply: UTC (or `TZ` from `.env`), 9:00 to 17:00 on weekdays, no teams, and any account your OAuth client accepts. Every key is in [configuration](configuration.md).
5. **Start it.** The first build takes a few minutes.
   ```bash
   docker compose up -d --build
   ```
6. **Check that it's up:**
   ```bash
   curl http://localhost:3000/healthz
   docker compose logs ekip-takvim
   ```
   `/healthz` should say `"status":"ok"`. The log's `starting` line shows the version, where the config came from, whether sign-in is set up, and which access checks are on.
7. **Put your reverse proxy in front** and choose how access is limited ([access control](access-control.md)).
8. **Open the address and sign in.** You'll see *No one has signed in yet* until the first person does. Then send the team the [user guide](user-guide.md#adding-yourself).

### What lives where

| What | Where |
|---|---|
| Database | The `data` Docker volume (`/app/data` in the container). Back it up as in [Backup and restore](backup-and-restore.md). |
| Config | `config/app.yaml`, optional, mounted read-only. The app re-reads it when it changes. |
| Secrets | `.env`. Re-read only when the container is recreated (`docker compose up -d`). |

The app listens on `127.0.0.1:3000`, so only the server itself can reach it, and your reverse proxy forwards to it. If the proxy runs in Docker, see the [Traefik example](access-control.md#traefik) for joining its network instead.

Prefer a folder over the volume? Replace `data:/app/data` with `./data:/app/data` in `compose.yaml`, and give the folder to the container's user first: `mkdir data && sudo chown 1000:1000 data`.

## Try the demo

Six made-up people with two jobs each, no Google account needed:

```bash
git clone https://github.com/m3t3hn/ekip-takvim.git
cd ekip-takvim
docker compose -f compose.demo.yaml up --build
```

Open http://localhost:3000 and use **Sign in (demo)** at the top right to be one of them. Every start begins from scratch. With Node.js installed, `npm ci && npm run demo` does the same without Docker.

## From source, without Docker

You need Node.js 22.13 or newer; 24 is what the Docker image uses.

```bash
npm ci
cp .env.example .env              # fill it in
cp config/app.example.yaml config/app.yaml   # optional
npm run build
npm start
```

`npm start` runs the build the same way the Docker image does, with `.env` loaded:
- it listens on `127.0.0.1:3000`, this machine only (set `PORT` or `HOSTNAME` in `.env` to change that);
- the database goes to `data/ekip-takvim.sqlite`;
- the config is read from `config/app.yaml`.

Keep the process running with systemd or a similar service manager, and put the reverse proxy in front as above.
