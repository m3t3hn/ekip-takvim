# Contributing

Thanks for helping. Bug reports, fixes, docs and ideas are all welcome.

- **Bugs:** open an issue with the bug form. Never paste secrets: say which settings are set, not their values.
- **Ideas and larger changes:** open an issue first, so we can agree on the approach before you spend time on code.
- **Security problems:** report them privately, as [SECURITY.md](SECURITY.md) describes.

## Setting up

You need Node.js 22.13 or newer (24 is what CI and the Docker image use; `nvm use` picks it up from `.nvmrc`).

```bash
git clone https://github.com/m3t3hn/ekip-takvim.git
cd ekip-takvim
npm ci
npm run demo        # made-up people at http://localhost:3000, no Google needed
```

The demo covers almost every case the UI has to handle, so most changes can be built and checked against it. To work against real Google calendars, see [development](docs/development.md).

## Before you open a pull request

```bash
npm run lint
npm run typecheck
npm test
```

- **Add tests for logic changes.** Tests live in `test/` and run with Vitest.
- **For UI changes,** check light and dark themes and a phone-width window, and add a screenshot to the pull request.
- **Update the docs in `docs/`** when behaviour or settings change. Add a line to `CHANGELOG.md` under *Unreleased*.
- **Keep the PR focused:** one change per pull request is easier to review.
- **Name the PR title and commits in [Conventional Commits](https://www.conventionalcommits.org/) style:** `feat: …`, `fix(sync): …`, `docs: …`.

If you used an AI assistant, say so in the pull request, and make sure you understand and have checked every line it wrote.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
