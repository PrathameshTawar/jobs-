/**
 * Indeed Auto-Apply (Easily Apply) for Internships
 * Automatically searches for "Easily Apply" internship listings on Indeed,
 * fills out application steps, logs proof screenshots, and supports --visible watch mode.
 *
 * Usage:
 *   node indeed-auto-apply.js                    (Standard background run)
 *   node indeed-auto-apply.js --visible          (Watch mode: visible Chrome browser)
 *   node indeed-auto-apply.js --dry-run --visible (Dry-run mode: inspect forms without submitting)
 */

const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const { CV, CREDS, searchKeywords, headless: envHeadless, browserChannel: envChannel } = require('./config');
const { sendApplicationEmail, sendSummaryEmail } = require('./mailer');
const { pace, isUnpaid } = require('./pace');

const PROFILE_DIR = path.join(__dirname, '.indeed-chrome-profile');
const LOG_FILE = path.join(__dirname, 'indeed-auto-apply.log');
const APPLICATIONS_DIR = path.join(__dirname, 'applications');

const ARGS = process.argv.slice(2);
const IS_VISIBLE = ARGS.includes('--visible') || ARGS.includes('watch') || ARGS.includes('--watch');
const IS_DRY_RUN = ARGS.includes('--dry-run');

if (!fs.existsSync(APPLICATIONS_DIR)) {
  fs.mkdirSync(APPLICATIONS_DIR, { recursive: true });
}

