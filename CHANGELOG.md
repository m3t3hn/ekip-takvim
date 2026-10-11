# Changelog

Notable changes to Ekip Takvim. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.0]

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

[Unreleased]: https://github.com/m3t3hn/ekip-takvim/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/m3t3hn/ekip-takvim/releases/tag/v1.0.0
