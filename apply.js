/**
 * LinkedIn Easy Apply automation.
 *
 * Searches each configured keyword, opens Easy Apply jobs one at a time in
 * a real, visible, stealth-patched Chrome window, answers the application
 * questions from your resume-derived Q&A bank (with a local Ollama model
 * as fallback for anything new), and submits — with human-like pacing
 * throughout to keep this from looking automated.
 *
 * Prerequisite: run `npm run login` once to save your session.
 * Run: npm start
 */
import { CONFIG } from "./config.js";
import { launchBrowser, getOrCreatePage } from "./browser.js";
import { humanClick, humanDelay, humanScroll, sleep, randInt } from "./humanize.js";
import { runEasyApplyFlow, detectSecurityCheckpoint, dismissSafetyReminder } from "./formFiller.js";
import { logApplied, alreadyApplied } from "./logger.js";

async function safeGoto(page, url, opts = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", ...opts });
      return;
    } catch (err) {
      if (attempt === 3) throw err;
      console.warn(`  navigation retry ${attempt}/3 after error: ${err.message}`);
      await sleep(2000 * attempt);
    }
  }
}

/** Closes any leftover Easy Apply modal from a previous job so its overlay
 * doesn't intercept clicks meant for the next job's Easy Apply button. */
async function closeStrayModal(page) {
  const overlay = page.locator('div[role="dialog"]:has-text("Apply to")').last();
  if (await overlay.count().catch(() => 0)) {
    const dismiss = overlay.getByRole("button", { name: /^Dismiss$/i });
    if (await dismiss.count()) {
      await dismiss.first().click({ force: true }).catch(() => {});
      await sleep(400);
      const discard = page.getByRole("button", { name: /^Discard$/i });
      if (await discard.count()) {
        await discard.first().click({ force: true }).catch(() => {});
      }
    }
  }
}

/**
 * Advances the job list to the next results page. Scrolls the (internally
 * scrollable) list pane down to reveal LinkedIn's pagination bar, clicks
 * "Next", and — instead of a fixed sleep — waits for the first job card's
 * id to actually change so we know the new page really loaded before
 * continuing.
 * @returns {boolean} true if it advanced, false if there's no next page.
 */
async function goToNextPage(page, listPane) {
  await listPane
    .evaluate((el) => el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }))
    .catch(() => {});
  await humanDelay(700, 1400);

  const pagination = page.locator(".artdeco-pagination").first();
  if (!(await pagination.count().catch(() => 0))) return false;

  const nextBtn = pagination
    .getByRole("button", { name: /next|view next page/i })
    .first();
  if (!(await nextBtn.count().catch(() => 0))) return false;

  const disabled = await nextBtn.isDisabled().catch(() => true);
  if (disabled) return false;

  const firstCardBefore = await page
    .locator("li[data-occludable-job-id]")
    .first()
    .getAttribute("data-occludable-job-id")
    .catch(() => null);

  await humanClick(page, nextBtn);

  await page
    .waitForFunction(
      (prevId) => {
        const first = document.querySelector("li[data-occludable-job-id]");
        return !!first && first.getAttribute("data-occludable-job-id") !== prevId;
      },
      firstCardBefore,
      { timeout: 10000 }
    )
    .catch(() => {});

  await humanDelay(1500, 3000);
  return true;
}

function buildSearchUrl(keyword, start = 0) {
  const params = new URLSearchParams({ keywords: keyword });
  if (CONFIG.search.location) params.set("location", CONFIG.search.location);

  const tprMap = { day: "r86400", week: "r604800", month: "r2592000" };
  if (CONFIG.search.datePosted !== "any" && tprMap[CONFIG.search.datePosted]) {
    params.set("f_TPR", tprMap[CONFIG.search.datePosted]);
  }
  if (CONFIG.search.easyApplyOnly) params.set("f_AL", "true");
  if (start) params.set("start", String(start));

  return `https://www.linkedin.com/jobs/search/?${params.toString()}`;
}

