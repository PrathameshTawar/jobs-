/**
 * LinkedIn Auto-Apply (Easy Apply) for Internships
 * Automatically searches for Easy Apply internship listings on LinkedIn,
 * fills candidate details across multi-step modals, logs proof screenshots,
 * and supports --visible watch mode.
 *
 * Usage:
 *   node linkedin-auto-apply.js                    (Standard background run)
 *   node linkedin-auto-apply.js --visible          (Watch mode: visible Chrome browser)
 *   node linkedin-auto-apply.js --dry-run --visible (Dry-run mode: inspect forms without submitting)
 */

const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const { CV, CREDS, searchKeywords, headless: envHeadless, browserChannel: envChannel } = require('./config');
const { sendApplicationEmail, sendSummaryEmail } = require('./mailer');
const { fillForm } = require('./form-filler');
const { pace, isUnpaid } = require('./pace');

const PROFILE_DIR = path.join(__dirname, '.linkedin-chrome-profile');
const LOG_FILE = path.join(__dirname, 'linkedin-auto-apply.log');
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
    args: [
      '--disable-blink-features=AutomationControlled',
      ...(IS_VISIBLE ? ['--start-maximized'] : []),
      ...(!isHeadless && !IS_VISIBLE ? ['--window-position=-32000,-32000'] : []),
    ],
  };

  // Clean up stale lock files from previous runs to prevent about:blank hangs
  for (const file of ['lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const lockPath = path.join(PROFILE_DIR, file);
    if (fs.existsSync(lockPath)) {
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }

  try {
    return await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: envChannel || 'chrome',
      ...launchOptions,
    });
  } catch (err) {
    log(`Warning: Launching with channel "${envChannel}" failed, falling back to bundled Chromium.`);
    return await chromium.launchPersistentContext(PROFILE_DIR, launchOptions);
  }
}

async function verifyLogin(ctx, page) {
  log('Checking LinkedIn authentication status...');
  try {
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (err) {
    log(`Notice: Initial navigation retry due to browser startup: ${err.message.split('\n')[0]}`);
    await page.waitForTimeout(1500);
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  await page.waitForTimeout(3000);

  if (page.url().includes('/feed') || page.url().includes('/jobs')) {
    log('LinkedIn session verified.');
    return page;
  }

  log('Session expired or not logged in. Navigating to LinkedIn login page...');
  await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);

  if (CREDS.linkedinEmail && CREDS.linkedinPassword && CREDS.linkedinPassword !== 'your-linkedin-password') {
    const userBox = page.locator('#username, input[name="session_key"]').first();
    if (await userBox.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false)) {
      log(`Auto-filling LinkedIn login for ${CREDS.linkedinEmail}...`);
      await userBox.fill(CREDS.linkedinEmail);
      await page.locator('#password, input[name="session_password"]').first().fill(CREDS.linkedinPassword);
      await page.locator('button[type="submit"]:has-text("Sign in"), button:has-text("Sign in")').first().click();
      await page.waitForTimeout(5000);
    }
  }

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    for (const p of ctx.pages()) {
      try {
        if (p.url().includes('/feed') || p.url().includes('/jobs') || p.url().includes('/mynetwork')) {
          log('LinkedIn login successful. Persistent profile saved.');
          return p;
        }
      } catch {}
    }
    await page.waitForTimeout(2000);
  }
  throw new Error('LinkedIn authentication timed out after 5 minutes.');
}

