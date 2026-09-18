/**
 * Drives a single LinkedIn Easy Apply modal end-to-end: discovers every
 * question on the current step, answers it (resume Q&A bank first, local
 * AI fallback second), advances through Next -> Review -> Submit, and
 * handles the post-submit "application sent" confirmation.
 */
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "./config.js";
import { matchKnownAnswer, SKIP } from "./qaBank.js";
import { resolveWithAI } from "./aiFallback.js";
import { humanClick, humanType, humanDelay, sleep } from "./humanize.js";
import { logAnswer } from "./logger.js";

function modalLocator(page) {
  return page
    .locator('div.jobs-easy-apply-modal, div[role="dialog"]:has-text("Apply to")')
    .last();
}

export async function detectSecurityCheckpoint(page) {
  const url = page.url();
  if (/checkpoint|authwall|\/captcha/i.test(url)) return true;
  const bodyText = await page
    .locator("body")
    .innerText()
    .catch(() => "");
  return /unusual activity|verify you.?re a human|security verification|let'?s do a quick security check/i.test(
    bodyText
  );
}

/**
 * LinkedIn occasionally shows a "Job search safety reminder" interstitial
 * right after clicking Easy Apply ("Research the company" / "Report
 * suspicious jobs" tips), with "Review job post" / "Continue applying"
 * buttons. It's optional/informational — click through and proceed.
 *
 * Returns true if a reminder was found and dismissed.
 */
export async function dismissSafetyReminder(page) {
  // Match by visible button first — more reliable than dialog title alone
  // when LinkedIn's markup / aria roles vary.
  const continueBtn = page
    .getByRole("button", { name: /Continue applying/i })
    .or(page.locator('button:has-text("Continue applying")'));

  if (!(await continueBtn.count().catch(() => 0))) {
    // Fallback: dialog titled "Job search safety reminder"
    const reminder = page.locator(
      'div[role="dialog"]:has-text("Job search safety"), div[role="dialog"]:has-text("safety reminder")'
    );
    if (!(await reminder.count().catch(() => 0))) return false;
    const btn = reminder.getByRole("button", { name: /Continue applying/i });
    if (!(await btn.count().catch(() => 0))) return false;
    console.log("  [SAFETY] Job search safety reminder — clicking Continue applying");
    await humanClick(page, btn.first()).catch(async () => {
      await btn.first().click({ force: true });
    });
    await sleep(800);
    return true;
  }

  const visible = await continueBtn.first().isVisible().catch(() => false);
  if (!visible) return false;

  console.log("  [SAFETY] Job search safety reminder — clicking Continue applying");
  await humanClick(page, continueBtn.first()).catch(async () => {
    await continueBtn.first().click({ force: true });
  });
  await sleep(800);
  return true;
}

/**
 * After Easy Apply is clicked, either the real apply modal OR the optional
 * safety-reminder popup may appear. Poll until the apply modal is visible,
 * dismissing the safety reminder whenever it shows up.
 */
async function waitForApplyModal(page, timeoutMs = 20000) {
  const modal = modalLocator(page);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await dismissSafetyReminder(page);

    if (await modal.isVisible().catch(() => false)) {
      return modal;
    }

    // Also treat a dialog whose title starts with "Apply to" as success
    // even if the jobs-easy-apply-modal class is missing.
    const applyDialog = page.locator('div[role="dialog"]:has-text("Apply to")').last();
    if (await applyDialog.isVisible().catch(() => false)) {
      return applyDialog;
    }

    await sleep(400);
  }

  throw new Error(
    'Easy Apply modal did not open (timed out waiting after safety-reminder handling)'
  );
}

async function labelForId(scope, id) {
  if (!id) return "";
  const loc = scope.locator(`xpath=.//label[@for="${id}"]`);
  if (await loc.count()) {
    return (await loc.first().innerText().catch(() => "")).trim();
  }
  return "";
}

