# Privacy and security

## What the app asks Google for

- **Sign-in:** `openid`, `email` and `profile`, for each person's name, email address and Google account ID.
- **Calendars:** `calendar.readonly`. The app never creates, changes or deletes events. Invites are handed to Google Calendar's own page in the organiser's account, and the organiser saves them.
- **What it reads:** each person's list of calendars, and the events on the calendars they tick, from six weeks back to `horizon_days` ahead (60 by default). For calendars shared as *free/busy only*, Google gives busy times and nothing else. Attendee lists are never requested.

The app talks to no one but Google.

## What's stored

Everything is in one SQLite database (`DATABASE_PATH`):

| What | Details |
|---|---|
| People | Name, email address, Google account ID, team, time zone, colour, and their Google access (a refresh token, encrypted with AES-256-GCM under a key derived from `SESSION_SECRET`). |
| Calendars | ID, name, the label the person gave it, whether it counts, and its sync state. |
| Busy times | Start and end, tentative, all-day. For calendars shared with full details, also the event's title, description, place, meeting link, link to Google Calendar, and whether it's private. |

Event titles and details are stored as plain text, so treat the database and its backups as confidential. **Remove me** on *My settings* deletes everything about that person, and gives the Google access back.

## Who sees what

The server decides what each viewer gets. Titles and details a viewer may not see never reach their browser.

| Event | Its owner | Signed-in colleagues | Not signed in |
|---|---|---|---|
| On their company calendar | Title | Title | Calendar label |
| On their company calendar, marked private | Title | Calendar label | Calendar label |
| On a personal calendar shared with their company account | Title | Calendar label | Calendar label |
| On a calendar shared as *free/busy only* | Calendar label | Calendar label | Calendar label |

The *company calendar* is the primary calendar of the account each person signs in with. Labels are shown to everyone who can open the app, so a label never holds an email address: one that does (Google names calendars after their owner's address) is replaced with *Work* or *Personal*. Where a title is visible, clicking the event shows its details. Calendar IDs and names only go to their owner, on their settings page.

Anyone who can open the app, signed in or not, sees names, teams, local times and busy times, each with its calendar label. That's why the app must only be reachable by your team: see [access control](access-control.md).

## Sessions

- **Signing in** goes through Google. A one-time state cookie ties Google's answer to the browser that started the sign-in. With `google_domain` set, accounts from other domains are turned away.
- **The session cookie** is HttpOnly, SameSite=Lax and signed. It's https-only unless `APP_URL` starts with `http://`. It lasts 30 days and is tied to the person's Google account.
- **Signing out** ends that person's sessions on every device.
- **Losing Google access** also ends their sessions. That happens when someone removes the app in their Google account, or their account is suspended. The next sync notices.

## Running it safely

- **Keep it to your team** with a VPN, an access proxy or basic auth ([access control](access-control.md)).
- **Treat secrets carefully.** Keep `.env` readable only by the people who run the server. Keep a copy of `SESSION_SECRET` in your password manager, and keep it apart from database backups: together they give access to everyone's calendars.
- **Never set `DEMO_MODE`** on a real install. It's ignored while Google sign-in is configured, and it never replaces a database people have signed in to, but leave it out anyway.
- **The container** runs as a non-root user, and nothing secret is baked into the image.

Found a problem? Please report it privately: see [SECURITY.md](../SECURITY.md).
