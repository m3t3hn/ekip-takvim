# Access control

Ekip Takvim shows everyone's busy times to anyone who can open it, without signing in. That's on purpose: checking who's free shouldn't need a login. Signing in is for adding yourself, and for seeing the titles of colleagues' company-calendar events. So the address must be reachable only by your team. Pick one of these:

| Option | Good for | What it takes |
|---|---|---|
| [VPN](#vpn) | Teams that already have one | A hostname that only resolves on the VPN |
| [Cloudflare Access](#cloudflare-access) | Using it from anywhere, phones included, behind your company login | A domain on Cloudflare |
| [Basic auth](#basic-auth) | Small teams with neither | Two settings, and one shared password |
| Your own access proxy | Teams that already run oauth2-proxy, Authelia, Authentik, Pomerium or Tailscale | Put it in front, like any other app |

Whichever you pick, the app needs HTTPS: Google only sends people back to `https://` addresses, apart from `http://localhost`. Set `APP_URL` to that address.

## Reverse proxy

`compose.yaml` makes the app listen on `127.0.0.1:3000`, so only the server itself can reach it. Put a reverse proxy on the same server in front of it. The app builds its links from `APP_URL`, so the proxy needs no special headers.

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