/** Collects every answerable field on the current Easy Apply step. */
async function collectFields(modal) {
  const fields = [];

  // 1. Radio groups live inside <fieldset>.
  const fieldsets = await modal.locator("fieldset").all();
  for (const fs_ of fieldsets) {
    const legendText = (await fs_.locator("legend").innerText().catch(() => "")).trim();
    const radios = await fs_.locator('input[type="radio"]').all();
    if (!radios.length) continue;

    const options = [];
    for (const r of radios) {
      const id = await r.getAttribute("id");
      const label = await labelForId(fs_, id);
      options.push({ locator: r, label });
    }
    fields.push({ type: "radio", question: legendText, options, scope: fs_ });
  }

  // 2. Everything else lives inside a `.fb-dash-form-element` wrapper.
  const containers = await modal.locator(".fb-dash-form-element").all();
  for (const el of containers) {
    if (await el.locator("fieldset").count()) continue; // handled above

    const select = el.locator("select");
    if (await select.count()) {
      const label = (await el.locator("label").first().innerText().catch(() => "")).trim();
      const options = (await select.first().locator("option").allInnerTexts()).map((o) =>
        o.trim()
      );
      fields.push({ type: "select", question: label, options, input: select.first() });
      continue;
    }

    const textarea = el.locator("textarea");
    if (await textarea.count()) {
      const label = (await el.locator("label").first().innerText().catch(() => "")).trim();
      fields.push({ type: "textarea", question: label, input: textarea.first() });
      continue;
    }

    const checkbox = el.locator('input[type="checkbox"]');
    if (await checkbox.count()) {
      const id = await checkbox.first().getAttribute("id");
      const label = (await labelForId(el, id)) || (await el.innerText().catch(() => "")).trim();
      fields.push({ type: "checkbox", question: label, input: checkbox.first() });
      continue;
    }

    const textInput = el.locator('input[type="text"], input[type="number"], input[type="tel"]');
    if (await textInput.count()) {
      const label = (await el.locator("label").first().innerText().catch(() => "")).trim();
      fields.push({ type: "text", question: label, input: textInput.first() });
      continue;
    }
  }

  return fields;
}

/** Selects the right resume in the "Resume" step, if a selector is shown. */
async function selectResumeIfNeeded(modal) {
  const target = CONFIG.candidate.resumeFileNameOnLinkedIn.replace(/\.pdf$/i, "");
  const label = modal.locator(`text=${target}`).first();
  if (!(await label.count())) return;

  const card = label.locator(
    'xpath=ancestor::*[.//input[@type="radio"]][1]'
  );
  if (!(await card.count())) return;

  const radio = card.locator('input[type="radio"]').first();
  if (await radio.count()) {
    const checked = await radio.isChecked().catch(() => false);
    if (!checked) await radio.check({ force: true }).catch(() => {});
  }
}

async function answerField(page, field, jobContext) {
  let answer = matchKnownAnswer(field.question, field);
  let source = "qa-bank";

  if (answer === SKIP) {
    logAnswer(jobContext, field.question, "(left as-is)", "skip");
    return true;
  }

  if (answer == null) {
    const ai = await resolveWithAI(field.question, field, jobContext);
    if (!ai) {
      console.log(`    [UNRESOLVED] "${field.question}" — logged for manual review, left blank`);
      return false;
    }
    answer = ai.answer;
    source = ai.source;
  }

  logAnswer(jobContext, field.question, answer, source);

  switch (field.type) {
    case "text":
    case "textarea": {
      const current = await field.input.inputValue().catch(() => "");
      // Trust our own high-confidence resume-derived answers over whatever
      // LinkedIn prefilled; for AI guesses, don't clobber an existing value.
      if (source === "qa-bank" || !current) {
        await humanType(page, field.input, answer);
      }
      break;
    }
    case "select": {
      const ok = await field.input
        .selectOption({ label: answer })
        .then(() => true)
        .catch(() => false);
      if (!ok) await field.input.selectOption(answer).catch(() => {});
      break;
    }
    case "radio": {
      const opt =
        field.options.find((o) => o.label.toLowerCase() === String(answer).toLowerCase()) ||
        field.options.find((o) => o.label.toLowerCase().includes(String(answer).toLowerCase()));
      if (opt) await humanClick(page, opt.locator);
      break;
    }
    case "checkbox": {
      const shouldCheck = /^(yes|true|1)$/i.test(String(answer));
      const isChecked = await field.input.isChecked().catch(() => false);
      if (shouldCheck !== isChecked) await humanClick(page, field.input);
      break;
    }
  }

  await humanDelay(
    CONFIG.limits.minDelayBetweenFormStepsMs,
    CONFIG.limits.maxDelayBetweenFormStepsMs
  );
  return true;
}

async function hasValidationError(modal) {
  const err = modal.locator(".artdeco-inline-feedback--error, [class*='error']:visible");
  return (await err.count()) > 0;
}

