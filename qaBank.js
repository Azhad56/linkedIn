/**
 * Rule-based answer bank for LinkedIn "Additional Questions".
 *
 * Given a question's label text and its field metadata (type + available
 * options, if any), tries to resolve a confident answer purely from the
 * candidate profile in config.js — no AI involved. Returns `null` when it
 * doesn't recognize the question, so the caller can fall back to the local
 * Ollama model.
 */
import { CONFIG } from "./config.js";

const c = CONFIG.candidate;

/** Sentinel meaning "recognized this question, but intentionally leave the
 * field exactly as LinkedIn prefilled it — never touch it." */
export const SKIP = "__SKIP_FIELD__";

function norm(s) {
  return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

// Sorted longest-first so multi-word skills (e.g. "react native") match
// before their substrings (e.g. "react").
const SKILL_NAMES = Object.keys(c.skills).sort((a, b) => b.length - a.length);

function findSkillInQuestion(q) {
  for (const skill of SKILL_NAMES) {
    const re = new RegExp(`\\b${skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(q)) return skill;
  }
  return null;
}

/** Picks the closest matching option label for a boolean answer. */
function pickYesNo(options, boolValue) {
  if (!options || options.length === 0) return boolValue ? "Yes" : "No";
  const want = boolValue ? "yes" : "no";
  const found = options.find((o) => norm(o) === want);
  if (found) return found;
  // fall back to fuzzy contains
  const fuzzy = options.find((o) => norm(o).includes(want));
  return fuzzy || (boolValue ? "Yes" : "No");
}

function pickOption(options, candidates) {
  if (!options) return candidates[0];
  for (const cand of candidates) {
    const found = options.find((o) => norm(o) === norm(cand));
    if (found) return found;
  }
  for (const cand of candidates) {
    const found = options.find((o) => norm(o).includes(norm(cand)));
    if (found) return found;
  }
  return null;
}

/**
 * @param {string} questionText
 * @param {{type: string, options?: string[]}} field
 * @returns {string|null} the answer to type/select, or null if unrecognized
 */
export function matchKnownAnswer(questionText, field = {}) {
  const q = norm(questionText);
  const options = (field.options || []).filter(
    (o) => o && !/select an option/i.test(o)
  );
  const isChoice = field.type === "radio" || field.type === "select";

  // --- Fields LinkedIn always prefills correctly from your profile —
  // never let AI or a generic rule touch these. -----------------------------
  if (/country code/.test(q)) return SKIP;
  if (/^email/.test(q) && !/other/.test(q)) return SKIP;

  // --- Skill-specific years of experience ---------------------------------
  if (/years?.*(experience|work(ed)?|worked)/.test(q) || /experience.*years?/.test(q)) {
    const skill = findSkillInQuestion(q);
    if (skill != null) {
      const years = c.skills[skill];
      return isChoice ? pickOption(options, [String(years), `${years}+`]) ?? String(years) : String(years);
    }
    if (/total|overall|professional/.test(q) || !/with|in |using/.test(q)) {
      return String(c.totalYearsExperience);
    }
    return String(c.totalYearsExperience);
  }

  // --- Education -----------------------------------------------------------
  if (/(level of education|bachelor|master|degree)/.test(q) && /(completed|have you|do you have)/.test(q)) {
    return pickYesNo(options, c.educationCompleted);
  }

  // --- Relocation ------------------------------------------------------------
  if (/relocat/.test(q)) {
    return pickYesNo(options, c.willingToRelocate);
  }

  // --- Travel ----------------------------------------------------------------
  if (/travel/.test(q)) {
    return pickYesNo(options, c.willingToTravel);
  }

  // --- Sponsorship -------------------------------------------------------
  if (/sponsor/.test(q)) {
    return pickYesNo(options, c.requiresSponsorship);
  }

  // --- Work authorization --------------------------------------------------
  if (/(authoriz|legally.*work|work.*(permit|visa|status))/.test(q)) {
    return pickYesNo(options, true);
  }

  // --- Notice period -----------------------------------------------------
  if (/notice period/.test(q)) {
    if (isChoice && options.length) {
      return (
        pickOption(options, [
          String(c.noticePeriodDays),
          "Immediate",
          "0-15 days",
          "0-30 days",
          "15 days",
          "Less than 30 days",
          "Immediately",
        ]) || options[0]
      );
    }
    // Free-text/number inputs for notice period on LinkedIn almost always
    // expect a plain number of days (validation rejects prose like
    // "Immediate / Currently serving notice period"), so default to that.
    return String(c.noticePeriodDays);
  }

  // --- Generic comfort / willingness / work-arrangement questions ---------
  // e.g. "Are you comfortable working in a Hybrid setup based out of
  // Bangalore (3 days in the office)?", "Are you open to X?", "Would you be
  // able to Y?". These are almost always soft screening questions where a
  // "No" risks an instant auto-reject, so default favorably (Yes) unless a
  // more specific rule above already matched.
  if (
    /(comfortable|would you be (able|willing)|are you (open|willing|ok|okay)|fine working|flexible (with|to)|able to work|willing to work)/.test(
      q
    )
  ) {
    return pickYesNo(options, true);
  }

  // --- Current CTC / salary ------------------------------------------------
  if (/(current.*(ctc|salary|compensation|pay))/.test(q)) {
    return /lpa|lakh/.test(q) ? String(c.currentCtcLpa) : String(c.currentCtcLpa * 100000);
  }

  // --- Expected CTC / salary expectation -----------------------------------
  if (/(expected.*(ctc|salary|compensation|pay)|salary expectation|expected.*(lpa|pay))/.test(q)) {
    return /lpa|lakh/.test(q) ? String(c.expectedCtcLpa) : String(c.expectedCtcLpa * 100000);
  }

  // --- Phone number — force our correct number over any stale saved value -
  if (/phone number/.test(q)) return c.phone;

  // --- Diversity / EEO questions — never guess, prefer neutral option ------
  if (/(gender|race|ethnicity|veteran|disability)/.test(q)) {
    return (
      pickOption(options, [
        "Prefer not to say",
        "Decline to answer",
        "I don't wish to answer",
      ]) || null
    );
  }

  // --- Background check / consent style questions -> generally agree ------
  if (/(background check|drug test|consent to)/.test(q)) {
    return pickYesNo(options, true);
  }

  // Unrecognized — let AI fallback handle it.
  return null;
}

export default matchKnownAnswer;
