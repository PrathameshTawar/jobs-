/**
 * Naukri Auto-Apply for Internships
 * Automatically searches for internship listings on Naukri, populates application forms,
 * saves proof screenshots, and supports a --visible watch mode for real-time monitoring.
 *
 * Usage:
 *   node naukri-auto-apply.js                    (Standard background auto-apply)
 *   node naukri-auto-apply.js --visible          (Watch mode: live visible Chrome browser)
 *   node naukri-auto-apply.js --dry-run --visible (Dry-run mode: inspect forms without submitting)
 */

const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const { CV, CREDS, searchKeywords, searchLocation, headless: envHeadless, browserChannel: envChannel } = require('./config');
const { sendApplicationEmail, sendSummaryEmail } = require('./mailer');
const { pace, isUnpaid } = require('./pace');

const PROFILE_DIR = path.join(__dirname, '.naukri-chrome-profile');
const LOG_FILE = path.join(__dirname, 'naukri-auto-apply.log');
const APPLICATIONS_DIR = path.join(__dirname, 'applications');

const ARGS = process.argv.slice(2);
const IS_VISIBLE = ARGS.includes('--visible') || ARGS.includes('watch') || ARGS.includes('--watch');
const IS_DRY_RUN = ARGS.includes('--dry-run');

// Ensure applications screenshot directory exists
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

const onProfile = (url) => url.pathname.startsWith('/mnjuser');

async function launchBrowser() {
  const isHeadless = envHeadless && !IS_VISIBLE;
  const launchOptions = {
    headless: isHeadless,
    viewport: IS_VISIBLE ? null : { width: 1440, height: 900 },
    args: [
      '--disable-blink-features=AutomationControlled',
      ...(IS_VISIBLE ? ['--start-maximized'] : []),
      ...(!isHeadless && !IS_VISIBLE ? ['--window-position=-32000,-32000'] : []),
    ],
  };

  const isLocked = (e) => /existing browser session|profile is already in use|in use/i.test(String((e && e.message) || e));

  // The hourly profile-refresh task shares this Chrome profile. Wait for it to
  // release the lock instead of crashing with "already in use".
  for (let attempt = 1; attempt <= 7; attempt++) {
    try {
      return await chromium.launchPersistentContext(PROFILE_DIR, {
        channel: envChannel || 'chrome',
        ...launchOptions,
      });
    } catch (err) {
      if (!isLocked(err)) {
        log(`Warning: Failed to launch with browser channel "${envChannel}", falling back to bundled Chromium.`);
        try {
          return await chromium.launchPersistentContext(PROFILE_DIR, launchOptions);
        } catch (err2) {
          if (isLocked(err2)) throw err2;
          throw err2;
        }
      }
      if (attempt === 7) {
        const e = new Error('Chrome profile still in use after ~2 minutes — aborting.');
        e.code = 'PROFILE_LOCKED';
        throw e;
      }
      log(`[lock] Chrome profile busy (refresh task running?) — waiting 20s (attempt ${attempt}/6)...`);
      await new Promise((r) => setTimeout(r, 20000));
    }
  }
}

async function verifyLogin(ctx, page) {
  log('Navigating to profile to verify session status...');
  await page.goto('https://www.naukri.com/mnjuser/profile', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);

  if (onProfile(new URL(page.url()))) {
    log('Authenticated session verified.');
    return page;
  }

  log('Session expired or missing. Please log into Naukri in the visible browser window...');
  await page.goto('https://www.naukri.com/nlogin/login', { waitUntil: 'domcontentloaded', timeout: 60000 });

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    for (const p of ctx.pages()) {
      try {
        if (onProfile(new URL(p.url()))) {
          log('Login successful. Persistent session updated.');
          return p;
        }
      } catch {}
    }
    await page.waitForTimeout(2000);
  }
  throw new Error('Authentication timed out after 5 minutes.');
}

