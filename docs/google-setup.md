# Google setup

Sign-in needs an OAuth client in Google Cloud. One person does this once. With Google Workspace that's usually an admin, or anyone allowed to create Google Cloud projects in your organisation.

## 1. Create a project and turn on the Calendar API

1. Open the [Google Cloud console](https://console.cloud.google.com/) and create a project, for example *Ekip Takvim*.
2. Go to **APIs & Services → Library**, find **Google Calendar API** and press **Enable**.

## 2. Set up the consent screen

Open **Google Auth Platform**, called *OAuth consent screen* in older versions of the console.

1. **Branding:** the app name (*Ekip Takvim*) and a support email.
2. **Audience:** choose **Internal** if your team is on Google Workspace. Then only accounts in your organisation can sign in, and Google doesn't have to review the app. Choose *External* only if people sign in with personal Google accounts; see [below](#personal-google-accounts) for what that costs.
3. **Data access:** add these scopes:
   - `openid`
   - `.../auth/userinfo.email`
   - `.../auth/userinfo.profile`
   - `.../auth/calendar.readonly`

## 3. Create the OAuth client

Under **Clients**, choose **Create client** and **Web application**:

- **Name:** anything, e.g. *Ekip Takvim*.
- **Authorised redirect URIs:** your `APP_URL` followed by `/auth/google/callback`, e.g. `https://calendar.example.com/auth/google/callback`. To run the app on your own computer as well, add `http://localhost:3000/auth/google/callback`.
- **Authorised JavaScript origins:** not needed.

Create it, then copy the **Client ID** and **Client secret** into `.env`:

```bash
GOOGLE_CLIENT_ID=1234567890-abc….apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=…
```

The redirect URI has to match `APP_URL` exactly: same scheme, same host, same port, no trailing slash. If it doesn't, Google shows `redirect_uri_mismatch`.

## 4. Allow only your domain

In `config/app.yaml`:

```yaml
google_domain: example.com
```

Only Google Workspace accounts on that domain can sign in. An Internal client already keeps everyone else out; this adds a second check, and it's the only check if the client is External.

## What people agree to

When someone signs in, Google asks them to allow:

- their name, email address and profile picture;
- *See and download any calendar you can access using your Google Calendar*. That's read-only: the app never creates, changes or deletes events.

If someone unticks the calendar permission, they're still signed in, but nothing of theirs counts. **My settings** then asks them to sign in again and allow it.

People add their other jobs' calendars by sharing them with their company account; see [Adding yourself](user-guide.md#adding-yourself).

## Personal Google accounts

Without Google Workspace, the client has to be **External**, and two limits apply:

- **While the app's status is *Testing*:** only the test users you list can sign in, up to 100 of them. Google also ends their access after 7 days, so they show up as *Needs to sign in* every week.
- **To publish the app** (status *In production*): the Calendar permission requires Google to verify the app first. That takes time and a public privacy policy.

For a team, a Google Workspace with an Internal client is by far the simplest.

## If the secret leaks

Open the client in the Google Cloud console and add a new secret. Put it in `.env`, run `docker compose up -d`, then delete the old secret.
