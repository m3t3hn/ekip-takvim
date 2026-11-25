# Privacy and security

## What the app asks Google for

- **Sign-in:** `openid`, `email` and `profile`, for each person's name, email address and Google account ID.
- **Calendars:** `calendar.readonly`, to read them. Invites are handed to Google Calendar's own page in the organiser's account, and the organiser saves them.
- **Booked meetings:** `calendar.events`, only from people who allowed booking links (**Allow access** on *My settings*, with `BOOKING_LINKS=on`). The app writes to Google Calendar only for them, and only the meetings booked with them: it adds each one to their primary calendar, with the visitor invited, and deletes it when the booking is cancelled, or straight away when the booking couldn't be completed. It never changes or deletes any other event, and nobody else's calendar is ever written to.
- **What it reads:** each person's list of calendars, and the events on the calendars they tick, from six weeks back to `horizon_days` ahead (60 by default). For calendars shared as *free/busy only*, Google gives busy times and nothing else. Just before a booking's event is made, it also asks Google whether the host is free then, on their counted Google calendars. When a booked meeting's event is missing from a read, it asks for the status of that one event. Attendee lists are never requested.

Apart from the [calendar links](#calendar-links) people add, the app talks to no one but Google.

## What's stored

Everything is in one SQLite database (`DATABASE_PATH`):

| What | Details |
|---|---|
| People | Name, email address, Google account ID, team, time zone, colour, their Google access (a refresh token, encrypted with AES-256-GCM under a key derived from `SESSION_SECRET`), and whether they allowed booking links to add meetings to their Google Calendar. |
| Calendars | ID, name, the label the person gave it, whether it counts, and its sync state. For a calendar link: the link, encrypted the same way as the Google access; its host, as the calendar's name; and what the calendar's server said about the version last read (`ETag`, `Last-Modified`). |
| Busy times | Start and end, tentative, all-day. For calendars shared with full details, also the event's title, description, place, meeting link, link to Google Calendar, and whether it's private. For a calendar link, also the title, description and place, and whether the event is private. |
| Booking links | Each [booking link](#booking-links)'s title, description and rules, and whether it's on. Its address is a random token. |
| Bookings | The time, the link's title, and the visitor's name, email address and note. When it was cancelled. Not the cancel link itself, only its SHA-256 hash. Outside the demo, also the ID of the host's Google event, its calendar, and when it was made. |

The access tokens Google gives for a refresh token are kept in the server's memory only, for up to their hour, and are never stored or logged.

Event titles and details are stored as plain text, so treat the database and its backups as confidential. **Remove me** on *My settings* deletes everything about that person, calendar links, booking links and the bookings made with them included, and gives the Google access back. That's in the app: the events of the meetings booked with them stay in their Google Calendar, and they can delete them there. Removing a calendar link deletes it and its events.

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

## Booking links

With `BOOKING_LINKS=on`, a signed-in person can make [booking links](user-guide.md#booking-links). Anyone who has one can open its page without signing in, and book a time. Those pages pass the app's [access checks](access-control.md#booking-pages); nothing else does.

- **What visitors see:** the host's name, the link's title, description and length, whether it adds a Google Meet link, and the free times it offers, on their own clock. The free times come from the host's counted calendars and bookings, but no event title, calendar label, busy time, email address or other visitor's booking reaches the page. While the host's calendars can't be trusted (anything but OK under [who's counted](user-guide.md#whos-counted)), the link offers no times.
- **Full days:** a day the link offers with none of its times free is listed as *Fully booked*. So visitors can tell that the host's day is taken, but not why: by the link's bookings-per-day limit or by the host's events, which they never see. While the link offers no time at all, no day is listed, so the page can't tell a host who's busy every day from a link that offers nothing for another reason.
- **The link's address** holds a random token of 192 bits, so links can't be guessed. A link that doesn't exist, is off, or whose host left all answer the same.
- **The page's title** is in its HTML: for a link that can be booked, the link's title with the host's name, such as *Intro call with Zeynep Şahin*. So a chat app that previews the link (Slack, WhatsApp, Teams) fetches the page and shows the host's name and the link's title in the chat. A link that doesn't exist, is off, or whose host left keeps the general title, *Book a time · Ekip Takvim*, so a preview can't tell them apart.
- **What's stored about a visitor:** the name, email address and note they give, and the time they booked. In the app, the host sees them on *My settings*. They're never written to the log, and they're deleted from the app along with the host (**Remove me**). The meeting's event stays in the host's Google Calendar, with the visitor invited, and the host can delete it there.
- **What Google gets:** outside the demo, each booking is an event on the host's primary Google calendar, and Google emails the visitor an invitation. The event's title is the link's title with the visitor's name; its description is the link's description, the visitor's note and *Booked through Ekip Takvim.*; the visitor is its only guest, with their email address. So whoever can see the host's event details in Google Calendar sees them, and the event syncs back like any other: signed-in colleagues see its title and details, as for any event on the host's company calendar ([who sees what](#who-sees-what)). Google keeps the event until it's deleted, under Google's own terms. Before a host's links offer times, the host allows this once (**Allow access**). The demo sends nothing to Google.
- **Cancel links:** right after booking, the confirmation's own address becomes the booking's cancel link, `/book/cancel/…`, so the visitor keeps it or bookmarks the page, and it's still there after a reload. Anyone who has it can see the booking's title, time and host's name, and cancel it until its meeting ends. The server keeps only its SHA-256 hash, so the database can't give it back, and it's never written to the log. The booking pages send `Referrer-Policy: no-referrer` and load nothing from another site, so the address doesn't leave the browser in a `Referer` header. Browser history, bookmarks and synced tabs keep it as they keep any address. The host can also cancel a booking on *My settings*. Cancelling deletes the event, and Google tells the visitor; deleting the event in Google Calendar cancels the booking at the next sync. A meeting that took place can't be cancelled, and its event stays.
- **The cancel link isn't in the event.** It would be in the event's description, which colleagues who can see the host's event details see too, and the sync would store it with the event, where the database keeps only its hash. So the visitor has it only as the confirmation page's address. A visitor who lost it can decline the invitation; the host then cancels the booking, or deletes the event.
- **Limits:** a visitor's name can be up to 100 characters, an email address 254 and a note 500. Booking has two limits:
  - 5 tries per 10 minutes from one address, whatever they answer, counted in memory, so a restart clears them. Past it, a try answers *Too many tries* with how many minutes to wait;
  - 30 bookings an hour on one link, from anyone, cancelled ones included, counted from the database. Tries that book nothing don't count toward it. Past it, the link says it's taking no more bookings for now.

  The app takes a visitor's address from Cloudflare's `CF-Connecting-IP` header when there is one, else from the last `X-Forwarded-For` entry, which your reverse proxy adds. So without Cloudflare in front, have the proxy drop a `CF-Connecting-IP` header that visitors send: `header_up -CF-Connecting-IP` in Caddy's `reverse_proxy`, `proxy_set_header CF-Connecting-IP "";` in nginx, or a Traefik headers middleware that sets it to empty ([how](access-control.md#reverse-proxy)). Otherwise a visitor can choose their own address and get around the limit per address; the limit per link still holds.
- **Search engines** are asked not to list booking pages.

## Sessions

- **Signing in** goes through Google. A one-time state cookie ties Google's answer to the browser that started the sign-in. With `google_domain` set, accounts from other domains are turned away.
- **The session cookie** is HttpOnly, SameSite=Lax and signed. It's https-only unless `APP_URL` starts with `http://`. It lasts 30 days and is tied to the person's Google account.
- **Signing out** ends that person's sessions on every device.
- **Losing Google access** also ends their sessions. That happens when someone removes the app in their Google account, or their account is suspended. The next sync notices, or the next booking or cancellation that needs their Google Calendar.

## Running it safely

- **Keep it to your team** with a VPN, an access proxy or basic auth ([access control](access-control.md)).
- **Treat secrets carefully.** Keep `.env` readable only by the people who run the server. Keep a copy of `SESSION_SECRET` in your password manager, and keep it apart from database backups: together they give access to everyone's calendars, calendar links included.
- **Leave `CALENDAR_LINKS` at `on`** unless people need calendars on your own network ([calendar links](#calendar-links)), or set it to `off` if nobody needs them.
- **Turn on `BOOKING_LINKS`** only when people need [booking links](#booking-links): their pages are open to anyone.
- **Never set `DEMO_MODE`** on a real install. It's ignored while Google sign-in is configured, and it never replaces a database people have signed in to, but leave it out anyway.
- **The container** runs as a non-root user, and nothing secret is baked into the image.

Found a problem? Please report it privately: see [SECURITY.md](../SECURITY.md).