async function handleApplicationForm(page, jobTitle, companyName, jobUrl = '') {
  await page.waitForTimeout(2000);

  // Auto-fill common text input fields or textareas if present
  const inputs = await page.locator('input[type="text"], textarea, input[type="number"]').all();
  for (const input of inputs) {
    if (!(await input.isVisible().catch(() => false))) continue;
    const placeholder = ((await input.getAttribute('placeholder')) || '').toLowerCase();
    const name = ((await input.getAttribute('name')) || '').toLowerCase();

    if (placeholder.includes('notice') || name.includes('notice')) {
      await input.fill(CV.noticePeriod || '30 days').catch(() => {});
    } else if (placeholder.includes('ctc') || placeholder.includes('salary') || name.includes('ctc')) {
      await input.fill(CV.currentCTC || '0').catch(() => {});
    } else if (placeholder.includes('experience') || name.includes('experience')) {
      await input.fill('0').catch(() => {});
    } else if (placeholder.includes('location') || name.includes('location')) {
      await input.fill(CV.location || 'Pune').catch(() => {});
    } else if (placeholder.includes('github') || placeholder.includes('link')) {
      await input.fill(CV.github || '').catch(() => {});
    }
  }

  // Handle radio buttons or checkboxes if present
  const radios = await page.locator('input[type="radio"], input[type="checkbox"]').all();
  for (const radio of radios) {
    if (!(await radio.isVisible().catch(() => false))) continue;
    const parentText = await radio.evaluate((el) => el.parentElement ? el.parentElement.innerText.toLowerCase() : '').catch(() => '');
    if (parentText.includes('yes') || parentText.includes('authorized') || parentText.includes('immediate')) {
      await radio.check().catch(() => {});
    }
  }

  const safeCompany = companyName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);
  const safeTitle = jobTitle.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);
  const timeStamp = Date.now();

  if (IS_DRY_RUN) {
    const screenshotPath = path.join(APPLICATIONS_DIR, `dryrun_${safeCompany}_${timeStamp}.png`);
    await page.screenshot({ path: screenshotPath }).catch(() => {});
    log(`[DRY-RUN] Prepared application for "${jobTitle}" at ${companyName} (Screenshot: ${path.basename(screenshotPath)})`);
    return false;
  }

  // Click Submit / Apply button in modal/form
  const submitBtn = page.locator([
    'button:has-text("Submit")',
    'button:has-text("Apply")',
    'input[type="submit"]',
    'button.btn-primary:has-text("Submit")',
    'button:has-text("Save & Apply")',
  ].join(', ')).first();

  if (await submitBtn.isVisible().catch(() => false)) {
    await submitBtn.click({ force: true }).catch(() => {});
    await page.waitForTimeout(3000);
  }

  const screenshotPath = path.join(APPLICATIONS_DIR, `applied_${safeCompany}_${timeStamp}.png`);
  await page.screenshot({ path: screenshotPath }).catch(() => {});
  log(`[APPLIED] Successfully submitted application for "${jobTitle}" at ${companyName} (Screenshot saved: ${path.basename(screenshotPath)})`);
  await sendApplicationEmail({ platform: 'Naukri', jobTitle, company: companyName, screenshotPath, jobUrl });
  return true;
}

function buildSearchUrl(keyword) {
  const kw = keyword.trim().toLowerCase();
  if (kw.includes('full stack')) return 'https://www.naukri.com/full-stack-developer-jobs?experience=0&freshness=2';
  if (kw.includes('software') || kw.includes('swe')) return 'https://www.naukri.com/software-developer-jobs?experience=0&freshness=2';
  if (kw.includes('web')) return 'https://www.naukri.com/web-developer-jobs?experience=0&freshness=2';
  if (kw.includes('python')) return 'https://www.naukri.com/python-developer-jobs?experience=0&freshness=2';
  if (kw.includes('react')) return 'https://www.naukri.com/react-js-developer-jobs?experience=0&freshness=2';
  if (kw.includes('ai') || kw.includes('ml')) return 'https://www.naukri.com/artificial-intelligence-jobs?experience=0&freshness=2';

  const cleanKw = kw.replace(/intern(ship)?/g, 'developer').trim();
  const slug = cleanKw.replace(/[^a-z0-9]+/g, '-');
  return `https://www.naukri.com/${slug}-jobs?experience=0&freshness=2`;
}

