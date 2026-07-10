import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-plot-armor-ingest-key",
};

const MAX_BODY_BYTES = 12_000;
const MAX_REPORTS_PER_DAY = 250;

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function clampText(value: unknown, maxLen: number) {
  return String(value || "").slice(0, maxLen);
}

function secretsEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i += 1) {
    out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return out === 0;
}

function isAllowedPageUrl(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) return true;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  const expectedSecret = Deno.env.get("PLOT_ARMOR_INGEST_SECRET") || "";
  const providedSecret = req.headers.get("x-plot-armor-ingest-key") || "";
  if (!expectedSecret || !secretsEqual(providedSecret, expectedSecret)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return jsonResponse({ error: "payload_too_large" }, 413);
  }

  let payload: { report?: Record<string, unknown> };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  const report = payload?.report;
  if (!report || typeof report !== "object") {
    return jsonResponse({ error: "missing_report" }, 400);
  }

  if (!isAllowedPageUrl(report.url)) {
    return jsonResponse({ error: "invalid_page_url" }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "server_misconfigured" }, 500);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count: recentCount, error: countError } = await supabase
    .from("false_positive_reports")
    .select("*", { count: "exact", head: true })
    .gte("created_at", since);

  if (countError) {
    console.error("rate limit check failed", countError);
  } else if ((recentCount || 0) >= MAX_REPORTS_PER_DAY) {
    return jsonResponse({ error: "rate_limited" }, 429);
  }

  const row = {
    report_id: clampText(report.id, 80) || null,
    show_title: clampText(report.show, 200) || null,
    page_url: clampText(report.url, 2000) || null,
    snippet: clampText(report.text, 2000) || null,
    reason: clampText(report.reason, 200) || null,
    confidence:
      typeof report.confidence === "number" && Number.isFinite(report.confidence)
        ? report.confidence
        : null,
    source: clampText(report.source, 120) || null,
    detector_version: clampText(report.detectorVersion, 40) || null,
    extension_version: clampText(report.extensionVersion, 40) || null,
    raw: report,
  };

  const { data, error } = await supabase
    .from("false_positive_reports")
    .insert(row)
    .select("id")
    .single();

  if (error) {
    console.error("insert failed", error);
    return jsonResponse({ error: "insert_failed" }, 500);
  }

  return jsonResponse({ ok: true, id: data?.id });
});
