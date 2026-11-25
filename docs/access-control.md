# Access control

By default (`EXPOSURE=internal`), Ekip Takvim shows everyone's busy times to anyone who can open it, without signing in: checking who's free shouldn't need a login. Signing in is for adding yourself, and for seeing the titles of colleagues' company-calendar events. So the address must be reachable only by your team. Pick one of these:

| Option | Good for | What it takes |
|---|---|---|
| [Exposed](#exposed-sign-in-for-everything) (`EXPOSURE=exposed`) | Using it from anywhere, with nothing in front of it | One setting: every page then needs a company Google sign-in |
| [VPN](#vpn) | Teams that already have one | A hostname that only resolves on the VPN |
| [Cloudflare Access](#cloudflare-access) | Using it from anywhere, phones included, behind your company login | A domain on Cloudflare |
| [Basic auth](#basic-auth) | Small teams with neither | Two settings, and one shared password |
| Your own access proxy | Teams that already run oauth2-proxy, Authelia, Authentik, Pomerium or Tailscale | Put it in front, like any other app |

Whichever you pick, the app needs HTTPS: Google only sends people back to `https://` addresses, apart from `http://localhost`. Set `APP_URL` to that address.

[Booking links](user-guide.md#booking-links) are the one exception: with `BOOKING_LINKS=on`, their pages are for anyone. See [booking pages](#booking-pages) for what to open.

## Exposed: sign-in for everything

Set `EXPOSURE=exposed` in `.env` and run `docker compose up -d`. The app can then sit on the open internet:

- **Signing in:** Every page needs a sign-in with a company Google account. People who aren't signed in land on a sign-in page, and the API answers `401`. Only the sign-in routes, `/healthz`, the icons and the manifest stay open, and the [booking pages](#booking-pages) while `BOOKING_LINKS=on`.
- **Joining:** Signing in also asks for read access to the person's calendars. Anyone who signs in to look joins the team calendar; that's the point, but say so when you invite people.
- **Requirements:** `google_domain` must be set in `config/app.yaml`, and `APP_URL` must be `https://` (`http://localhost` is allowed for trying it out). Without them the app serves nothing and logs why, so no account from another domain can get in, and the session cookie never travels in the clear.

The app sends the usual hardening headers on every response: HSTS, no framing by other sites, `nosniff` and a strict referrer policy. With an *Internal* OAuth client ([Google setup](google-setup.md)), Google itself also keeps out accounts outside your Workspace.

## Reverse proxy

`compose.yaml` makes the app listen on `127.0.0.1:3000`, so only the server itself can reach it. Put a reverse proxy on the same server in front of it. The app builds its links from `APP_URL`, so the proxy needs no special headers for them.

One header matters for [booking pages](#booking-pages): the app limits booking tries per visitor address, and takes a visitor's address from Cloudflare's `CF-Connecting-IP` header when there is one, else from the last `X-Forwarded-For` entry. So without Cloudflare in front, have the proxy drop a `CF-Connecting-IP` header that visitors send:

- **Caddy:** `header_up -CF-Connecting-IP` inside `reverse_proxy 127.0.0.1:3000 { … }`.
- **nginx:** `proxy_set_header CF-Connecting-IP "";` next to the other `proxy_set_header` lines.
- **Traefik:** a headers middleware that sets `CF-Connecting-IP` to empty, with the labels `traefik.http.middlewares.ekip-takvim-ip.headers.customrequestheaders.CF-Connecting-IP=` and `traefik.http.routers.ekip-takvim.middlewares=ekip-takvim-ip`.

Otherwise a visitor can choose their own address and get around the limit per address. The limit per link, 30 bookings an hour, still holds. With Cloudflare in front, leave the header alone: it's how the app tells visitors apart.

### Caddy

Caddy gets and renews the certificate on its own:

```caddy
calendar.example.com {
	reverse_proxy 127.0.0.1:3000
}
```

### nginx

```nginx
server {
    listen 443 ssl;
    server_name calendar.example.com;
    ssl_certificate     /etc/letsencrypt/live/calendar.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/calendar.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

### Traefik

When Traefik runs in Docker, join its network instead of publishing a port. Put this in `compose.override.yaml` next to `compose.yaml`; Compose merges the two automatically, and `compose.yaml` stays untouched for upgrades:

```yaml
services:
  ekip-takvim:
    ports: !reset []
    networks: [traefik]
    labels:
      - traefik.enable=true
      - traefik.http.routers.ekip-takvim.rule=Host(`calendar.example.com`)
      - traefik.http.routers.ekip-takvim.entrypoints=websecure
      - traefik.http.routers.ekip-takvim.tls.certresolver=letsencrypt
      - traefik.http.services.ekip-takvim.loadbalancer.server.port=3000

networks:
  traefik:
    external: true
```

Use your own network, entrypoint and certificate resolver names. `!reset` needs Docker Compose 2.24 or newer.

## VPN

- **DNS:** give the app a hostname that only resolves on the VPN, through your VPN's DNS or a public record that points to a private IP.
- **Certificates:** a certificate for an internal-only name comes from a DNS challenge. Caddy, Traefik and certbot all support one with a plugin for your DNS provider.
- **Firewall:** check that the server doesn't accept connections from the internet on that port.

## Cloudflare Access

Cloudflare Access (part of Zero Trust) asks people to sign in, for example with your Google Workspace, before it lets them through.

1. **Create an Access application.** In Cloudflare Zero Trust, add a *self-hosted* application for `calendar.example.com`. Give it a policy that lets in your team, for example emails ending in `@example.com`.
2. **Send the traffic through Cloudflare.** A [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) needs no open ports on the server. A proxied DNS record works too.
3. **Stop anyone getting around Access.** Without this step, someone who reaches the server directly, by its IP or from inside your network, skips Access entirely. Have the app check Access's token by adding to `.env`:
   ```bash
   CF_ACCESS_TEAM_DOMAIN=your-team.cloudflareaccess.com
   CF_ACCESS_AUD=…   # the application's "Application Audience (AUD) Tag", on its overview page
   ```
   Then run `docker compose up -d`.

With the check on:
- Only requests that carry a valid Access token for this application get in. The app checks the token against Cloudflare's published keys.
- Everything else gets `403 Open this app through Cloudflare Access`. Rejected tokens are logged with the reason (`"scope":"access"`).
- `/healthz`, the icons and the web manifest stay open; nothing about anyone is in them. Docker's own health check runs inside the container and isn't affected.
- Google's redirect back to `/auth/google/callback` happens in a browser that has already passed Access, so it needs no bypass rule.
- An uptime monitor outside your network needs a [service token](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/), or a bypass rule for `/healthz`.

## Basic auth

The simplest option when you have nothing else. Add to `.env`:

```bash
BASIC_AUTH_USER=team
BASIC_AUTH_PASSWORD=…   # long and random, e.g. openssl rand -base64 24
```

Then run `docker compose up -d`. The browser now asks for the username and password on every page, except `/healthz` and the icons. Only use it over HTTPS. Everyone shares the password, so change it when someone leaves.

## Booking pages

With `BOOKING_LINKS=on` ([configuration](configuration.md#environment-variables)), people can make [booking links](user-guide.md#booking-links) for anyone outside the team. Their pages are public:

- **What's open:** `/book/…`, the booking and cancel pages, and `/api/book/…`, what those pages load and send. They pass the app's own checks: the Cloudflare Access token, basic auth and the sign-in that `EXPOSURE=exposed` asks for. Every other address is checked as before, `/api/me/…` included.
- **What visitors get:** the host's name, the link's title, description and length, whether it's a Google Meet call, its free times, and which of its days are full. Never event titles, calendar labels, busy times, the host's email or anyone else's bookings. See [booking links](privacy-and-security.md#booking-links).
- **Search engines** are asked not to list them (`X-Robots-Tag: noindex`).
- **No Referer:** nothing those pages ask for carries their address (`Referrer-Policy: no-referrer`), as a cancel page's address is its booking's cancel link.
- **With `BOOKING_LINKS=off`** (the default), those addresses are checked like any other, and they answer `404`.

The start-up log says whether booking pages are public. What to open in front of the app, so visitors outside the team reach those two paths and nothing else:

- **Exposed, or the app's own basic auth:** nothing; the app already lets them through.
- **Cloudflare Access:** in Cloudflare Zero Trust, add a second self-hosted application on the same hostname for the paths `book/`, `api/book/` and `_next/static/`, with a *Bypass* policy for everyone. `_next/static/` holds the app's scripts, styles and fonts, which the pages need to load; nothing about anyone is in them. The app's own token check (`CF_ACCESS_TEAM_DOMAIN`) lets the booking paths through by itself.
- **VPN:** visitors aren't on it. Make the app's hostname also resolve publicly to a reverse proxy, or a Cloudflare Tunnel, that forwards only `/book/`, `/api/book/` and `/_next/static/` to the app and refuses the rest. Keep the same hostname as `APP_URL`: the links people copy and the cancel links visitors get use it.
- **Your own access proxy:** the same three paths, unauthenticated.
