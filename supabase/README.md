# Plot Armor → Supabase false-positive ingest

When a user clicks **“not a spoiler?”**, the extension POSTs the report to a Supabase Edge Function, which inserts a row in `false_positive_reports`.

**Secrets stay out of git.** Ingest URL + key live only in your local **`.env`** (gitignored). Copy from [`.env.example`](../.env.example).

## 1. Create table

In [Supabase Dashboard](https://supabase.com/dashboard) → **SQL Editor**, run [`schema.sql`](./schema.sql).

## 2. Deploy Edge Function

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase secrets set PLOT_ARMOR_INGEST_SECRET=your-long-random-secret-here
supabase functions deploy ingest-false-positive --no-verify-jwt
```

Function URL:

```text
https://YOUR_PROJECT_REF.supabase.co/functions/v1/ingest-false-positive
```

## 3. Local extension config

```bash
cp .env.example .env
```

Fill in:

```env
FALSE_POSITIVE_INGEST_URL=https://YOUR_PROJECT_REF.supabase.co/functions/v1/ingest-false-positive
FALSE_POSITIVE_INGEST_KEY=same-as-PLOT_ARMOR_INGEST_SECRET
```

Reload the unpacked extension. **thanks!** on report = ingest worked.

`manifest.json` already allows `https://*.supabase.co/*`.

## 4. View reports

**Dashboard → Table Editor → `false_positive_reports`**

```sql
select created_at, show_title, reason, detector_version, left(snippet, 120) as snippet
from false_positive_reports
order by created_at desc
limit 50;
```

## Server-side limits (Edge Function)

- Shared-secret header (timing-safe compare)
- Max JSON body 12 KB
- `page_url` must be `http:` or `https:` if present
- **250 inserts / 24h** global cap (abuse throttle if a dev key leaks)

## If a secret was ever committed

Rotate immediately:

```bash
supabase secrets set PLOT_ARMOR_INGEST_SECRET=NEW-long-random-secret
```

Update `FALSE_POSITIVE_INGEST_KEY` in `.env` only. Old values remain in git history — treat as compromised.

## Shipping note

A store build cannot include `.env`. Ingest only works in **unpacked dev** unless you inject secrets at build time (CI) — which still ends up in the client bundle. For public releases, assume the ingest key is extractable; rely on Edge Function rate limits and rotation.
