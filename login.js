/**
 * One-time (or whenever your session expires) manual login helper.
 *
 * Opens a real, visible Chrome window at linkedin.com/login. You log in
 * yourself — including any 2FA/captcha/checkpoint — exactly like a normal
 * human session. Once you land on the LinkedIn feed, this script detects
 * it and closes, leaving the session saved in ./data/chrome-profile
 * for apply.js to reuse.
 *
 * Run: npm run login
 */
import { launchBrowser, getOrCreatePage } from "./browser.js";

async function main() {
  const context = await launchBrowser();
  const page = await getOrCreatePage(context);

  console.log("Opening LinkedIn — please log in manually in the browser window...");
  await page.goto("https://www.linkedin.com/login", { waitUntil: "domcontentloaded" });

  console.log("Waiting for you to finish logging in (feed page)...");
  try {
    await page.waitForURL(/linkedin\.com\/feed/, { timeout: 5 * 60 * 1000 });
    console.log("\nLogin detected! Session saved to ./data/chrome-profile");
    console.log("You can now run: npm start\n");
  } catch {
    console.log(
      "\nTimed out waiting for login. If you already logged in, just re-run this script or proceed with `npm start` directly.\n"
    );
  }

  await context.close();
}

main().catch((err) => {
  console.error("Fatal error during login setup:", err);
  process.exit(1);
});