async function screenshotFor(page, jobContext, tag) {
  try {
    const dir = path.join(path.dirname(CONFIG.files.reviewQueue), "screenshots");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${tag}.png`);
    await page.screenshot({ path: file, fullPage: false });
    return file;
  } catch {
    return null;
  }
}

async function abandonApplication(page, modal) {
  const closeBtn = modal.getByRole("button", { name: /^Dismiss$/i });
  if (await closeBtn.count()) {
    await humanClick(page, closeBtn.first());
  }
  await sleep(500);
  const discardBtn = page.getByRole("button", { name: /^Discard$/i });
  if (await discardBtn.count()) {
    await humanClick(page, discardBtn.first());
  }
}

/**
 * When LinkedIn rejects a step's answers (e.g. "Enter a decimal number
 * larger than 0.0"), re-reads the actual error messages instead of blindly
 * retyping the same wrong answer. If the error says a field wants a number
 * but we filled in prose (e.g. a notice-period description), coerce it to
 * digits before retrying.
 */
async function retryStepAfterValidationError(page, modal, jobContext) {
  const errorTexts = await modal
    .locator(".artdeco-inline-feedback--error")
    .allInnerTexts()
    .catch(() => []);
  const wantsNumber = errorTexts.some((t) => /number|decimal|numeric/i.test(t));

  const retryFields = await collectFields(modal);
  for (const field of retryFields) {
    if (wantsNumber && (field.type === "text" || field.type === "textarea")) {
      const current = await field.input.inputValue().catch(() => "");
      const isPlainNumber = /^-?\d+(\.\d+)?$/.test(current.trim());
      if (current && !isPlainNumber) {
        const digitsOnly = current.replace(/[^0-9.]/g, "");
        const coerced = digitsOnly.length ? digitsOnly : "0";
        await humanType(page, field.input, coerced);
        logAnswer(jobContext, field.question, coerced, "coerced-numeric");
        await humanDelay(
          CONFIG.limits.minDelayBetweenFormStepsMs,
          CONFIG.limits.maxDelayBetweenFormStepsMs
        );
        continue;
      }
    }
    await answerField(page, field, jobContext);
  }
}

async function handlePostSubmitDialog(page) {
  const doneModal = page.locator('div[role="dialog"]:has-text("was sent")');
  await doneModal.waitFor({ timeout: 8000 }).catch(() => {});
  const notNow = page.getByRole("button", { name: /^Not now$/i });
  if (await notNow.count()) {
    await humanClick(page, notNow.first());
    return;
  }
  const dismiss = page.locator('div[role="dialog"]').getByRole("button", { name: /^Dismiss$/i });
  if (await dismiss.count()) {
    await humanClick(page, dismiss.first());
  }
}

/**
 * Drives the whole modal to completion.
 * @throws Error("NEEDS_REVIEW") if a step can't be completed confidently —
 *         caller should treat the job as skipped, not applied.
 */
export async function runEasyApplyFlow(page, jobContext) {
  const modal = await waitForApplyModal(page, 20000);

  const MAX_STEPS = 15;
  for (let step = 0; step < MAX_STEPS; step++) {
    if (await detectSecurityCheckpoint(page)) {
      throw new Error("SECURITY_CHECKPOINT_DETECTED");
    }

    // Safety reminder can also appear mid-flow on some jobs
    await dismissSafetyReminder(page);
    await selectResumeIfNeeded(modal);

    const fields = await collectFields(modal);
    let anyUnresolved = false;
    for (const field of fields) {
      const ok = await answerField(page, field, jobContext);
      if (!ok) anyUnresolved = true;
    }

    // Prefer the most "forward" button available on this step. Role-based
    // queries avoid accidentally matching unrelated elements that merely
    // contain similar text/aria-label substrings elsewhere in the modal.
    const submitBtn = modal.getByRole("button", { name: /^Submit application$/i });
    const reviewBtn = modal.getByRole("button", { name: /^Review your application$/i });
    const nextBtn = modal.getByRole("button", { name: /^Continue to next step$/i });

    if (anyUnresolved) {
      await screenshotFor(page, jobContext, "unresolved");
      await abandonApplication(page, modal);
      throw new Error("NEEDS_REVIEW: unresolved required question");
    }

    if ((await submitBtn.count()) && (await submitBtn.first().isVisible())) {
      await humanClick(page, submitBtn.first());
      await handlePostSubmitDialog(page);
      return;
    }

    if ((await reviewBtn.count()) && (await reviewBtn.first().isVisible())) {
      await humanClick(page, reviewBtn.first());
      await humanDelay(800, 1600);
      continue;
    }

    if ((await nextBtn.count()) && (await nextBtn.first().isVisible())) {
      await humanClick(page, nextBtn.first());
      await humanDelay(800, 1600);

      if (await hasValidationError(modal)) {
        await retryStepAfterValidationError(page, modal, jobContext);
        await humanClick(page, nextBtn.first());
        await humanDelay(800, 1600);

        if (await hasValidationError(modal)) {
          await screenshotFor(page, jobContext, "validation-error");
          await abandonApplication(page, modal);
          throw new Error("NEEDS_REVIEW: validation error LinkedIn wouldn't accept");
        }
      }
      continue;
    }

    // No known way forward — bail out safely rather than getting stuck.
    await screenshotFor(page, jobContext, "stuck");
    await abandonApplication(page, modal);
    throw new Error("NEEDS_REVIEW: no progression button found");
  }

  await screenshotFor(page, jobContext, "too-many-steps");
  await abandonApplication(page, modal);
  throw new Error("NEEDS_REVIEW: exceeded max steps");
}
