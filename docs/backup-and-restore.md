# Backup and restore

## What to keep

1. **The database:** everyone's settings, their encrypted Google access, and the event details read from Google.
2. **`SESSION_SECRET`** from `.env`. Without it the stored Google access can't be decrypted, and everyone has to sign in again; their settings survive. Keep it in your password manager, apart from the database backups, because together they give access to everyone's calendars.
3. **`config/app.yaml`**, if you have one.

Losing the database isn't a disaster. People sign in again and redo their settings, and their calendars are read from Google again.

## Backing up

```bash
docker compose exec -T ekip-takvim node scripts/backup-db.mjs - > ekip-takvim-$(date +%F).sqlite
```

This makes a consistent copy while the app keeps running. Don't copy the live database file instead: the database runs in WAL mode, so a plain copy can miss recent writes. The backup holds event titles and descriptions in plain text, so store it as carefully as a password.

**Every night, with cron:**

```cron
15 3 * * * cd /srv/ekip-takvim && umask 077 && docker compose exec -T ekip-takvim node scripts/backup-db.mjs - > backups/ekip-takvim-$(date +\%F).sqlite
```

Use the folder you cloned into. `%` has to be written as `\%` in a crontab. To keep two weeks of backups, add `find /srv/ekip-takvim/backups -name '*.sqlite' -mtime +14 -delete`.

**If your backup tool reads Docker volumes,** leave out the `-`:

```bash
docker compose exec ekip-takvim node scripts/backup-db.mjs
```

The copy goes to `/app/data/backup/ekip-takvim.sqlite` inside the volume, replacing the previous one. Let your tool pick it up from there.

## Restoring

```bash
docker compose stop ekip-takvim
docker compose run --rm -T ekip-takvim node scripts/restore-db.mjs - < ekip-takvim-2026-10-11.sqlite
docker compose start ekip-takvim
```

The restore script:
- checks that the file is an intact Ekip Takvim database before it changes anything;
- keeps the database it replaces as `ekip-takvim.sqlite.before-restore`, in case it was the wrong backup;
- refuses to run while the app is running. If the old database is damaged and the script can't open it, add `--force`.

Restore with the same `SESSION_SECRET` the backup was made with. With a different one, everyone has to sign in again.

## Without Docker

The same scripts work from the project folder, against `DATABASE_PATH` or `data/ekip-takvim.sqlite`:

```bash
node scripts/backup-db.mjs - > ekip-takvim.sqlite
node scripts/restore-db.mjs ekip-takvim.sqlite      # with the app stopped
```