async function handleEasyApplyForm(page, jobTitle, companyName, jobUrl = '') {
  // Wait up to 8 seconds for the Easy Apply modal dialog to appear
  const modalHandle = await page.waitForSelector(
    'div.jobs-easy-apply-modal, div.artdeco-modal[role="dialog"], div[role="dialog"]:has-text("Apply"), div[role="dialog"]:has-text("Easy Apply"), .jobs-easy-apply-content, div.artdeco-modal',
    { state: 'visible', timeout: 8000 }
  ).catch(() => null);

  if (!modalHandle) {
    log(`[SKIP] Easy Apply modal did not open for "${jobTitle}" at ${companyName}`);
    return false;
  }

  const modal = page.locator('div.jobs-easy-apply-modal, div.artdeco-modal[role="dialog"], div[role="dialog"], .artdeco-modal').first();

  let stepCount = 0;
  const maxSteps = 12;
  let lastModalHtml = '';

  while (stepCount < maxSteps) {
    stepCount++;
    await page.waitForTimeout(1500);

    // Auto fill all inputs using smart form filler
    await fillForm(modal, jobTitle, companyName, CV);

    // Check buttons: Submit vs Next vs Review
    const submitBtn = modal.locator([
      'button:has-text("Submit application")',
      'button[aria-label*="Submit application"]',
      'button:has-text("Submit")',
      'footer button:has-text("Submit")'
    ].join(', ')).first();

    const nextBtn = modal.locator([
      'button:has-text("Next")',
      'button:has-text("Review")',
      'button[aria-label*="Continue to next step"]',
      'button[aria-label*="Review your application"]',
      'footer button.artdeco-button--primary'
    ].join(', ')).first();

    const safeCompany = companyName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);
    const timeStamp = Date.now();

    if (await submitBtn.isVisible().catch(() => false)) {
      if (IS_DRY_RUN) {
        const screenshotPath = path.join(APPLICATIONS_DIR, `linkedin_dryrun_${safeCompany}_${timeStamp}.png`);
        await page.screenshot({ path: screenshotPath }).catch(() => {});
        log(`[DRY-RUN] Ready to submit LinkedIn application for "${jobTitle}" at ${companyName}`);
        
        // Close modal
        await modal.locator('button[aria-label*="Dismiss"], button.artdeco-modal__dismiss').first().click().catch(() => {});
        await page.waitForTimeout(1000);
        await page.locator('button:has-text("Discard"), button[data-control-name="discard_application_confirm_btn"]').first().click().catch(() => {});
        return false;
      }

      await submitBtn.click().catch(() => submitBtn.click({ force: true }));
      await page.waitForTimeout(3000);

      const screenshotPath = path.join(APPLICATIONS_DIR, `linkedin_applied_${safeCompany}_${timeStamp}.png`);
      await page.screenshot({ path: screenshotPath }).catch(() => {});
      log(`[APPLIED] LinkedIn Easy Apply submitted for "${jobTitle}" at ${companyName} (Proof: ${path.basename(screenshotPath)})`);
      await sendApplicationEmail({ platform: 'LinkedIn', jobTitle, company: companyName, screenshotPath, jobUrl });

      // Close completion modal if present
      const closeBtn = modal.locator('button[aria-label*="Dismiss"], button:has-text("Done")').first();
      if (await closeBtn.isVisible().catch(() => false)) {
        await closeBtn.click().catch(() => {});
      }
      await pace(log, 'application submitted');   // 30-45s human-like gap
      return true;
    }

    if (await nextBtn.isVisible().catch(() => false)) {
      const currentHtml = await modal.evaluate(el => el.innerHTML).catch(() => '');
      if (currentHtml === lastModalHtml) {
        // Retry fill form if stuck on step
        await fillForm(modal, jobTitle, companyName, CV);
      }
      lastModalHtml = currentHtml;

      await nextBtn.click().catch(() => nextBtn.click({ force: true }));
      await page.waitForTimeout(1500);
    } else {
      break; // No next or submit button available
    }
  }

  // Dismiss modal if incomplete
  const dismissBtn = modal.locator('button[aria-label*="Dismiss"], button.artdeco-modal__dismiss, button[data-test-modal-close-btn]').first();
  if (await dismissBtn.isVisible().catch(() => false)) {
    await dismissBtn.click().catch(() => {});
    await page.waitForTimeout(500);
    await page.locator('button:has-text("Discard"), button[data-control-name="discard_application_confirm_btn"], button[data-test-dialog-secondary-action]').first().click().catch(() => {});
  }
  return false;
}

