/* eslint-disable no-console */
/**
 * Plot Armor deterministic fixture runner.
 *
 * Where to run:
 *   Chrome -> chrome://extensions -> Plot Armor -> "service worker" inspect
 *   Paste this file into the console (or use DevTools Snippets), then run:
 *     await runPlotArmorFixtures();
 *
 * Optional:
 *   await runPlotArmorFixtures({ limit: 10 });
 *   await runPlotArmorFixtures({ ids: ["PA-001", "PA-045"] });
 *   await runPlotArmorFixtures({ clearEvalCacheEachCase: true });
 *
 * Cache warm pass (for metrics):
 *   await resetMetrics();
 *   await runPlotArmorFixtures();
 *   await runPlotArmorFixtures();
 *   console.log(await getMetricsSummary());
 *
 * Note: harness uses containerTag FIXTURE so the service worker always escalates to
 * the LLM when Tier 1 has no stored graph — re-paste this file after bumping DETECTOR_VERSION.
 * Fixture cases pass protectedShows in-memory (no per-case chrome.storage.sync writes).
 */
async function runPlotArmorFixtures(options = {}) {
  const { limit = null, ids = null, clearEvalCacheEachCase = false } = options;

  const fixturesUrl = chrome.runtime.getURL("tests/fixtures.json");
  const fixtures = await fetch(fixturesUrl).then((r) => r.json());
  const selected = Array.isArray(ids) && ids.length
    ? fixtures.filter((f) => ids.includes(f.id))
    : fixtures.slice(0, Number.isFinite(limit) && limit > 0 ? limit : fixtures.length);

  if (!selected.length) {
    console.warn("[Plot Armor fixtures] No fixtures selected.");
    return { total: 0, passed: 0, failed: 0, failures: [] };
  }

  const failures = [];
  const startedAt = Date.now();
  const canCallDirect = typeof handleSemanticCheck === "function";

  for (const f of selected) {
    const protectedShows = Array.isArray(f.protectedShows) ? f.protectedShows : [];

    if (clearEvalCacheEachCase) {
      if (typeof clearEvalCacheMemory === "function") {
        clearEvalCacheMemory();
      } else {
        await chrome.storage.local.set({ evalCache: {} });
      }
    }

    const payload = {
      type: "SEMANTIC_CHECK",
      textToAnalyze: String(f.text || ""),
      sectionHint: String(f.sectionHint || ""),
      precedingContext: String(f.precedingContext || ""),
      containerTag: String(f.containerTag || "FIXTURE"),
      protectedShows,
    };
    const response = canCallDirect
      ? {
          ok: true,
          data: await handleSemanticCheck(
            payload.textToAnalyze,
            "",
            payload.sectionHint,
            payload.containerTag,
            payload.precedingContext,
            protectedShows
          ),
        }
      : await chrome.runtime.sendMessage(payload);

    const data = response?.data || {};
    const gotSpoiler = Boolean(data.isSpoiler);
    const expectedSpoiler = Boolean(f.expectedSpoiler);
    const passSpoiler = gotSpoiler === expectedSpoiler;

    const expectedShow = f.expectedMatchedShow ? String(f.expectedMatchedShow) : null;
    const gotShow = data.matchedShow ? String(data.matchedShow) : null;
    const passShow = expectedShow ? gotShow === expectedShow : true;

    const passed = passSpoiler && passShow;
    if (!passed) {
      failures.push({
        id: f.id,
        expectedSpoiler,
        gotSpoiler,
        expectedShow,
        gotShow,
        reason: data.reason || "",
        confidence: typeof data.confidence === "number" ? Number(data.confidence.toFixed(3)) : null,
      });
    }
  }

  if (typeof flushLocalPersistedState === "function") {
    await flushLocalPersistedState(true);
  }

  const total = selected.length;
  const failed = failures.length;
  const passed = total - failed;
  const elapsedMs = Date.now() - startedAt;

  console.log(
    `[Plot Armor fixtures] ${passed}/${total} passed (${((passed / total) * 100).toFixed(1)}%) in ${elapsedMs}ms`
  );

  if (failures.length) {
    console.table(failures);
  }

  try {
    const metricsResponse = canCallDirect
      ? { ok: true, data: await getMetricsSummary() }
      : await chrome.runtime.sendMessage({ type: "GET_METRICS" });
    const metrics = metricsResponse?.data || metricsResponse || {};
    console.log(
      `[Plot Armor fixtures] metrics — local intercept ${metrics.localInterceptPct ?? 0}%, cache ${metrics.cacheHitPct ?? 0}%, LLM checks ${metrics.llmChecks ?? 0}`
    );
    console.info("[Plot Armor fixtures] metrics detail", metrics);
  } catch (error) {
    console.warn("[Plot Armor fixtures] could not load metrics", error);
  }

  return { total, passed, failed, failures, elapsedMs };
}
