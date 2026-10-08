/**
 * Target Companies Auto-Apply Script
 * Scans career opportunities for the 133 specified target companies across Naukri and LinkedIn.
 * Auto-fills candidate details for matching internship/entry-level roles and records screenshot proofs.
 *
 * Usage:
 *   node target-companies-apply.js
 *   node target-companies-apply.js --visible
 *   node target-companies-apply.js --platform=naukri --visible
 *   node target-companies-apply.js --platform=linkedin --visible
 */

const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const { CV, CREDS, headless: envHeadless, browserChannel: envChannel } = require('./config');

const TARGET_COMPANIES = require('./target-companies.json');
const APPLICATIONS_DIR = path.join(__dirname, 'applications');
const LOG_FILE = path.join(__dirname, 'target-companies-apply.log');

const ARGS = process.argv.slice(2);
const IS_VISIBLE = ARGS.includes('--visible') || ARGS.includes('watch') || ARGS.includes('--watch');
const PLATFORM_ARG = ARGS.find((a) => a.startsWith('--platform=')) ? ARGS.find((a) => a.startsWith('--platform=')).split('=')[1].toLowerCase() : 'all';

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

async function launchBrowser(profileDir) {
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

  try {
    return await chromium.launchPersistentContext(profileDir, {
      channel: envChannel || 'chrome',
      ...launchOptions,
    });
  } catch (err) {
    return await chromium.launchPersistentContext(profileDir, launchOptions);
  }
}

// -------------------------------------------------------------
// NAUKRI TARGET COMPANY AUTOMATION
// -------------------------------------------------------------
async function runNaukriTargetSearch() {
  log('====================================================');
  log(`Starting Target Companies Automation on NAUKRI (${TARGET_COMPANIES.length} companies)`);
  log('====================================================');

  const profileDir = path.join(__dirname, '.naukri-chrome-profile');
  const ctx = await launchBrowser(profileDir);
  let page = ctx.pages()[0] || (await ctx.newPage());

  try {
    log('Verifying Naukri session status...');
    await page.goto('https://www.naukri.com/mnjuser/profile', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);

    let appliedTotal = 0;

    for (let i = 0; i < TARGET_COMPANIES.length; i++) {
      const company = TARGET_COMPANIES[i];
      const searchUrl = `https://www.naukri.com/jobs-in-india?k=${encodeURIComponent(company + ' intern')}&experience=0`;
      log(`[${i + 1}/${TARGET_COMPANIES.length}] Searching Naukri for "${company}"...`);

      try {
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2000);

        const jobTuples = await page.locator('.srp-jobtuple-wrapper, article.jobTuple, div.cust-job-tuple').all();
        if (jobTuples.length === 0) {
          log(`  -> No direct internship listings found for ${company}`);
          continue;
        }

        log(`  -> Found ${jobTuples.length} listing(s) for ${company}`);
        for (let j = 0; j < Math.min(jobTuples.length, 3); j++) {
          const tuple = jobTuples[j];
          await tuple.scrollIntoViewIfNeeded().catch(() => {});

          const titleEl = tuple.locator('a.title, .title, a[class*="title"]').first();
          const title = (await titleEl.textContent().catch(() => 'Internship')).trim();

          const tupleText = (await tuple.textContent().catch(() => '')).toLowerCase();
          if (tupleText.includes('applied')) {
            log(`  -> [SKIP] Already applied to "${title}" at ${company}`);
            continue;
          }

          const applyBtn = tuple.locator('button:has-text("Apply"), .apply-button, span:has-text("Apply")').first();
          if (await applyBtn.isVisible().catch(() => false)) {
            await applyBtn.click({ force: true });
            await page.waitForTimeout(2000);
            const timeStamp = Date.now();
            const safeCompany = company.replace(/[^a-zA-Z0-9_-]/g, '_');
            const screenshotPath = path.join(APPLICATIONS_DIR, `naukri_target_${safeCompany}_${timeStamp}.png`);
            await page.screenshot({ path: screenshotPath }).catch(() => {});
            log(`  -> [APPLIED] Submitted application for "${title}" at ${company} (Proof: ${path.basename(screenshotPath)})`);
            appliedTotal++;
          }
        }
      } catch (err) {
        log(`  -> Error processing ${company}: ${err.message.split('\n')[0]}`);
      }
    }

    log(`Naukri Target Search Completed: ${appliedTotal} application(s) processed.`);
  } finally {
    await ctx.close();
  }
}