const log = (msg) => {
  const line = `[${new Date().toLocaleString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
};

async function launchBrowser() {
  const isHeadless = envHeadless && !IS_VISIBLE;
  const launchOptions = {
    headless: isHeadless,
    viewport: IS_VISIBLE ? null : { width: 1440, height: 900 },
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-infobars',
      '--window-size=1440,900',
      '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      ...(IS_VISIBLE ? ['--start-maximized'] : []),
      ...(!isHeadless && !IS_VISIBLE ? ['--window-position=-32000,-32000'] : []),
    ],
  };

  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: envChannel || 'chrome',
      ...launchOptions,
    });
  } catch (err) {
    log(`Warning: Launching with channel "${envChannel}" failed, falling back to bundled Chromium.`);
    ctx = await chromium.launchPersistentContext(PROFILE_DIR, launchOptions);
  }

  await ctx.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    } catch {}
  });

  return ctx;
}

// Sleep that does NOT depend on a page — immune to the window closing mid-wait.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Return an open page: the one we have if alive, else any other open tab,
// else a fresh one. Throws only if the whole browser/context is gone.
async function recoverPage(ctx, page) {
  if (page && !page.isClosed()) return page;
  const alive = (ctx.pages() || []).find((p) => !p.isClosed());
  if (alive) return alive;
  return ctx.newPage();
}

async function checkAndWaitCloudflare(page) {
  if (!page || page.isClosed()) {
    log('Page closed while waiting on Cloudflare.');
    return false;
  }

  const isCloudflare = await page.evaluate(() => {
    const text = document.body ? document.body.innerText : '';
    const title = document.title || '';
    return (
      text.includes('Additional Verification Required') ||
      text.includes('Troubleshooting Cloudflare Errors') ||
      title.includes('Just a moment...') ||
      title.includes('Attention Required!') ||
      !!document.querySelector('#challenge-running, #cf-challenge-running, iframe[src*="cloudflare"]')
    );
  }).catch(() => false);

  if (isCloudflare) {
    log('⚠️ Cloudflare security verification detected in browser window!');
    log('👉 Please click / complete the Cloudflare verification in the open browser window...');
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      if (page.isClosed()) {
        log('Browser page was closed.');
        return false;
      }
      try {
        await sleep(2000);   // page-independent: a closed window must not throw here
        const stillCloudflare = await page.evaluate(() => {
          const text = document.body ? document.body.innerText : '';
          const title = document.title || '';
          return (
            text.includes('Additional Verification Required') ||
            text.includes('Troubleshooting Cloudflare Errors') ||
            title.includes('Just a moment...') ||
            title.includes('Attention Required!')
          );
        }).catch(() => false);
        if (!stillCloudflare) {
          log('✅ Cloudflare verification completed!');
          await sleep(3000);
          return true;
        }
      } catch (e) {
        if (e.message.includes('closed')) {
          log('Browser window closed during Cloudflare verification.');
          break;
        }
      }
    }
  }
  return false;
}

async function isIndeedLoggedIn(page) {
  return await page.evaluate(() => {
    const bodyText = document.body ? document.body.innerText : '';
    const title = document.title || '';
    if (bodyText.includes('Additional Verification Required') || title.includes('Just a moment...')) {
      return false;
    }
    const hasAccountMenu = !!document.querySelector('[data-gnav-element-name="Account"], [aria-label*="Account"], a[href*="/account"], .gnav-AccountMenu');
    const hasSignInBtn = !!document.querySelector('a[href*="secure.indeed.com/account/login"], a:has-text("Sign in")');
    return hasAccountMenu || (!hasSignInBtn && (bodyText.includes('Find jobs') || bodyText.includes('Job search')));
  }).catch(() => false);
}

async function verifyLogin(ctx, page) {
  log('Checking Indeed authentication status...');
  page = await recoverPage(ctx, page);
  await page.goto('https://in.indeed.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);
  await checkAndWaitCloudflare(page);

  if (await isIndeedLoggedIn(page)) {
    log('Indeed session verified.');
    return page;
  }

  log('Session expired or not logged in. Navigating to Indeed login page...');
  page = await recoverPage(ctx, page);
  await page.goto('https://secure.indeed.com/account/login', { waitUntil: 'domcontentloaded', timeout: 60000 })
    .catch((err) => log(`(login page nav: ${err.message.split('\n')[0]})`));
  await sleep(2000);
  await checkAndWaitCloudflare(page);

  if (CREDS.indeedEmail && CREDS.indeedPassword && CREDS.indeedPassword !== 'your-indeed-password') {
    const emailInput = page.locator('input[name="__email"], input[type="email"]').first();
    if (await emailInput.isVisible().catch(() => false)) {
      log(`Auto-filling email: ${CREDS.indeedEmail}...`);
      await emailInput.fill(CREDS.indeedEmail);
      await page.locator('button[type="submit"]:has-text("Continue"), button:has-text("Next"), button[type="submit"]').first().click().catch(() => {});
      await sleep(2500);
      await checkAndWaitCloudflare(page);

      const passInput = page.locator('input[type="password"]').first();
      if (await passInput.isVisible().catch(() => false)) {
        log('Auto-filling password...');
        await passInput.fill(CREDS.indeedPassword);
        await page.locator('button[type="submit"]').first().click().catch(() => {});
        await sleep(3000);
        await checkAndWaitCloudflare(page);
      }
    }
  }

  log('Waiting for Indeed login / verification (please complete login in the browser window)...');
  const deadline = Date.now() + 10 * 60 * 1000;   // 10 min — enough time to finish login + CAPTCHA
  while (Date.now() < deadline) {
    await checkAndWaitCloudflare(page);
    for (const p of ctx.pages()) {
      try {
        if (!p.isClosed() && await isIndeedLoggedIn(p)) {
          log('Indeed login successful. Persistent session updated.');
          return p;
        }
      } catch {}
    }
    await sleep(2500);   // must not throw if the window is closed
    if ((ctx.pages() || []).every((p) => p.isClosed())) {
      throw new Error('Browser window was closed before login completed. Re-run with --visible and log in.');
    }
  }
  throw new Error('Indeed authentication timed out after 10 minutes.');
}

async function handleIndeedApplyForm(targetPage, jobTitle, companyName, jobUrl = '') {
  await sleep(2000);

  let stepCount = 0;
  const maxSteps = 10;

  while (stepCount < maxSteps) {
    stepCount++;
    await sleep(1000);

    // Auto fill text inputs & textareas
    const inputs = await targetPage.locator('input[type="text"], input[type="number"], input[type="tel"], textarea, select').all();
    for (const input of inputs) {
      if (!(await input.isVisible().catch(() => false))) continue;
      const labelText = await input.evaluate((el) => {
        const lbl = el.closest('label') || document.querySelector(`label[for="${el.id}"]`) || el.parentElement;
        return lbl ? lbl.innerText.toLowerCase() : '';
      }).catch(() => '');

      const val = await input.inputValue().catch(() => '');
      if (val && val.trim().length > 0) continue;

      if (labelText.includes('phone') || labelText.includes('mobile') || labelText.includes('contact')) {
        await input.fill(CV.phone || '+91 9999999999').catch(() => {});
      } else if (labelText.includes('city') || labelText.includes('location')) {
        await input.fill(CV.location || 'Pune').catch(() => {});
      } else if (labelText.includes('experience') || labelText.includes('years')) {
        await input.fill('1').catch(() => {});
      } else if (labelText.includes('notice')) {
        await input.fill(CV.noticePeriod || 'Immediate').catch(() => {});
      } else if (labelText.includes('salary') || labelText.includes('ctc')) {
        await input.fill(CV.currentCTC || '0').catch(() => {});
      }
    }

    // Check radio buttons
    const radios = await targetPage.locator('input[type="radio"]').all();
    for (const radio of radios) {
      if (!(await radio.isVisible().catch(() => false))) continue;
      const parentText = await radio.evaluate((el) => el.parentElement ? el.parentElement.innerText.toLowerCase() : '').catch(() => '');
      if (parentText.includes('yes') || parentText.includes('authorized') || parentText.includes('immediate')) {
        await radio.check().catch(() => {});
      }
    }

    const submitBtn = targetPage.locator('button:has-text("Submit your application"), button:has-text("Submit application"), button:has-text("Submit")').first();
    const continueBtn = targetPage.locator('button:has-text("Continue"), button:has-text("Review your application"), button:has-text("Next")').first();

    const safeCompany = companyName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);
    const timeStamp = Date.now();

    if (await submitBtn.isVisible().catch(() => false)) {
      if (IS_DRY_RUN) {
        const screenshotPath = path.join(APPLICATIONS_DIR, `indeed_dryrun_${safeCompany}_${timeStamp}.png`);
        await targetPage.screenshot({ path: screenshotPath }).catch(() => {});
        log(`[DRY-RUN] Ready to submit Indeed application for "${jobTitle}" at ${companyName}`);
        return false;
      }

      await submitBtn.click({ force: true }).catch(() => {});
      await sleep(3000);

      const screenshotPath = path.join(APPLICATIONS_DIR, `indeed_applied_${safeCompany}_${timeStamp}.png`);
      await targetPage.screenshot({ path: screenshotPath }).catch(() => {});
      log(`[APPLIED] Indeed application submitted for "${jobTitle}" at ${companyName} (Proof: ${path.basename(screenshotPath)})`);
      await sendApplicationEmail({ platform: 'Indeed', jobTitle, company: companyName, screenshotPath, jobUrl });
      await pace(log, 'application submitted');   // 30-45s human-like gap
      return true;
    }

    if (await continueBtn.isVisible().catch(() => false)) {
      await continueBtn.click({ force: true }).catch(() => {});
      await sleep(1500);
    } else {
      break;
    }
  }

  return false;
}

function buildIndeedSearchUrl(keyword) {
  const kw = keyword.trim().toLowerCase();
  let q = encodeURIComponent(keyword);
  if (kw.includes('full stack')) q = 'full+stack+developer+intern';
  else if (kw.includes('software') || kw.includes('swe')) q = 'software+developer+intern';
  else if (kw.includes('web')) q = 'web+developer+intern';
  // iabtf=1 = "Easily Apply" filter, fromage=2 = last 2 days (~50 hours), jt=internship
  return `https://in.indeed.com/jobs?q=${q}&fromage=2&jt=internship&iabtf=1`;
}

