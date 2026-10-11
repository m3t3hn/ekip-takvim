# Configuration

Settings live in two places:

- **Environment variables** (`.env`): secrets, the app's address, and how the server runs. They're read when the container starts. After changing `.env`, run `docker compose up -d`, which recreates the container; `docker compose restart` doesn't pick up the change.
- **`config/app.yaml`** (optional): company-wide settings such as working hours and teams. The app re-reads it when it changes, without a restart.

People aren't configured anywhere. Everyone adds themselves by signing in with Google, then picks their own team, time zone and calendars.

## Environment variables

| Variable | Default | What it does |
|---|---|---|
| `GOOGLE_CLIENT_ID` | | The OAuth client from [Google setup](google-setup.md). Required for sign-in. |
| `GOOGLE_CLIENT_SECRET` | | Its secret. Required for sign-in. |
| `SESSION_SECRET` | | 32 or more random characters (`openssl rand -base64 32`). It signs sessions and encrypts the stored Google access. Changing it signs everyone out, and they all have to sign in again. Required for sign-in. |
| `APP_URL` | | The address people open, e.g. `https://calendar.example.com`. Google sends people back to `APP_URL/auth/google/callback`. Cookies are https-only unless it starts with `http://`. Required for sign-in. |
| `TZ` | `UTC` in Docker | The team's time zone, used when the config doesn't set `timezone`. |
| `CONFIG_PATH` | `config/app.yaml` (`/app/config/app.yaml` in Docker) | Where the YAML config is. The file is optional, but one that `CONFIG_PATH` names must exist. |
| `CONFIG_YAML` | | The whole YAML config inline. It wins over the file. |
| `DATABASE_PATH` | `data/ekip-takvim.sqlite` (`/app/data/ekip-takvim.sqlite` in Docker) | The SQLite database. Keep it on a volume. |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` | | Turn on the [Cloudflare Access check](access-control.md#cloudflare-access). Set both or neither: with only one set, every request gets a `500`. |
| `BASIC_AUTH_USER`, `BASIC_AUTH_PASSWORD` | | Turn on [basic auth](access-control.md#basic-auth). Set both or neither: with only one set, every request gets a `500`. |
| `PORT`, `HOSTNAME` | `3000`, `0.0.0.0` | Where the server listens. In Docker that's inside the container. With `npm start`, `HOSTNAME` defaults to `127.0.0.1` (this machine only) and is only read from `.env`. |
| `DEMO_MODE` | | `true` runs the [demo](install.md#try-the-demo) with made-up people. It's ignored while Google sign-in is configured, and it never replaces a database real people have signed in to. |

Without the four sign-in variables the app still starts and shows whoever is already in the database, but nobody can sign in.

## The config file

Every key is optional. A typical file:

```yaml
timezone: Europe/Istanbul
working_hours: { start: 9, end: 18, days: [mon, tue, wed, thu, fri] }
timezones:
  - { label: London, zone: Europe/London }
  - { label: Istanbul, zone: Europe/Istanbul }
teams: [Design, Engineering, Product]
google_domain: example.com
```

| Key | Default | What it does |
|---|---|---|
| `timezone` | `TZ`, else UTC | The team's time zone, as an IANA name like `Europe/Istanbul` or `America/New_York`. Working hours are in it, and new people start in it when their Google Calendar has no zone. |
| `working_hours.start`, `working_hours.end` | `9`, `17` | Company hours, from 0 to 24. Fractions work: `9.5` is 09:30. Outside them the calendar is hatched as off-hours, and free time isn't searched there, unless someone turns on **Show off-hours**. |
| `working_hours.days` | `[mon, tue, wed, thu, fri]` | Working days, from `mon` to `sun`. |
| `working_hours.timezone` | `timezone` | Set it if the hours are kept in another zone. |
| `timezones` | the team's zone | Up to 6 `{ label, zone }` pairs: the clocks in the sidebar and the extra hour columns in the day view. Labels can be up to 20 characters. A viewer whose own zone isn't listed sees it added. |
| `teams` | none | The teams people can pick on **My settings**. They group the sidebar. |
| `google_domain` | none | Only Google accounts on this domain can sign in. See [Google setup](google-setup.md#4-allow-only-your-domain). |
| `refresh_minutes` | `10` | How often every calendar is read from Google, from 1 to 1440. |
| `horizon_days` | `60` | How many days ahead calendars are read, from 7 to 366. The past six weeks are always read too. |
| `display_hours` | `{ start: 8, end: 22 }` | The first and last hour of the day view, on the viewer's clock. Free time is only searched inside them. |
| `week_starts_on` | `monday` | Or `sunday`. |

When the file has a mistake (invalid YAML, an unknown time zone, hours that end before they start, a team listed twice), the app doesn't crash. It shows the problem instead of the calendar, the Status page lists it, and `/healthz` reports `"status":"degraded"`. Saving a fixed file applies it straight away.

## How time zones work

- **Viewers** always see times in their own zone. That's their browser's zone, unless they pick another in the sidebar; the choice is kept in their browser.
- **Working hours** are fixed in their own zone. In summer, a viewer in London sees 09:00–17:00 Istanbul time as 07:00–15:00, and the sidebar spells out both.
- **A person's zone** is set on **My settings** and starts as their Google Calendar's. It decides the local time shown next to their name, and in which zone their all-day events cover a whole day.
