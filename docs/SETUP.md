# Setting up sync

The Ledger works with no setup at all — open it, add cards, done. Everything
lives in your browser's IndexedDB on that device.

Sync is what makes the phone and the laptop show the same collection. It needs
a Supabase project, which is free and takes about ten minutes to set up once.

---

## 1. Create the project

1. Sign up at [supabase.com](https://supabase.com) and create a new project.
2. Pick a region near you and set a database password (you won't need it again
   for this app — the app signs in as a normal user, not as the database).
3. Wait for the project to finish provisioning.

## 2. Create the tables

1. In the project sidebar, open **SQL Editor** → **New query**.
2. Paste the entire contents of [`../supabase/schema.sql`](../supabase/schema.sql).
3. Click **Run**.

This creates three tables, their row-level security policies, and a private
`card-photos` storage bucket. It is safe to re-run.

## 3. Turn off email confirmation (optional, but easier)

**Authentication** → **Sign In / Providers** → **Email**, and turn off
*Confirm email*. Otherwise you'll need to click a link in your inbox after
creating the account.

## 4. Get the two values the app needs

**Project Settings** → **API keys** (or **Data API** for the URL):

| Field in the app | Where to find it |
| --- | --- |
| Project URL | Project Settings → Data API → *Project URL*, e.g. `https://abcdefgh.supabase.co` |
| Anon / publishable key | Project Settings → API keys → *anon* / *publishable* |

The anon key is meant to be public — it identifies the project, it doesn't grant
access. Row-level security is what keeps your rows yours, and the schema above
restricts every table and every photo to the account that created it.

> Never paste the **service_role** key here. That one bypasses row-level
> security entirely.

## 5. Connect the app

1. Open The Ledger and click the **Sync off** button in the sidebar.
2. Paste the Project URL and anon key, click **Save**.
3. Enter an email and password, click **Create account**.
4. It syncs immediately, and the sidebar button turns green.

## 6. Do the same on your phone

Open the same URL on your phone, tap **Sync**, paste the same two values, and
sign in with the account you just created. Your collection downloads.

To get the app onto the home screen:

- **Android / Chrome** — tap the ⋮ menu → *Add to Home screen*, or use the
  **Install app** button in the sidebar.
- **iOS / Safari** — tap Share → *Add to Home Screen*.

Once installed it opens without browser chrome, works offline, and the "add
photo" fields open the camera directly.

---

## How syncing behaves

- **Local first.** Every change is saved to the device immediately and shows up
  instantly. Sync happens afterwards, in the background.
- **Offline is normal.** With no signal the app works exactly as usual and
  queues its changes. They go up the next time it has a connection.
- **Conflicts resolve last-write-wins, per row.** Add cards on your phone while
  editing different cards on your laptop and both sets survive. Edit *the same
  card* on both devices while offline and the later edit wins — the earlier one
  is dropped, not merged.
- **Deletes are soft.** A deleted row is kept with a `deleted_at` stamp so the
  deletion reaches your other devices instead of the row reappearing.
- **Photos are compressed before upload** — max 900px, JPEG quality 0.78, so
  roughly 80–150 KB each. Supabase's free tier gives 1 GB of file storage, which
  is somewhere around 8,000–12,000 card photos.

## Things worth knowing

**Free projects pause after 7 days of inactivity.** Un-pause from the Supabase
dashboard; nothing is lost. If you use the app most weeks you'll never see it.

**Keep device clocks on automatic.** The last-write-wins comparison uses the
timestamp written by the device that made the change. A device whose clock is
badly wrong would win or lose conflicts unfairly.

**Sync is not a backup.** It replicates deletions too. Use **Export backup**
periodically for a snapshot you can actually roll back to.

## Troubleshooting

| What you see | What it means |
| --- | --- |
| *Sign in to sync* | Config saved but no account signed in on this device. |
| *Offline — changes queued* | No network. Nothing is lost; it retries automatically. |
| *Sync failed* | Hover the sidebar button for the error. Usually a wrong URL/key, or the schema wasn't run. |
| `relation "public.cards" does not exist` | Step 2 didn't run. Re-run `schema.sql`. |
| `new row violates row-level security policy` | The schema ran but policies didn't. Re-run `schema.sql` in full. |
| Photos don't appear on the other device | The `card-photos` bucket is missing — re-run `schema.sql`. |

## Moving off Supabase later

Everything Supabase-specific is in `js/storage/supabase.js` (about 200 lines of
`fetch` calls). `js/storage/sync.js` talks to that module through a small
interface — push rows, pull rows since a timestamp, upload/download objects. A
PocketBase or plain-Postgres backend would mean rewriting that one file.
