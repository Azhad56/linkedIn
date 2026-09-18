/**
 * Extracts and caches plain text from the resume PDF so it can be used
 * as grounding context for the AI fallback when answering unknown
 * application questions.
 */
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "./config.js";

let cached = null;

export async function getResumeText() {
  if (cached) return cached;

  if (fs.existsSync(CONFIG.files.resumeText)) {
    const saved = JSON.parse(fs.readFileSync(CONFIG.files.resumeText, "utf8"));
    if (saved?.text) {
      cached = saved.text;
      return cached;
    }
  }

  const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
  const buffer = fs.readFileSync(CONFIG.candidate.resumePath);
  const data = await pdfParse(buffer);
  cached = data.text.replace(/\s+\n/g, "\n").trim();

  fs.mkdirSync(path.dirname(CONFIG.files.resumeText), { recursive: true });
  fs.writeFileSync(
    CONFIG.files.resumeText,
    JSON.stringify({ text: cached, extractedAt: new Date().toISOString() }, null, 2)
  );

  return cached;
}
