const { chromium } = require('playwright');
const clipboardy = require('clipboardy');

function rand(min, max) { return Math.floor(Math.random() * (max - min)) + min; }

const HUMANIZEAI_PRO_WORD_LIMIT = 200;
function wordCount(text) { return text.trim().split(/\s+/).filter(Boolean).length; }

async function newStealthPage(browser) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 850 } });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return context.newPage();
}

// Pastes `text` the same way a human does: put it on the OS clipboard,
// click the field, select-all, then send a real Ctrl+V. This is a single
// genuine paste event (same as the manual workflow) instead of hundreds of
// synthetic keystrokes, so it's both faster and at least as human-looking.
async function humanLikePaste(page, locator, text) {
  clipboardy.writeSync(text);
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + 20, box.y + 20, { steps: rand(10, 20) });
  await page.waitForTimeout(rand(200, 400));
  await locator.click({ position: { x: 10, y: 10 } });
  await page.waitForTimeout(rand(150, 300));
  await page.keyboard.press('Control+A');
  await page.waitForTimeout(rand(80, 180));
  await page.keyboard.press('Control+V');
  await page.waitForTimeout(rand(300, 600));
}

async function clickHumanLike(page, locator) {
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: rand(10, 20) });
  await page.waitForTimeout(rand(200, 400));
  await locator.click();
}

// Waits for the output locator's value to change away from `previousValue`
// and then stop changing for `stableTicks` consecutive polls.
async function waitForNewStableValue(locator, previousValue, { maxSeconds = 90, stableTicks = 2 } = {}) {
  let prev = previousValue;
  let stableCount = 0;
  let changed = false;
  for (let i = 0; i < maxSeconds; i++) {
    await locator.page().waitForTimeout(1000);
    const val = await locator.inputValue().catch(() => '');
    if (!changed) {
      if (val && val !== previousValue) changed = true;
      else continue;
    }
    if (val === prev) {
      stableCount++;
      if (stableCount >= stableTicks) return val;
    } else {
      stableCount = 0;
    }
    prev = val;
  }
  return prev;
}

async function acceptCookiesIfPresent(page) {
  try {
    const acceptBtn = page.locator('button:has-text("Accept")').first();
    if (await acceptBtn.isVisible({ timeout: 3000 })) {
      await clickHumanLike(page, acceptBtn);
    }
  } catch (e) { /* no banner */ }
}

async function openPage(browser, url) {
  const page = await newStealthPage(browser);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(rand(1500, 2500));
  await acceptCookiesIfPresent(page);
  await page.waitForTimeout(rand(500, 1000));
  return page;
}

// Runs one humanize pass on an already-open humanizeai.pro page/tab.
// Reusing the tab (instead of reloading) skips the page-load + cookie-banner
// overhead on repeat passes.
async function runHumanizeAiPro(page, text) {
  const input = page.locator('textarea[aria-label="Input Textarea"]');
  const output = page.locator('textarea[aria-label="Output Textarea"]');
  const previousValue = await output.inputValue().catch(() => '');

  await humanLikePaste(page, input, text);
  await page.waitForTimeout(rand(500, 1000));

  const humanizeBtn = page.locator('button:has-text("Humanize AI")');
  await clickHumanLike(page, humanizeBtn);

  return waitForNewStableValue(output, previousValue);
}

async function runHumanizeAiText(page, text) {
  const input = page.locator('#inputText');
  const output = page.locator('#outputText');
  const previousValue = await output.inputValue().catch(() => '');

  await humanLikePaste(page, input, text);
  await page.waitForTimeout(rand(500, 1000));

  const humanizeBtn = page.locator('#humanizeBtn');
  await clickHumanLike(page, humanizeBtn);

  return waitForNewStableValue(output, previousValue);
}

// launchOptions: passed straight to chromium.launch() - lets callers pick
// the browser binary (Chrome via `channel`, Brave/other via `executablePath`).
async function run(launchOptions) {
  const original = clipboardy.readSync();
  if (!original || !original.trim()) {
    console.error('Clipboard is empty. Copy your source text first, then run this script.');
    process.exit(1);
  }
  const originalWords = wordCount(original);
  console.log(`Read ${original.length} chars (${originalWords} words) from clipboard.`);
  if (originalWords > HUMANIZEAI_PRO_WORD_LIMIT) {
    console.error(`Input is ${originalWords} words, over humanizeai.pro's ${HUMANIZEAI_PRO_WORD_LIMIT}-word limit. Use shorter input (170 words or less is a safe margin).`);
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    ...launchOptions,
  });

  try {
    console.log('Opening humanizeai.pro tab ...');
    const proPage = await openPage(browser, 'https://www.humanizeai.pro/');

    // Start loading humanizeaitext.org's tab now, in parallel with step 1 -
    // it doesn't depend on step 1's output, only on step 1 finishing before
    // we use it. By the time step 1's processing wraps up, this tab is
    // already loaded and past its cookie banner.
    const textPagePromise = openPage(browser, 'https://www.humanizeaitext.org/');

    console.log('Step 1/3: humanizeai.pro ...');
    const step1 = await runHumanizeAiPro(proPage, original);
    console.log(`  -> got ${step1.length} chars (${wordCount(step1)} words)`);

    const textPage = await textPagePromise;

    console.log('Step 2/3: humanizeaitext.org ...');
    const step2 = await runHumanizeAiText(textPage, step1);
    console.log(`  -> got ${step2.length} chars (${wordCount(step2)} words)`);
    await textPage.close();

    if (wordCount(step2) > HUMANIZEAI_PRO_WORD_LIMIT) {
      console.warn(`  WARNING: step 2 output is ${wordCount(step2)} words, over humanizeai.pro's ${HUMANIZEAI_PRO_WORD_LIMIT}-word limit - step 3 may get truncated by the site.`);
    }

    console.log('Step 3/3: humanizeai.pro (same tab, no reload) ...');
    const step3 = await runHumanizeAiPro(proPage, step2);
    console.log(`  -> got ${step3.length} chars (${wordCount(step3)} words)`);
    await proPage.close();

    clipboardy.writeSync(step3);
    console.log('\n=== FINAL HUMANIZED TEXT (copied to clipboard) ===\n');
    console.log(step3);
    return step3;
  } finally {
    await browser.close();
  }
}

module.exports = { run };
