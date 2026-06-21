# Plot Armor → Supabase false-positive ingest

When a user clicks **“not a spoiler?”**, the extension POSTs the report to a Supabase Edge Function, which inserts a row you can browse in the Supabase dashboard (or SQL).

## 1. Create table

In [Supabase Dashboard](https://supabase.com/dashboard) → **SQL Editor**, run [`schema.sql`](./schema.sql).

## 2. Deploy Edge Function

Install [Supabase CLI](https://supabase.com/docs/guides/cli) and link your project:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
```

Set the ingest secret (pick a long random string):

```bash
supabase secrets set PLOT_ARMOR_INGEST_SECRET=your-long-random-secret-here
```

Deploy (JWT verification off — extension uses `x-plot-armor-ingest-key` instead):

```bash
supabase functions deploy ingest-false-positive --no-verify-jwt
```

Your ingest URL will be:

```text
https://YOUR_PROJECT_REF.supabase.co/functions/v1/ingest-false-positive
```

## 3. Wire the extension

In `background.js`, set:

```javascript
const FALSE_POSITIVE_INGEST_URL =
  "https://YOUR_PROJECT_REF.supabase.co/functions/v1/ingest-false-positive";
const FALSE_POSITIVE_INGEST_KEY = "your-long-random-secret-here"; // same as PLOT_ARMOR_INGEST_SECRET
```

`manifest.json` already includes `https://*.supabase.co/*`.

Reload the extension. Click **not a spoiler?** on a blurred post — you should see **thanks!** and a new row in **Table Editor → false_positive_reports**.

## 4. View reports

**Dashboard → Table Editor → `false_positive_reports`**

Useful columns: `created_at`, `show_title`, `reason`, `detector_version`, `snippet`, `page_url`.

Example query:

```sql
select created_at, show_title, reason, detector_version, left(snippet, 120) as snippet
from false_positive_reports
order by created_at desc
limit 50;
```

## Privacy (Chrome Web Store)

Disclose that optional feedback may include page URL and a text snippet. With ingest enabled, reports are **not** stored locally on the user's device by default.

## Local dev without Supabase

Leave `FALSE_POSITIVE_INGEST_URL` empty. Reports save locally; open **Extension options** to view/export.