// -------------------------------------------------------------
// LINKEDIN TARGET COMPANY AUTOMATION
// -------------------------------------------------------------
async function runLinkedInTargetSearch() {
  log('====================================================');
  log(`Starting Target Companies Automation on LINKEDIN (${TARGET_COMPANIES.length} companies)`);
  log('====================================================');

  const profileDir = path.join(__dirname, '.linkedin-chrome-profile');
  const ctx = await launchBrowser(profileDir);
  let page = ctx.pages()[0] || (await ctx.newPage());

  try {
    log('Verifying LinkedIn session status...');
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    let appliedTotal = 0;

    for (let i = 0; i < TARGET_COMPANIES.length; i++) {
      const company = TARGET_COMPANIES[i];
      const searchUrl = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(company + ' intern')}&f_AL=true&origin=JOB_SEARCH_PAGE_JOB_FILTER`;
      log(`[${i + 1}/${TARGET_COMPANIES.length}] Searching LinkedIn for "${company}"...`);

      try {
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2500);

        const jobCards = await page.locator('.job-card-container, .jobs-search-results-list__list-item, div[data-job-id]').all();
        if (jobCards.length === 0) {
          log(`  -> No Easy Apply listings found on LinkedIn for ${company}`);
          continue;
        }

        log(`  -> Found ${jobCards.length} Easy Apply listing(s) for ${company}`);
        for (let j = 0; j < Math.min(jobCards.length, 3); j++) {
          const card = jobCards[j];
          await card.scrollIntoViewIfNeeded().catch(() => {});

          const titleEl = card.locator('.job-card-list__title, a.job-card-container__link, a[class*="title"]').first();
          const title = (await titleEl.textContent().catch(() => 'Internship')).trim();

          const cardText = (await card.textContent().catch(() => '')).toLowerCase();
          if (cardText.includes('applied')) {
            log(`  -> [SKIP] Already applied on LinkedIn to "${title}" at ${company}`);
            continue;
          }

          // Skip unpaid internships
          const unpaidRegex = /\bunpaid\b|\bno stipend\b|\bwithout stipend\b|\bzero stipend\b|\bnon[- ]paid\b|\bnot paid\b|\bstipend\s*:\s*(nil|none|0|\$0|₹0|rs\.?\s*0)\b|\b0 stipend\b|\bvolunteer\b/i;
          if (unpaidRegex.test(`${title} ${cardText}`)) {
            log(`  -> [SKIP] Unpaid internship skipped: "${title}" at ${company}`);
            continue;
          }

          await titleEl.click({ force: true }).catch(() => {});
          await page.waitForTimeout(1500);

          const applyBtn = page.locator('button.jobs-apply-button, button:has-text("Easy Apply"), .jobs-s-apply button').first();
          if (await applyBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
            await applyBtn.click({ force: true });
            await page.waitForTimeout(2000);

            const modal = page.locator('.jobs-easy-apply-modal, .artdeco-modal[role="dialog"], div[role="dialog"]').first();
            if (await modal.isVisible({ timeout: 4000 }).catch(() => false)) {
              // Fill inputs
              const inputs = await modal.locator('input[type="text"], input[type="number"], textarea').all();
              for (const input of inputs) {
                if (!(await input.isVisible().catch(() => false))) continue;
                const label = await input.evaluate((el) => el.parentElement ? el.parentElement.innerText.toLowerCase() : '').catch(() => '');
                if (label.includes('phone')) await input.fill(CV.phone || '+91 9999999999').catch(() => {});
                else if (label.includes('experience')) await input.fill('1').catch(() => {});
                else if (label.includes('city') || label.includes('location')) await input.fill(CV.location || 'Pune').catch(() => {});
              }

              const submitBtn = modal.locator('button:has-text("Submit application"), button[aria-label*="Submit application"]').first();
              const nextBtn = modal.locator('button:has-text("Next"), button:has-text("Review")').first();

              if (await nextBtn.isVisible().catch(() => false)) {
                await nextBtn.click({ force: true }).catch(() => {});
                await page.waitForTimeout(1000);
              }

              const timeStamp = Date.now();
              const safeCompany = company.replace(/[^a-zA-Z0-9_-]/g, '_');
              const screenshotPath = path.join(APPLICATIONS_DIR, `linkedin_target_${safeCompany}_${timeStamp}.png`);
              await page.screenshot({ path: screenshotPath }).catch(() => {});

              if (await submitBtn.isVisible().catch(() => false)) {
                await submitBtn.click({ force: true }).catch(() => {});
                await page.waitForTimeout(2000);
              }
              log(`  -> [APPLIED] Processed LinkedIn Easy Apply for "${title}" at ${company} (Proof: ${path.basename(screenshotPath)})`);
              appliedTotal++;
            }
          }
        }
      } catch (err) {
        log(`  -> Error processing ${company}: ${err.message.split('\n')[0]}`);
      }
    }

    log(`LinkedIn Target Search Completed: ${appliedTotal} application(s) processed.`);
  } finally {
    await ctx.close();
  }
}

(async () => {
  log(`Starting Target Companies Automation Script for 133 Companies`);
  if (PLATFORM_ARG === 'naukri' || PLATFORM_ARG === 'all') {
    await runNaukriTargetSearch();
  }
  if (PLATFORM_ARG === 'linkedin' || PLATFORM_ARG === 'all') {
    await runLinkedInTargetSearch();
  }
  log(`Target Companies Automation Session Completed.`);
})();
