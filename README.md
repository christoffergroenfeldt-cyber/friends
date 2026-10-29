# Friends

A small web app for finding a date that works for a group of friends.

- Each iPhone runs a Shortcut that sends **only busy times** (start/end, never titles) from the phone's calendars.
- The organiser picks a few time windows ("Fri & Sat evenings") and the app shows a map of which days everyone is free and suggests the best dates.
- Friends answer Yes / Maybe / No with one tap. People who haven't answered are shown as a guess from their calendar, and one tap can answer everything from your calendar.
- The organiser chooses the date, everyone gets a notification and can add it to their calendar (or subscribe once and get every chosen date automatically).

Everything runs on free tiers: **GitHub Pages** hosts the app, **Supabase** stores the data. No App Store, no Mac.

```
index.html, css/, js/        the web app (no build step)
js/suggest.js                 the date-suggestion logic
js/config.js                  your Supabase URL + keys go here
sw.js, manifest.webmanifest   makes it installable + notifications
supabase/schema.sql           database, run once
supabase/functions/notify     sends notifications
supabase/functions/ics        "Add to calendar" files + calendar subscription
tools/vapid.html              makes the notification keys
tests/                        tests for the suggestion logic
```

---

## Setup (about 30 minutes, once)

### 1. Create the Supabase project
1. Sign up at [supabase.com](https://supabase.com) and create a new project (free plan). Pick region **North EU (Stockholm)**.
2. Open **SQL Editor → New query**, paste the whole of `supabase/schema.sql` and press **Run**.

### 2. Sign-in emails
The app signs people in with a 6-digit code sent by email (no passwords).

1. **Authentication → Emails → Templates**. In both **Magic Link** and **Confirm signup**, make sure the body contains the code, for example:
   ```html
   <h2>Your Friends code</h2>
   <p>Enter this code in the app: <b>{{ .Token }}</b></p>
   ```
2. **Authentication → Emails → SMTP Settings**: Supabase's built-in email only sends to members of your Supabase team, so your friends won't get codes until you add your own SMTP. Two free options:
   - **Gmail**: turn on 2-step verification on your Google account, create an *App password*, then use host `smtp.gmail.com`, port `587`, username = your Gmail address, password = the app password.
   - **Brevo** (300 emails/day free): verify a sender address and use their SMTP details.
3. **Authentication → URL Configuration**: set **Site URL** to your app address (step 4).

### 3. Connect the app to Supabase
In **Project Settings → API Keys** copy the project URL and the **anon / publishable** key into `js/config.js`. These are meant to be public. Never put the *service_role / secret* key in the repository.

### 4. Publish the app on GitHub Pages
Repository **Settings → Pages → Build and deployment**: Source *Deploy from a branch*, branch `main`, folder `/ (root)`, Save.
After a minute the app is at **https://christoffergroenfeldt-cyber.github.io/friends/**.

### 5. Notifications (optional but recommended)
1. Open `https://christoffergroenfeldt-cyber.github.io/friends/tools/vapid.html` and tap **Make keys**.
2. Put the **public** key in `js/config.js` → `VAPID_PUBLIC_KEY`.
3. In Supabase **Edge Functions → Secrets**, add:
   | Name | Value |
   |---|---|
   | `VAPID_PUBLIC_KEY` | the public key |
   | `VAPID_PRIVATE_KEY` | the private key |
   | `VAPID_SUBJECT` | `mailto:your@email` |
   | `APP_URL` | `https://christoffergroenfeldt-cyber.github.io/friends/` |
4. **Edge Functions → Deploy a new function → Via editor**:
   - Name `notify`, paste `supabase/functions/notify/index.ts`, deploy.
   - Name `ics`, paste `supabase/functions/ics/index.ts`, deploy. Then open its **Details** and turn **Verify JWT** *off* (calendar links are opened by Safari/Calendar without a login).

   (With the Supabase CLI instead: `supabase functions deploy notify` and `supabase functions deploy ics`; `supabase/config.toml` already sets Verify JWT.)

Notifications on iPhone only work when Friends is added to the Home Screen and opened from there (iOS 16.4+). Each person turns them on in **Settings → Turn on notifications**.

### 6. Build the calendar Shortcut (once, then share it)
You build it once on your iPhone and share an iCloud link; your friends just install it.

Open **Shortcuts → +** and add these actions in order. Replace `YOUR-PROJECT` and `YOUR-ANON-KEY` with the values from `js/config.js`.

1. **Text** – type `PASTE-YOUR-SYNC-CODE`.
2. **Set Variable** – name it `Token`, input: *Text*.
3. **Find Calendar Events** – *All Calendar Events*, add filter **Start Date** *is in the next* **90 days**. Leave *Limit* off.
4. **Repeat with Each** – input: *Calendar Events*. Inside the repeat, add:
   - **Text** containing: `Start Date|End Date|Is All Day`
     where each word is the *Repeat Item* variable with that property picked (tap the variable → choose the property).
     For **Start Date** and **End Date**, tap the variable again and set **Date Format: ISO 8601** with **Include ISO 8601 Time** turned on.
     The result should look like `2026-11-06T18:00:00+01:00|2026-11-06T22:00:00+01:00|No`.
5. After **End Repeat**: **Combine Text** – *Repeat Results* with **New Lines**.
6. **Get Contents of URL**
   - URL: `https://YOUR-PROJECT.supabase.co/rest/v1/rpc/sync_busy`
   - Method: **POST**
   - Headers: `apikey` = `YOUR-ANON-KEY`
   - Request Body: **JSON**, two Text fields: `p_token` = variable *Token*, `p_events` = *Combined Text*
7. **Show Notification** – *Contents of URL*.

Name the shortcut exactly **Friends Sync** (the app's *Sync now* button runs it by name).

Make the sync code personal: open the shortcut's settings (ⓘ / Details) → **Import Questions → Add Question**, pick the Text action from step 1 and ask *"Paste your sync code from the Friends app"*. Then **Share → Copy iCloud Link** and paste the link into `js/config.js` → `SHORTCUT_URL`.

Run it once yourself: allow calendar access, and choose **Always Allow** when it asks to connect to supabase.co. The notification should say *Synced N busy times to Friends*.

> If your iPhone is in Danish the actions are named e.g. *Find kalenderbegivenheder*, *Gentag med hver*, *Hent indholdet af URL*, and *Is All Day* is *Er heldags*. The app accepts Ja/Nej as well as Yes/No.

### 7. Invite your friends
In the app: create a group → **Share invite**. On their iPhone the link explains how to add Friends to the Home Screen, sign in, install the Shortcut and set up a daily automation for it.

---

## How it works

**Privacy.** The Shortcut sends only start/end times and whether an event is all-day. The database has no column that could hold event text, and the sync is strict: every line must be exactly `START|END|ALLDAY`. If any line contains anything else (a title, a place, an extra field), the whole upload is rejected, nothing is saved, and the Shortcut shows an error naming the line number, never its content. People only see busy times of people they share a group with (enforced in the database with row level security). Anyone can turn off *All-day events make me busy* for birthdays etc., and add extra busy times by hand.

**Suggestions** (`js/suggest.js`). For each day in the look-ahead period, the app tries every start time (every 30 min) inside the chosen windows, checks who is free, and keeps the best time per day. Days are ranked by: everyone marked *must be there* is free → most people free → soonest. People who have never synced are shown as *unknown* rather than assumed free.

**Answers.** A plan's dates show each person as solid (they answered) or dashed (guessed from their calendar). *Answer from my calendar* fills in all your answers in one tap. When everyone has answered or the deadline passes, the organiser sees the best date and can choose it with one tap.

**Keeping Supabase awake.** Free Supabase projects pause after a week with no activity. The daily Shortcut automation keeps it active; if it ever pauses, restore it from the Supabase dashboard.

## Updating the app
Edit files and push to `main`; GitHub Pages republishes in about a minute. The service worker fetches fresh files first, so phones pick up changes the next time the app is opened.

## Tests
```
TZ=Europe/Copenhagen node --test tests/suggest.test.mjs
```