async function processSearchKeyword(ctx, page, keywordOrUrl, sessionApplications) {
  let isDirectUrl = keywordOrUrl.startsWith('http://') || keywordOrUrl.startsWith('https://');
  let searchUrl = keywordOrUrl;
  
  if (isDirectUrl) {
    // Normalize /jobs/search-results/ to /jobs/search/ so LinkedIn loads the standard multi-card layout
    searchUrl = searchUrl.replace('/jobs/search-results/', '/jobs/search/').replace(/([?&])currentJobId=\d+&?/, '$1');
    if (searchUrl.endsWith('?') || searchUrl.endsWith('&')) searchUrl = searchUrl.slice(0, -1);
  } else {
    searchUrl = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(keywordOrUrl)}&f_AL=true&f_E=1&f_JT=I&f_TPR=r180000&origin=JOB_SEARCH_PAGE_JOB_FILTER`;
  }

  log(`--- LinkedIn Searching: "${keywordOrUrl}" -> ${searchUrl} ---`);

  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  // Scroll jobs sidebar list to trigger lazy-loaded cards
  const jobListContainer = page.locator('.jobs-search-results-list, div.jobs-search-results-list, .scaffold-layout__list-container, ul.jobs-search__results-list').first();
  if (await jobListContainer.isVisible().catch(() => false)) {
    for (const y of [300, 600, 900, 1200, 1800, 2400, 3000]) {
      await jobListContainer.evaluate((el, scrollY) => el.scrollTo(0, scrollY), y).catch(() => {});
      await page.waitForTimeout(300);
    }
  }

  const jobCards = await page.locator([
    '.job-card-container',
    '.jobs-search-results-list__list-item',
    'div[data-job-id]',
    'li.ember-view[data-occluded-item-urn]',
    '.scaffold-layout__list-item',
    'li[data-occluded-item-urn]'
  ].join(', ')).all();
  log(`Found ${jobCards.length} Easy Apply listings for search.`);

  const processed = new Set();
  let appliedCount = 0;
  const limit = isDirectUrl ? Math.min(jobCards.length, 25) : Math.min(jobCards.length, 12);

  for (let i = 0; i < limit; i++) {
    const card = jobCards[i];
    try {
      await card.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(300);

      const titleEl = card.locator('.job-card-list__title, a.job-card-container__link, a[class*="title"], .job-card-square__title').first();
      const companyEl = card.locator('.job-card-container__primary-description, .job-card-container__company-name, .job-card-container__subtitle').first();

      const title = (await titleEl.textContent().catch(() => 'Internship')).trim();
      const company = (await companyEl.textContent().catch(() => 'Company')).trim();

      const key = `${title}::${company}`.toLowerCase();
      if (processed.has(key)) continue;
      processed.add(key);

      const cardText = (await card.textContent().catch(() => '')).toLowerCase();
      if (cardText.includes('applied')) {
        log(`[SKIP] Already applied on LinkedIn to "${title}" at ${company}`);
        continue;
      }

      // Skip unpaid internships (paid-only filter)
      if (isUnpaid(`${title} ${cardText}`)) {
        log(`[SKIP] Unpaid internship listing skipped: "${title}" at ${company}`);
        continue;
      }

      // Click card title link to load job detail pane
      const titleLink = card.locator('a.job-card-list__title, a.job-card-container__link, a[href*="/jobs/view"]').first();
      if (await titleLink.isVisible().catch(() => false)) {
        await titleLink.click().catch(() => titleLink.click({ force: true }));
      } else {
        await card.click().catch(() => card.click({ force: true }));
      }
      await page.waitForTimeout(2500);

      // Inspect full job detail pane for unpaid terms
      const detailPane = page.locator('.jobs-search__job-details, .jobs-description-content, div.job-view-layout, .jobs-details, .scaffold-layout__detail, .job-details-jobs-unified-top-card').first();
      const detailText = (await detailPane.textContent().catch(() => '')).toLowerCase();
      if (isUnpaid(detailText)) {
        log(`[SKIP] Unpaid internship description skipped: "${title}" at ${company}`);
        continue;
      }

      // Scope directly inside the detailPane for the "Easy Apply" button
      const applyBtn = detailPane.locator([
        'div.jobs-apply-button--top-card button:has-text("Easy Apply")',
        'div.jobs-s-apply button:has-text("Easy Apply")',
        'button.jobs-apply-button:has-text("Easy Apply")',
        'button:has-text("Easy Apply")',
        'button[aria-label*="Easy Apply" i]'
      ].join(', ')).first();

      if (await applyBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
        await applyBtn.scrollIntoViewIfNeeded().catch(() => {});
        await applyBtn.click().catch(() => applyBtn.click({ force: true }));
        const res = await handleEasyApplyForm(page, title, company, page.url());
        if (res) {
          appliedCount++;
          sessionApplications.push({ title, company, url: page.url() });
        }
      } else {
        log(`[SKIP] External link or non-Easy Apply for "${title}" at ${company}`);
      }
    } catch (err) {
      log(`Warning: Error processing LinkedIn job #${i + 1}: ${err.message.split('\n')[0]}`);
    }
  }

  log(`Completed LinkedIn search round: ${appliedCount} application(s) processed.\n`);
}

(async () => {
  log(`Starting LinkedIn Auto-Apply (Mode: ${IS_DRY_RUN ? 'DRY-RUN' : 'LIVE'}, Visible: ${IS_VISIBLE})`);
  const ctx = await launchBrowser();
  await new Promise((r) => setTimeout(r, 1000));
  let page = ctx.pages()[0] || (await ctx.newPage());

  try {
    page = await verifyLogin(ctx, page);

    const customUrlArg = ARGS.find((arg) => arg.startsWith('--url='));
    let customUrl = customUrlArg ? customUrlArg.split('=').slice(1).join('=') : ARGS.find((arg) => arg.startsWith('http://') || arg.startsWith('https://'));

    const sessionApplications = [];
    if (customUrl) {
      await processSearchKeyword(ctx, page, customUrl, sessionApplications);
    } else {
      const keywords = searchKeywords.split(',').map((k) => k.trim()).filter(Boolean);
      for (const keyword of keywords) {
        await processSearchKeyword(ctx, page, keyword, sessionApplications);
      }
    }

    log('LinkedIn Auto-Apply session completed successfully.');
    await sendSummaryEmail({ platform: 'LinkedIn', appliedCount: sessionApplications.length, applications: sessionApplications });
  } catch (err) {
    log(`ERROR during LinkedIn auto-apply: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await ctx.close();
  }
})();

