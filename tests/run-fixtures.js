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

  const syncBackup = await chrome.storage.sync.get(["protectedShows", "activeProtectedShows"]);
  const activeBackup = syncBackup.activeProtectedShows || {};

  const failures = [];
  const startedAt = Date.now();
  const canCallDirect = typeof handleSemanticCheck === "function";

  try {
    for (const f of selected) {
      const protectedShows = Array.isArray(f.protectedShows) ? f.protectedShows : [];
      const activeProtectedShows = protectedShows.reduce((acc, show) => {
        acc[show] = true;
        return acc;
      }, {});

      await chrome.storage.sync.set({
        protectedShows,
        activeProtectedShows,
      });

      if (clearEvalCacheEachCase) {
        await chrome.storage.local.set({ evalCache: {} });
      }

      const payload = {
        type: "SEMANTIC_CHECK",
        textToAnalyze: String(f.text || ""),
        sectionHint: String(f.sectionHint || ""),
        precedingContext: String(f.precedingContext || ""),
        containerTag: "FIXTURE",
      };
      // In service-worker console, call the function directly.
      // Fallback to runtime messaging when run from another extension context.
      const response = canCallDirect
        ? {
            ok: true,
            data: await handleSemanticCheck(
              payload.textToAnalyze,
              "",
              payload.sectionHint,
              payload.containerTag,
              payload.precedingContext
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
  } finally {
    await chrome.storage.sync.set({
      protectedShows: syncBackup.protectedShows || [],
      activeProtectedShows: activeBackup,
    });
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

  return { total, passed, failed, failures, elapsedMs };
}
