# Security policy

## Reporting a vulnerability

Please don't open a public issue. Report it privately through GitHub instead: on the repository's **Security** tab, choose **Report a vulnerability** ([direct link](https://github.com/m3t3hn/ekip-takvim/security/advisories/new)). Only the maintainers see the report.

A useful report says:

- which version you run (on the Status page, or in `/healthz`),
- what an attacker can do, and what they need first (an account, access to the network, a link),
- the steps to reproduce it, ideally against the demo (`docker compose -f compose.demo.yaml up --build`).

We aim to reply within a week. Once a fix is out, the advisory is published with credit to you, unless you'd rather not be named.

## Supported versions

Only the latest release gets security fixes. [Upgrading](docs/upgrading.md) is a `git pull` and a rebuild.

## By design, not vulnerabilities

- **Anyone who can open the app can see the calendar.** Viewing needs no sign-in: names, teams, busy times and calendar labels are visible to whoever reaches the address. The app must sit behind a VPN, an access proxy or the built-in basic auth ([access control](docs/access-control.md)). A report that only shows this, on an install without any of those, isn't a vulnerability.
- **Signed-in colleagues see the titles of events on each other's company calendar**, unless the event is marked private. See [privacy and security](docs/privacy-and-security.md) for exactly who sees what.
- **Demo mode lets anyone sign in as anyone.** It only holds made-up people, refuses to run while Google sign-in is configured, and never replaces a database real people have signed in to.

Anything that gets around these limits is in scope. For example: a not-signed-in viewer seeing an event title, a colleague seeing a personal calendar's events, or demo sign-in working on a real install.
