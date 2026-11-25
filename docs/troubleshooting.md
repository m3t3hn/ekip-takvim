# Troubleshooting

Start with the logs:

```bash
docker compose logs -f ekip-takvim
```

Logs are JSON lines. The `starting` line shows:
- the version,
- where the config came from,
- whether sign-in is set up,
- which access checks are on, where calendar links may go (`CALENDAR_LINKS`), and whether booking pages are public (`BOOKING_LINKS`).

The **Status** page in the app shows each calendar's sync state and errors.

![The Status page: when the last sync ran, how many calendars are OK, and each calendar's state](screenshots/status.png)

## Signing in

**Google says `redirect_uri_mismatch`.**
The OAuth client's redirect URI must be exactly `APP_URL` followed by `/auth/google/callback`: same `https`, host and port, and no trailing slash. Fix whichever side is wrong. After changing `.env`, run `docker compose up -d`.

**Google says the app can only be used within its organisation (`org_internal`).**
The client is *Internal*, and the account isn't in your Google Workspace. Sign in with your company account.

**"Only company Google accounts can sign in."**
`google_domain` is set, and the account isn't on that domain. Personal Gmail accounts can never pass this check.

**"That sign-in took too long or came from another tab."**
The sign-in has to end in the same browser, at the same address, where it started. This usually means people open the app at one address (an IP, or another hostname) while `APP_URL` says another. Open it at the `APP_URL` address.

**"Google sign-in isn't set up on this server."**
One of `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` or `SESSION_SECRET` is missing, or `SESSION_SECRET` is shorter than 32 characters. The `starting` log line says *not set up*.

**"Google sign-in didn't work."**
The log has a `sign-in failed` line with Google's reason. It's usually a wrong client secret.

**Signing in works, but you're signed out again straight away.**
The browser isn't keeping the session cookie. The cookie is https-only unless `APP_URL` starts with `http://`, so open the app over HTTPS at the `APP_URL` address. For a quick test on your own machine, `APP_URL=http://localhost:3000` works.

## Calendars

**A calendar is missing from My settings.**
Share it with your company account, and accept it there: press **Add this calendar** in the email Google sends ([how](user-guide.md#adding-yourself)). Then press **Refresh from Google** on *My settings*.

**Someone shows "Needs to sign in".**
Their Google access ended: they removed the app in their Google account, their password or account changed, or the OAuth client is *External* and still in testing, where access lasts 7 days. They sign in again.

**Someone shows "No recent data", or a calendar fails on the Status page.**
The Status page shows Google's reason. Usually the calendar is no longer shared with their company account. Until it's read again, it keeps its last good copy.

**Times look off by a few hours.**
Check the team's `timezone` (or `TZ`) and each person's zone on *My settings*. Viewers always see their browser's zone, unless they picked another clock in the sidebar.

## Calendar links

Adding a [calendar link](user-guide.md#calendar-links) that can't be read shows why, under the form. A link that stops working later shows why on *My settings* and the Status page, and its calendar keeps its last good copy. In the log, the `calendar link failed` line names the person and the calendar's label, never the link.

| Message | What it means |
|---|---|
| That doesn't look like a calendar link. | It isn't an `https://`, `http://` or `webcal://` address, it holds a user name or password, it's longer than 2048 characters, or it redirects to such an address. Copy it again from the calendar's service. |
| That link points to a private network address, which this server doesn't allow. | The host is, or looks up to, an address on a private or local network. To allow those, the server needs `CALENDAR_LINKS=private` ([configuration](configuration.md#environment-variables)). |
| Couldn't reach that address. | The host name doesn't exist, or the connection was refused or broke off. Check the link, or try again later. |
| The calendar took too long to answer. | No full answer within 20 seconds. Try again later. |
| That calendar is too big. | It's over 10 MB. |
| That link redirects too many times. | More than 5 redirects. |
| The link didn't work. It may have been reset; copy it again. | The calendar's server answered `401`, `403` or `404` when the link was added: usually the link was reset, or publishing or sharing was stopped. Copy the current link from the calendar's service and add it. |
| The link didn't work. It may have been reset: remove this calendar and add the new link. | The same answer, for a link already added, when it's read again. A calendar can't take a new link: copy the current link, then remove the calendar and add the new link. |
| The calendar's server answered 500. | Or another number: the HTTP status it answered, other than `401`, `403` and `404`. Usually a passing problem on that server. |
| That address didn't return a calendar. | The answer wasn't an iCalendar file, often a web page: a sign-in page, or the calendar's page for browsers rather than its ICS link. |
| Couldn't read that calendar. | It starts like a calendar but can't be read as one. |
| This server's secret changed, so the stored link can't be read. Remove this calendar and add its link again. | `SESSION_SECRET` changed, and the link was stored with the old one. Do as it says. |
| This server doesn't take calendar links. | `CALENDAR_LINKS` is `off`, or something other than `on`, `private` or `off`. In the demo, it isn't set. |
| You can add up to 10 calendar links. Remove one first. | The limit per person. |

Known limits:
- **A declined invitation still counts as busy** when the calendar's file lists it: the app doesn't read who declined.
- **Extra dates (`RDATE`) and "this and following" changes (`RANGE=THISANDFUTURE`) aren't read.** Dates added to a repeating event outside its rule don't count, and a change the file gives as one change to an occurrence and all after it only moves that one occurrence.

## Booking links

What visitors of a [booking link](user-guide.md#booking-links) can be told:

| Message | What it means |
|---|---|
| This booking link doesn't exist or was turned off. | The address is wrong or cut short, the host turned the link off or deleted it, the host left, or `BOOKING_LINKS` isn't `on`. |
| No free times right now. Try again later. | The link offers no time at all: every day it offers is full, by its bookings-per-day limit or the host's events, every time is sooner than its notice allows, the host's calendars can't be trusted right now (anything but OK under [who's counted](user-guide.md#whos-counted)), the host hasn't pressed **Allow access** on *My settings*, or the link took 30 bookings in the last hour, cancelled ones included, until the oldest of them is an hour old. Then no day is listed, full or not. |
| Fully booked | Shown on a day, among days that have free times: the link offers that day, but none of its times is free, because the day reached the link's bookings-per-day limit or the host is busy. The page doesn't say which. |
| That time was just taken. Pick another. | Someone booked it first, or it stopped being offered while the visitor was filling in the form: an event on the host's calendars, or the minimum notice. Or, just before booking, Google said the host is busy then: an event added since the last sync. The page shows what's still free. The app then reads the host's calendars again straight away, so such a time soon stops being offered. |
| Too many tries. Try again in 7 minutes. | More than 5 tries in 10 minutes from one address, whatever they answered. The minutes are the real wait rounded up, the answer carries `Retry-After` in seconds, and the page keeps **Book** off until then, counting down. Behind a reverse proxy, check that it passes the visitor's address in `X-Forwarded-For` ([access control](access-control.md#reverse-proxy)); otherwise everyone shares one address. |
| This booking link is taking no more bookings for now. Try again in an hour. | The link took 30 bookings in the last hour, from anyone, cancelled ones included. It takes bookings again once the oldest of them is an hour old. Nothing was booked. |
| This booking link can't take bookings right now. | Google couldn't make the host's event: it couldn't be reached, didn't answer within 20 seconds, or refused. Nothing was booked. The log's `booking event not made` line names the host's ID, the step (`token`, `free/busy` or `insert`) and Google's error. If Google said the host's access ended, they show *Needs to sign in* and sign in again. If Google said the permission is missing, *My settings* asks them to **Allow access** again. |
| An invitation is on its way to … | Not a problem: Google emails the visitor an invitation to the host's event. If it doesn't arrive, it may be in their spam folder; the booking stands either way. |
| Google Meet video call: the link comes with your invitation. | Not a problem: the link adds a Google Meet link, so the event has one, and Google's invitation shows it. The page's header says *Google Meet video call* too. In the demo nothing is sent, so the confirmation doesn't say it. |
| Give your name, up to 100 characters. | Or *Give a valid email address.*, *Keep the note to 500 characters.*: what the visitor typed doesn't fit. |
| No booking matches this cancel link. | The cancel link is wrong or cut short, the host left, or `BOOKING_LINKS` isn't `on`. |
| This meeting took place on … | Not a problem: the booking's meeting has ended, so its cancel link shows that instead of **Cancel booking**. |
| This meeting has ended, so it can't be cancelled. | It ended while the page was open. A meeting that took place can't be cancelled, by its cancel link or by the host on *My settings*, who gets this message too, and its event stays in the host's Google Calendar. |
| Couldn't cancel right now. Try again in a few minutes. | Google couldn't delete the booking's event, so the booking stands. The log's `booking event not deleted` line names the host's ID and Google's error. If the host's access ended, it works again once they sign in again. If it keeps failing, the visitor can decline the invitation, and the host then cancels the booking. |

And the host, on *My settings*:

| Message | What it means |
|---|---|
| Booking links add each booked meeting to your Google Calendar … Allow access | The host hasn't allowed booked meetings in their Google Calendar yet, unticked it on Google's screen, removed the app in their Google account, or Google has since said the permission is missing when adding or deleting an event. Until they press **Allow access** and tick *View and edit events on all your calendars* on Google's screen, their links offer no times. |
| Done: your booking links can take bookings. | Not a problem: shown once after **Allow access**, when Google gave the permission. |
| Google didn't give the permission. Press Allow access again and tick View and edit events on all your calendars. | Shown once after **Allow access**: on Google's screen, that box was left unticked, so the links still offer no times. Do as it says. |
| Access wasn't allowed. Nothing changed. | Shown once after **Allow access**: it was cancelled on Google's screen, or Google turned it down there. Press **Allow access** to try again. |
| You can have up to 10 booking links. Delete one first. | The limit per person. |
| Give the link a title, up to 80 characters. | Or another field that doesn't fit, such as *The hours must be at least as long as a meeting.* or *Offer times 1 to 60 days ahead.* (up to `horizon_days`). |
| Booking links are off on this server. | `BOOKING_LINKS` was turned off since the page was opened. |
| Couldn't cancel right now. Try again in a few minutes. | As for the visitor: Google couldn't delete the event, so the booking stands. If *My settings* shows **Allow access**, allow it, then cancel again. |
| This booking is still being made. Try again in a minute. | The visitor booked moments ago and Google is still adding the event. Cancel once it's done. |

When **Allow access** fails as a sign-in can, it also brings the host back to *My settings*, with sign-in's own message, such as *That sign-in took too long or came from another tab. Try again.* ([signing in](#signing-in)).

**A booking disappeared from Upcoming bookings.** Its event was deleted in Google Calendar, by the host or someone who can edit their calendar, so the next sync cancelled it and freed its time. Before it cancels a booking, the app checks with Google that the event was deleted. The log has a `bookings cancelled: their events were deleted in Google` line with the host's ID.

## The server

**Every page sends you to Sign in.**
`EXPOSURE=exposed` is set, so every page needs a sign-in. Sign in with your company Google account.

**The sign-in page says the app isn't set up correctly.**
With `EXPOSURE=exposed`, the app refuses to run without `google_domain` in the config and an `https://` `APP_URL`. The log's `config error` line says which one is missing.

**Every request answers `500 EXPOSURE must be internal or exposed`.**
`EXPOSURE` has another value. Set it to one of the two, or remove it.

**`/healthz` says `"status":"degraded"`.**
The config file has a mistake. The app and the Status page say what it is. Fix the file and save; no restart needed.

**Every request answers `500 Set both …`.**
Only one of a pair is set: `CF_ACCESS_TEAM_DOMAIN` with `CF_ACCESS_AUD`, or `BASIC_AUTH_USER` with `BASIC_AUTH_PASSWORD`. Set both, or remove both.

**Every request answers `403 Open this app through Cloudflare Access`.**
Either the request didn't come through Access, or the token is for another application. Look for `Cloudflare Access token rejected` in the log:
- `ERR_JWT_CLAIM_VALIDATION_FAILED` usually means a wrong `CF_ACCESS_AUD` or team domain;
- `ERR_JWKS_TIMEOUT` or `fetch failed` means the server can't reach your team's `cloudflareaccess.com` address.

**The container can't write its database.**
You switched to a folder instead of the volume, and the folder isn't owned by the container's user. Fix it with `sudo chown 1000:1000 data`.

**The log says `DEMO_MODE ignored`.**
`DEMO_MODE=true` is set next to real Google settings. Remove it from `.env`.

**The log says `CALENDAR_LINKS must be on, private or off`.**
`CALENDAR_LINKS` has another value, so calendar links are off: none can be added, and the ones already there are neither read nor counted. Set it to one of the three, or remove it for `on`.

**The log says `BOOKING_LINKS must be on or off`.**
`BOOKING_LINKS` has another value, so booking links are off: their pages answer that the link doesn't exist, and *My settings* doesn't show them. Set it to `on`, or remove it for `off`.

**The log says `booking event may be left in Google`.**
A booking didn't go through after its event was made in the host's Google Calendar, for example because it was cancelled while the event was being made, and deleting that event again failed. The visitor may have an invitation for it. The line names the host's ID and the event's ID: the host deletes the event in Google Calendar, and Google tells the visitor.

**The log says `booking event not checked`.**
A booked meeting's event was missing when the host's calendar was read, and Google couldn't say whether it was deleted. Nothing changes: the booking stays until a later read asks again. The line names the host's ID, the event's ID and Google's error.

Still stuck? [Open an issue](https://github.com/m3t3hn/ekip-takvim/issues/new/choose) with the version, your setup and the relevant log lines. Leave out secrets.