async function processSearchKeyword(ctx, page, keyword, sessionApplications) {
  const searchUrl = buildIndeedSearchUrl(keyword);
  log(`--- Indeed Searching for: "${keyword}" -> ${searchUrl} ---`);

  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);
  await checkAndWaitCloudflare(page);

  // Scroll job card column
  for (let y of [400, 800, 1200]) {
    await page.evaluate((sc) => window.scrollTo(0, sc), y).catch(() => {});
    await sleep(300);
  }

  const jobCards = await page.locator('div.job_seen_beacon, td.resultContent, div.cardOutline').all();
  log(`Found ${jobCards.length} job listings on Indeed for "${keyword}".`);

  const processed = new Set();
  let appliedCount = 0;

  for (let i = 0; i < Math.min(jobCards.length, 12); i++) {
    const card = jobCards[i];
    try {
      await card.scrollIntoViewIfNeeded().catch(() => {});
      await sleep(300);

      const titleEl = card.locator('a.jcs-JobTitle, h2.jobTitle a, a[data-jk]').first();
      const companyEl = card.locator('[data-testid="company-name"], span.companyName, div.company_location').first();

      const title = (await titleEl.textContent().catch(() => 'Internship')).trim();
      const company = (await companyEl.textContent().catch(() => 'Company')).trim();

      const key = `${title}::${company}`.toLowerCase();
      if (processed.has(key)) continue;
      processed.add(key);

      const cardText = (await card.textContent().catch(() => '')).toLowerCase();
      if (cardText.includes('applied')) {
        log(`[SKIP] Already applied on Indeed to "${title}" at ${company}`);
        continue;
      }

      // Skip unpaid internships (paid-only filter)
      if (isUnpaid(`${title} ${cardText}`)) {
        log(`[SKIP] Unpaid internship skipped: "${title}" at ${company}`);
        continue;
      }

      await titleEl.click({ force: true }).catch(() => {});
      await sleep(2000);

      // Check for Indeed "Easily Apply" button — multiple selectors for different regions
      const applyBtn = page.locator([
        'button:has-text("Apply now")',
        'button:has-text("Easily Apply")',
        'button:has-text("Apply on Indeed")',
        '.indeedApplyButton button',
        'button.ial-Btn',
        'button[data-indeed-apply-jobid]',
        '[id*="indeed-ia"] button',
        'div.ia-BasePage-footer button',
        'button.ia-continueButton',
      ].join(', ')).first();
      if (await applyBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        const [popup] = await Promise.all([
          ctx.waitForEvent('page', { timeout: 8000 }).catch(() => null),
          applyBtn.click({ force: true }),
        ]);

        const activePage = popup || page;
        const res = await handleIndeedApplyForm(activePage, title, company, page.url());
        if (res) {
          appliedCount++;
          sessionApplications.push({ title, company, url: page.url() });
        }

        if (popup && !popup.isClosed()) {
          await popup.close().catch(() => {});
        }
      } else {
        log(`[SKIP] External link or non-direct apply on Indeed for "${title}" at ${company}`);
      }
    } catch (err) {
      log(`Warning: Error processing Indeed job #${i + 1}: ${err.message.split('\n')[0]}`);
    }
  }

  log(`Completed Indeed "${keyword}": ${appliedCount} application(s) processed.\n`);
}

