# Privacy and security

## What the app asks Google for

- **Sign-in:** `openid`, `email` and `profile`, for each person's name, email address and Google account ID.
- **Calendars:** `calendar.readonly`. The app never creates, changes or deletes events. Invites are handed to Google Calendar's own page in the organiser's account, and the organiser saves them.
- **What it reads:** each person's list of calendars, and the events on the calendars they tick, from six weeks back to `horizon_days` ahead (60 by default). For calendars shared as *free/busy only*, Google gives busy times and nothing else. Attendee lists are never requested.

Apart from the [calendar links](#calendar-links) people add, the app talks to no one but Google.

## What's stored

Everything is in one SQLite database (`DATABASE_PATH`):

| What | Details |
|---|---|
| People | Name, email address, Google account ID, team, time zone, colour, and their Google access (a refresh token, encrypted with AES-256-GCM under a key derived from `SESSION_SECRET`). |
| Calendars | ID, name, the label the person gave it, whether it counts, and its sync state. For a calendar link: the link, encrypted the same way as the Google access; its host, as the calendar's name; and what the calendar's server said about the version last read (`ETag`, `Last-Modified`). |
| Busy times | Start and end, tentative, all-day. For calendars shared with full details, also the event's title, description, place, meeting link, link to Google Calendar, and whether it's private. For a calendar link, also the title, description and place, and whether the event is private. |

The access tokens Google gives for a refresh token are kept in the server's memory only, for up to their hour, and are never stored or logged.

Event titles and details are stored as plain text, so treat the database and its backups as confidential. **Remove me** on *My settings* deletes everything about that person, calendar links included, and gives the Google access back. Removing a calendar link deletes it and its events.

## Who sees what

The server decides what each viewer gets. Titles and details a viewer may not see never reach their browser.

| Event | Its owner | Signed-in colleagues | Not signed in |
|---|---|---|---|
| On their company calendar | Title | Title | Calendar label |
| On their company calendar, marked private | Title | Calendar label | Calendar label |
| On a personal calendar shared with their company account | Title | Calendar label | Calendar label |
| On a calendar link | Title | Calendar label | Calendar label |
| On a calendar shared as *free/busy only* | Calendar label | Calendar label | Calendar label |

The *company calendar* is the primary calendar of the account each person signs in with. Labels are shown to everyone who can open the app, so a label never holds an email address: one that does (Google names calendars after their owner's address) is replaced with *Work* or *Personal*. Where a title is visible, clicking the event shows its details. Calendar IDs and names only go to their owner, on their settings page. A calendar link never leaves the server: its owner sees its host, and everyone else its label.

With `EXPOSURE=internal` (the default), anyone who can open the app, signed in or not, sees names, teams, local times and busy times, each with its calendar label. That's why the app must then only be reachable by your team. With `EXPOSURE=exposed`, nothing is shown until someone signs in with a company account, and the *Not signed in* column above doesn't apply. See [access control](access-control.md).

## Calendar links

A calendar link is the secret address of a calendar that isn't on Google, which a person adds on *My settings* ([how](user-guide.md#calendar-links)). Its path and query are the secret: anyone who has them can read the calendar.

- **Kept on the server only.** The link is stored encrypted, like the Google access, and is never sent to a browser: its owner sees its host. It's never written to the log, and no error message holds it, on the settings page, the Status page or anywhere else. Changing `SESSION_SECRET` makes stored links unreadable: their calendars then fail with a message to add the link again.
- **Read at every sync, but no more than once every 10 minutes when syncs run more often** (`refresh_minutes` under 10, as by default), over the same six weeks back and `horizon_days` ahead as the Google calendars. Its owner signing in, saving *My settings* or pressing **Refresh from Google** reads it at once. A calendar's server that says nothing changed since the last read keeps the events read then, for the days read then: a link is read in full again once those days move on (a new day, or another `horizon_days` or `timezone`), and at least once a day.
- **The server fetches an address someone typed,** so with `CALENDAR_LINKS=on` (the default), before it connects:
  - only `http://`, `https://` and `webcal://` links, without a user name or password, are taken;
  - the host is looked up once, every address in the answer has to be on the public internet (not private, loopback, link-local, shared, documentation, benchmarking, multicast or reserved space, IPv4 or IPv6), and the connection goes to an address from that same answer, so a second lookup can't send it elsewhere;
  - each redirect, at most 5, is checked the same way;
  - the whole request has 20 seconds, the calendar can be at most 10 MB, and the answer has to be an iCalendar file.

  The request sends no cookies and no credentials. Each person can add up to 10 links.
- **`CALENDAR_LINKS=private`** drops the public-address check, for a calendar server on your own network such as a self-hosted Nextcloud. Then anyone who can sign in can make the server fetch addresses on its network. Whoever adds a link is its owner, so an address there that answers with an iCalendar file shows them its events in full: titles, descriptions and places. Errors such as *Couldn't reach that address* tell them what answers there. Use it only where everyone who can sign in may reach that network anyway. **`CALENDAR_LINKS=off`** turns links off: none can be added, and the ones already there are neither read nor counted.

## Sessions

- **Signing in** goes through Google. A one-time state cookie ties Google's answer to the browser that started the sign-in. With `google_domain` set, accounts from other domains are turned away.
- **The session cookie** is HttpOnly, SameSite=Lax and signed. It's https-only unless `APP_URL` starts with `http://`. It lasts 30 days and is tied to the person's Google account.
- **Signing out** ends that person's sessions on every device.
- **Losing Google access** also ends their sessions. That happens when someone removes the app in their Google account, or their account is suspended. The next sync notices.

## Running it safely

- **Keep it to your team** with a VPN, an access proxy or basic auth ([access control](access-control.md)).
- **Treat secrets carefully.** Keep `.env` readable only by the people who run the server. Keep a copy of `SESSION_SECRET` in your password manager, and keep it apart from database backups: together they give access to everyone's calendars, calendar links included.
- **Leave `CALENDAR_LINKS` at `on`** unless people need calendars on your own network ([calendar links](#calendar-links)), or set it to `off` if nobody needs them.
- **Never set `DEMO_MODE`** on a real install. It's ignored while Google sign-in is configured, and it never replaces a database people have signed in to, but leave it out anyway.
- **The container** runs as a non-root user, and nothing secret is baked into the image.

Found a problem? Please report it privately: see [SECURITY.md](../SECURITY.md).
