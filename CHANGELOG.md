# Changelog

Notable changes to Ekip Takvim. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.2.0] - 2026-11-03

### Added
- **`EXPOSURE=exposed`** for running the app on the open internet. Every page then needs a sign-in with a company Google account: people who aren't signed in get a sign-in page, and the API answers `401`. The app refuses to start this way without `google_domain` and an https `APP_URL`. The default, `EXPOSURE=internal`, keeps today's behaviour for apps behind a VPN.
- **Security headers** on every response: HSTS, no framing by other sites, `nosniff`, and a strict referrer policy.

## [1.1.0] - 2026-11-01

### Changed
- **Shared free time stays empty on the day view.** It used to be a green block with a label, which read as someone's event. A green mark beside the hours, and the chips above the grid, now show when everyone is free; hovering the slot still highlights it, and clicking selects it.
- **Off-hours are a flat light grey** instead of stripes, so they no longer outweigh free time. Stripes now mean only one thing: we don't know when this person is free.

## [1.0.0] - 2026-10-12

First public release.

### Views and planning
- **Day, week and month views:** who's free when, with everyone's calendars combined.
- **Find a time:** gaps that suit everyone, plus "almost works" slots that suit all but one person.
- **Event details:** clicking an event shows its meeting link, place and description, if you're allowed to see its title.
- **Invites:** open a prefilled event in Google Calendar or Outlook, or download an `.ics` file.

### Your calendars and data
- **Sign-in:** each person signs in with Google and picks which calendars count as busy time. That includes other jobs' calendars, once they're shared with the company account.
- **Unknown availability:** people whose calendars can't be read right now aren't counted as free.
- **Time zones:** per-person zones and company working hours.
- **Privacy:** colleagues see the titles of company-calendar events only, and personal calendars show just their label. Labels never show an email address.

### Running it
- **Install with Docker Compose.** The YAML config is optional.
- **Access:** an optional Cloudflare Access check and optional basic auth.
- **Demo mode** with made-up people.
- **Backup and restore scripts.**

[Unreleased]: https://github.com/m3t3hn/ekip-takvim/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/m3t3hn/ekip-takvim/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/m3t3hn/ekip-takvim/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/m3t3hn/ekip-takvim/releases/tag/v1.0.0