async function processKeyword(page, keyword, state) {
  console.log(`\n=== Keyword: "${keyword}" ===`);
  await safeGoto(page, buildSearchUrl(keyword));
  await humanDelay(2500, 4500);

  let appliedForKeyword = 0;
  let pageNum = 1;

  while (
    appliedForKeyword < CONFIG.limits.maxApplicationsPerKeyword &&
    state.totalApplied < CONFIG.limits.maxApplicationsPerRun
  ) {
    if (await detectSecurityCheckpoint(page)) {
      throw new Error("SECURITY_CHECKPOINT_DETECTED");
    }

    const listPane = page.locator(".scaffold-layout__list, .jobs-search-results-list").first();
    await listPane.waitFor({ timeout: 15000 }).catch(() => {});

    const cards = await page.locator("li[data-occludable-job-id]").all();
    if (!cards.length) {
      console.log("No job cards found — stopping this keyword.");
      break;
    }

    for (const card of cards) {
      if (appliedForKeyword >= CONFIG.limits.maxApplicationsPerKeyword) break;
      if (state.totalApplied >= CONFIG.limits.maxApplicationsPerRun) break;

      const jobId = await card.getAttribute("data-occludable-job-id");
      if (!jobId || state.seenJobIds.has(jobId) || alreadyApplied(jobId)) continue;
      state.seenJobIds.add(jobId);

      const title = (await card.locator("a").first().innerText().catch(() => ""))
        .split("\n")[0]
        .trim();
      const company = (
        await card
          .locator("[class*='subtitle'], .artdeco-entity-lazy-image + div")
          .first()
          .innerText()
          .catch(() => "")
      ).trim();
      const jobContext = { jobId, title, company: company || "Unknown", keyword };

      try {
        await closeStrayModal(page);
        await humanScroll(page, listPane);
        await humanClick(page, card);
        await humanDelay(1500, 3000);

        // Scope to the job details pane and match by accessible role so we
        // never accidentally grab the "Easy Apply" *filter pill* in the
        // search bar (that pill has role="radio", not role="button").
        const detailsPane = page
          .locator(".jobs-details, .job-view-layout, .jobs-search__job-details--wrapper")
          .first();
        const easyApplyBtn = detailsPane
          .getByRole("button", { name: /^Easy Apply/i })
          .first();

        if (!(await easyApplyBtn.count())) {
          console.log(`[SKIP] ${title} @ ${jobContext.company} — no Easy Apply`);
          continue;
        }

        console.log(`[OPEN] ${title} @ ${jobContext.company}`);
        await humanClick(page, easyApplyBtn);
        await humanDelay(800, 1500);

        // Optional "Job search safety reminder" may appear before the form
        await dismissSafetyReminder(page);

        await runEasyApplyFlow(page, jobContext);

        logApplied({ ...jobContext, status: "applied" });
        state.totalApplied += 1;
        appliedForKeyword += 1;
        console.log(
          `[APPLIED] (${state.totalApplied}/${CONFIG.limits.maxApplicationsPerRun}) ${title} @ ${jobContext.company}`
        );
      } catch (err) {
        if (err.message === "SECURITY_CHECKPOINT_DETECTED") throw err;
        const status = err.message?.startsWith("NEEDS_REVIEW") ? "needs_review" : "failed";
        console.error(`[${status.toUpperCase()}] ${title} @ ${jobContext.company}: ${err.message}`);
        logApplied({ ...jobContext, status, error: err.message });
      }

      if (state.totalApplied > 0 && state.totalApplied % CONFIG.limits.longBreakEvery === 0) {
        const breakMs = randInt(CONFIG.limits.longBreakMinMs, CONFIG.limits.longBreakMaxMs);
        console.log(`\n[BREAK] Taking a longer human-like break: ${Math.round(breakMs / 1000)}s...\n`);
        await sleep(breakMs);
      } else {
        await humanDelay(CONFIG.limits.minDelayBetweenJobsMs, CONFIG.limits.maxDelayBetweenJobsMs);
      }
    }

    if (pageNum >= CONFIG.limits.maxPagesPerKeyword) {
      console.log(`Reached max pages (${CONFIG.limits.maxPagesPerKeyword}) for "${keyword}".`);
      break;
    }

    const advanced = await goToNextPage(page, listPane);
    if (!advanced) {
      console.log("No further result pages.");
      break;
    }
    pageNum += 1;
    console.log(`  -> page ${pageNum}`);
  }

  console.log(`Keyword "${keyword}" done — applied ${appliedForKeyword}.`);
}

async function main() {
  console.log("Starting LinkedIn Easy Apply automation...");
  console.log(
    `Limits: ${CONFIG.limits.maxApplicationsPerRun}/run, ${CONFIG.limits.maxApplicationsPerKeyword}/keyword. AI fallback: ${CONFIG.ai.enabled ? CONFIG.ai.model : "disabled"}.`
  );

  const context = await launchBrowser();
  const page = await getOrCreatePage(context);

  await safeGoto(page, "https://www.linkedin.com/feed/");
  await sleep(1500);

  if (/\/login|checkpoint/i.test(page.url())) {
    console.error("\nNot logged in. Run `npm run login` first, then re-run this.\n");
    await context.close();
    process.exit(1);
  }

  const state = { totalApplied: 0, seenJobIds: new Set() };

  try {
    for (const keyword of CONFIG.search.keywords) {
      if (state.totalApplied >= CONFIG.limits.maxApplicationsPerRun) break;
      await processKeyword(page, keyword, state);
    }
  } catch (err) {
    if (err.message === "SECURITY_CHECKPOINT_DETECTED") {
      console.error(
        "\n🚨 LinkedIn showed a security checkpoint/captcha. Stopping immediately — please solve it manually in the open browser window, then re-run.\n"
      );
    } else {
      console.error("\nFatal error:", err);
    }
  }

  console.log("\n========== SUMMARY ==========");
  console.log(`Total applied this run: ${state.totalApplied}`);
  console.log("See ./data/applied-log.json and ./data/needs-review.json for full details.");

  await context.close();
}

main();