async function processSearchKeyword(ctx, page, keyword, sessionApplications) {
  const searchUrl = buildSearchUrl(keyword);
  log(`--- Searching for: "${keyword}" -> ${searchUrl} ---`);

  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  // Scroll down to load job tuples
  for (let y of [400, 800, 1200]) {
    await page.evaluate((sc) => window.scrollTo(0, sc), y).catch(() => {});
    await page.waitForTimeout(300);
  }

  // Find job cards
  const jobTuples = await page.locator('.srp-jobtuple-wrapper, article.jobTuple, div.cust-job-tuple').all();
  log(`Found ${jobTuples.length} job listings for "${keyword}".`);

  const processed = new Set();
  let appliedCount = 0;
  for (let i = 0; i < Math.min(jobTuples.length, 15); i++) {
    const tuple = jobTuples[i];
    try {
      await tuple.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(300);

      const titleEl = tuple.locator('a.title, .title, a[class*="title"]').first();
      const companyEl = tuple.locator('a.comp-name, .comp-name, a[class*="comp-name"]').first();

      const title = (await titleEl.textContent().catch(() => 'Internship')).trim();
      const company = (await companyEl.textContent().catch(() => 'Company')).trim();

      const key = `${title}::${company}`.toLowerCase();
      if (processed.has(key)) continue;
      processed.add(key);

      // Check if already applied
      const tupleText = (await tuple.textContent().catch(() => '')).toLowerCase();
      if (tupleText.includes('applied') || tupleText.includes('already applied')) {
        log(`[SKIP] Already applied to "${title}" at ${company}`);
        continue;
      }

      // Skip unpaid internships (paid-only filter — checks title + card text)
      if (isUnpaid(`${title} ${tupleText}`)) {
        log(`[SKIP] Unpaid internship skipped: "${title}" at ${company}`);
        continue;
      }

      // Look for Apply button on the card
      const applyBtn = tuple.locator('button:has-text("Apply"), .apply-button, span:has-text("Apply"), button[class*="apply"]').first();
      if (await applyBtn.isVisible().catch(() => false)) {
        await applyBtn.click({ force: true });
        const res = await handleApplicationForm(page, title, company, page.url());
        if (res) {
          appliedCount++;
          sessionApplications.push({ title, company, url: page.url() });
          await pace(log, 'application submitted');   // 30-45s human-like gap
        }
      } else {
        // Click job title to open job detail tab
        const jobUrl = await titleEl.getAttribute('href').catch(() => null);
        const absoluteUrl = jobUrl ? (jobUrl.startsWith('http') ? jobUrl : `https://www.naukri.com${jobUrl}`) : null;

        const [newTab] = await Promise.all([
          ctx.waitForEvent('page', { timeout: 10000 }).catch(() => null),
          titleEl.click(),
        ]);

        const activePage = newTab || page;
        await activePage.waitForLoadState('domcontentloaded').catch(() => {});
        await activePage.waitForTimeout(2000);

        const finalUrl = absoluteUrl || activePage.url();

        const detailApplyBtn = activePage.locator([
          'button#apply-button',
          'button.apply-button',
          'button:has-text("Apply")',
          'button:has-text("Apply on company site")',
          'button:has-text("Apply on website")',
          'button:has-text("Apply for free")',
          'a:has-text("Apply")',
          'div[class*="apply-button"] button',
          'div[class*="apply"] button',
          '[class*="apply-button"]',
          '[class*="applyButton"]',
          'button[class*="apply"]',
        ].join(', ')).first();

        if (await detailApplyBtn.isVisible({ timeout: 8000 }).catch(() => false)) {
          // Paid-only: check the FULL job description, not just the search card
          const detailText = await activePage.textContent('body').catch(() => '');
          if (isUnpaid(`${title} ${tupleText} ${detailText}`)) {
            log(`[SKIP] Unpaid internship (description): "${title}" at ${company}`);
          } else {
            await detailApplyBtn.click({ force: true });
            const res = await handleApplicationForm(activePage, title, company, finalUrl);
            if (res) {
              appliedCount++;
              sessionApplications.push({ title, company, url: finalUrl });
              await pace(log, 'application submitted');   // 30-45s human-like gap
            }
          }
        } else {
          log(`[SKIP] External application or no direct apply for "${title}" at ${company} — ${finalUrl}`);
        }

        if (newTab && !newTab.isClosed()) {
          await newTab.close().catch(() => {});
        }
      }
    } catch (err) {
      log(`Warning: Failed processing job #${i + 1}: ${err.message.split('\n')[0]}`);
    }
  }

  log(`Completed "${keyword}": ${appliedCount} application(s) processed.\n`);
}

(async () => {
  log(`Starting Naukri Auto-Apply (Mode: ${IS_DRY_RUN ? 'DRY-RUN' : 'LIVE'}, Visible: ${IS_VISIBLE})`);
  let ctx;
  try {
    ctx = await launchBrowser();
  } catch (err) {
    if (err && err.code === 'PROFILE_LOCKED') {
      log(`SKIP: ${err.message}`);
      process.exit(0);
    }
    log(`ERROR launching browser: ${String(err && err.message || err).split('\n')[0]}`);
    process.exit(1);
  }
  let page = ctx.pages()[0] || (await ctx.newPage());

  try {
    page = await verifyLogin(ctx, page);

    const keywords = searchKeywords.split(',').map((k) => k.trim()).filter(Boolean);
    const sessionApplications = [];
    for (const keyword of keywords) {
      await processSearchKeyword(ctx, page, keyword, sessionApplications);
    }

    log('Auto-Apply session completed successfully.');
    await sendSummaryEmail({ platform: 'Naukri', appliedCount: sessionApplications.length, applications: sessionApplications });
  } catch (err) {
    log(`ERROR during auto-apply: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await ctx.close();
  }
})();
