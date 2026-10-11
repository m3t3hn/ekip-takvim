# Upgrading

Each release comes with notes on [GitHub Releases](https://github.com/m3t3hn/ekip-takvim/releases) and in [CHANGELOG.md](../CHANGELOG.md). Versions follow [Semantic Versioning](https://semver.org/):

- **Minor and patch releases** (1.0 → 1.1, 1.1.0 → 1.1.1) are drop-in.
- **Major releases** (1.x → 2.0) say in the changelog what to do first.

## Steps

```bash
cd /srv/ekip-takvim     # where you cloned it

# 1. Back up first
docker compose exec -T ekip-takvim node scripts/backup-db.mjs - > before-upgrade.sqlite

# 2. Switch to the new release
git fetch --tags
git checkout v1.1.0

# 3. Rebuild and restart
docker compose up -d --build

# 4. Check the version
docker compose logs ekip-takvim | grep starting
```

The database is updated automatically when the new version starts. Going back to an older version isn't supported. If something goes wrong, check out the old tag again and [restore the backup](backup-and-restore.md#restoring).

If you'd rather follow the newest code than releases, stay on `main` and use `git pull` in step 2.