// True when an error means the browser/window went away (vs a real logic bug).
const isClosedErr = (e) => /Target (page|context|browser) has been closed|browser has been closed|disconnected|browserContext\./i.test(String((e && e.message) || ''));

// One full run: launch -> login -> apply across all keywords.
// Throws if the window dies; caller decides whether to retry.
async function runOnce(sessionApplications) {
  const ctx = await launchBrowser();
  ctx.on('close', () => log('⚠️ Indeed browser window/context was closed.'));
  try {
    let page = ctx.pages()[0] || (await ctx.newPage());
    page = await verifyLogin(ctx, page);
    page = await recoverPage(ctx, page);   // login may have happened in another tab

    const keywords = searchKeywords.split(',').map((k) => k.trim()).filter(Boolean);
    for (const keyword of keywords) {
      page = await recoverPage(ctx, page);
      if (!page) throw new Error('Browser window was closed during the run.');
      await processSearchKeyword(ctx, page, keyword, sessionApplications);
    }
    return true;
  } finally {
    await ctx.close().catch(() => {});   // already-dead context must not mask the real error
  }
}

(async () => {
  log(`Starting Indeed Auto-Apply (Mode: ${IS_DRY_RUN ? 'DRY-RUN' : 'LIVE'}, Visible: ${IS_VISIBLE})`);
  const sessionApplications = [];
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const ok = await runOnce(sessionApplications);
      if (ok) {
        log('Indeed Auto-Apply session completed successfully.');
        await sendSummaryEmail({ platform: 'Indeed', appliedCount: sessionApplications.length, applications: sessionApplications });
      }
      break;
    } catch (err) {
      if (isClosedErr(err) && attempt < MAX_ATTEMPTS) {
        log(`⚠️ Browser window closed unexpectedly (attempt ${attempt}/${MAX_ATTEMPTS}). Relaunching in 8s.`);
        log('   👉 Please leave the Indeed window OPEN after logging in — closing it stops the run.');
        await sleep(8000);
        continue;
      }
      log(`ERROR during Indeed auto-apply: ${err.message}`);
      process.exitCode = 1;
      break;
    }
  }
})();
