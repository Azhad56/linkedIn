# LinkedIn Easy Apply Automation

Standalone Playwright automation for LinkedIn Easy Apply. Uses your real
Chrome profile (logged in once), human-like pacing, a resume-based Q&A bank,
and optional local Ollama fallback for unknown questions.

## Setup

```bash
npm install
npx playwright install chrome
cp .env.example .env
# Edit .env with your phone/email/CTC/keywords
# Place your resume PDF as Azhad_Ghufran_Resume_2026.pdf (or update config)
```

Make sure [Ollama](https://ollama.com) is running with `llama3.2` if you want
AI answers for unrecognized questions (local only).

## Login (once)

```bash
npm run login
```

Log in manually in the Chrome window. Session is saved under
`data/chrome-profile/` (gitignored).

## Run

```bash
npm start
```

## Secrets

| What | Where |
|------|--------|
| Email, phone, CTC, etc. | `.env` (gitignored) |
| LinkedIn session | `data/chrome-profile/` (gitignored) |
| Password | Never stored |

## Files

```
apply.js         main Easy Apply script
login.js         one-time manual login
config.js        loads .env + search/safety settings
qaBank.js        rule-based application answers
aiFallback.js    local Ollama fallback
formFiller.js    Easy Apply modal driver
browser.js / humanize.js / logger.js / resumeText.js / loadEnv.js
.env.example     template for secrets
data/            runtime profile, logs, caches (gitignored)
```
