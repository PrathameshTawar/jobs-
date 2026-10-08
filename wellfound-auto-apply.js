/**
 * Wellfound (AngelList Talent) Auto-Apply Script
 * Automatically applies to matching internship & entry-level roles on Wellfound.
 *
 * Usage:
 *   node wellfound-auto-apply.js login        # Log in & save session to .wellfound-chrome-profile
 *   node wellfound-auto-apply.js              # Dry run (form filling, no submission)
 *   node wellfound-auto-apply.js --live       # Live application mode
 *   node wellfound-auto-apply.js --visible    # Run with visible browser
 */

const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const { CV, CREDS, headless: envHeadless, browserChannel: envChannel, searchKeywords, geminiKey } = require('./config');
const { sendApplicationEmail, sendSummaryEmail } = require('./mailer');
const { pace, isUnpaid } = require('./pace');

const PROFILE_DIR = path.join(__dirname, '.wellfound-chrome-profile');
const APPLICATIONS_DIR = path.join(__dirname, 'applications');
const CSV_FILE = path.join(__dirname, 'applications.csv');
const STATE_FILE = path.join(__dirname, 'apply-state-wellfound.json');
const LOG_FILE = path.join(__dirname, 'auto-apply-wellfound.log');

const ARGS = process.argv.slice(2);
const IS_LOGIN_MODE = ARGS.includes('login');
const IS_LIVE = ARGS.includes('--live') || ARGS.includes('live');
const IS_VISIBLE = ARGS.includes('--visible') || ARGS.includes('watch') || IS_LOGIN_MODE;
const DAILY_CAP = 50;

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

function getTodayCount() {
  const today = new Date().toISOString().split('T')[0];
  if (!fs.existsSync(STATE_FILE)) return { date: today, count: 0 };
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (data.date === today) return data;
  } catch {}
  return { date: today, count: 0 };
}

function incrementTodayCount() {
  const state = getTodayCount();
  state.count += 1;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  return state.count;
}

function appendToCsv(role, company, salary, skills, jobLink) {
  const date = new Date().toISOString();
  const line = `"${date}","Wellfound","${role.replace(/"/g, '""')}","${company.replace(/"/g, '""')}","${salary}","${skills}","${jobLink}"\n`;
  if (!fs.existsSync(CSV_FILE)) {
    fs.writeFileSync(CSV_FILE, 'Date,Site,Role,Company,Salary,Skills,JobLink\n');
  }
  fs.appendFileSync(CSV_FILE, line);
}

function generateCoverLetter(role, company) {
  return `Hi ${company} Hiring Team,

I am excited to apply for the ${role} position. As a passionate developer skilled in ${CV.skills}, I have built robust web applications, AI tools, and full-stack solutions.

Highlights of my experience:
- ${CV.highlights[0] || 'Proven track record of delivering clean, scalable JavaScript/TypeScript and Python code.'}
- ${CV.highlights[1] || 'Hands-on experience developing REST APIs, frontend interfaces, and database architectures.'}

Education: ${CV.education}
Location: ${CV.location} (Open to relocation & remote work)
Notice Period: ${CV.noticePeriod}

I would love the opportunity to contribute to ${company}'s products and team. 

Best regards,
${CV.name}
Email: ${CV.email} | Phone: ${CV.phone}
Portfolio: ${CV.portfolio} | GitHub: ${CV.github}`;
}

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

  try {
    return await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: envChannel || 'chrome',
      ...launchOptions,
    });
  } catch (err) {
    return await chromium.launchPersistentContext(PROFILE_DIR, launchOptions);
  }
}

async function verifyLogin(ctx, page) {
  log('Checking Wellfound authentication status...');
  await page.goto('https://wellfound.com/jobs', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  if (page.url().includes('/jobs') || page.url().includes('/dashboard')) {
    const isLoggedOut = await page.locator('a[href*="/login"], button:has-text("Log In")').first().isVisible().catch(() => false);
    if (!isLoggedOut) {
      log('Wellfound session verified.');
      return page;
    }
  }

  log('Session expired or not logged in. Navigating to Wellfound login page...');
  await page.goto('https://wellfound.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);

  if (CREDS.wellfoundEmail && CREDS.wellfoundPassword) {
    const emailInput = page.locator('input[type="email"], input[name="user[email]"]').first();
    if (await emailInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      log(`Auto-filling Wellfound login credentials for ${CREDS.wellfoundEmail}...`);
      await emailInput.fill(CREDS.wellfoundEmail);
      await page.locator('input[type="password"], input[name="user[password]"]').first().fill(CREDS.wellfoundPassword);
      await page.locator('input[type="submit"], button[type="submit"], button:has-text("Log in")').first().click();
      await page.waitForTimeout(5000);
    }
  }

  if (IS_LOGIN_MODE) {
    log('Interactive login mode active. Please log in manually if prompted, then press Enter in console.');
  }

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    for (const p of ctx.pages()) {
      try {
        if (p.url().includes('/jobs') || p.url().includes('/overview') || p.url().includes('/profile')) {
          log('Wellfound login verified and persistent profile updated.');
          return p;
        }
      } catch {}
    }
    await page.waitForTimeout(2000);
  }

  throw new Error('Wellfound authentication timed out after 5 minutes.');
}

// Ask Gemini to answer a form question we don't have a hardcoded answer for
async function askGemini(question, context) {
  if (!geminiKey) return null;
  try {
    const prompt = `You are filling out a job application form for ${context.role} at ${context.company}.
Candidate profile:
- Name: ${CV.name}
- Skills: ${CV.skills}
- Experience: ${CV.yearsOfExperience}
- Education: ${CV.education}
- Location: ${CV.location}
- Notice period: ${CV.noticePeriod}

Question from the form: "${question}"

Reply with ONLY the answer text, no explanation, no quotes, keep it short (under 100 words), professional, and positive.`;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      }
    );
    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
  } catch {
    return null;
  }
}

async function fillInput(input, label, roleTitle, companyName) {
  const l = label.toLowerCase();
  // Hardcoded fast answers
  if (l.includes('phone') || l.includes('mobile')) return input.fill(CV.phone).catch(() => {});
  if (l.includes('notice')) return input.fill(CV.noticePeriod).catch(() => {});
  if (l.includes('experience') || l.includes('years of exp')) return input.fill('1').catch(() => {});
  if (l.includes('ctc') || l.includes('salary') || l.includes('compensation')) return input.fill(CV.expectedSalary || '0').catch(() => {});
  if (l.includes('city') || l.includes('location')) return input.fill(CV.location).catch(() => {});
  if (l.includes('github')) return input.fill(CV.github).catch(() => {});
  if (l.includes('linkedin')) return input.fill(CV.linkedin).catch(() => {});
  if (l.includes('portfolio') || l.includes('website')) return input.fill(CV.portfolio).catch(() => {});
  if (l.includes('name')) return input.fill(CV.name).catch(() => {});
  if (l.includes('email')) return input.fill(CV.email).catch(() => {});

  // For textarea / open-ended questions — use Gemini if available
  const tag = await input.evaluate(el => el.tagName).catch(() => '');
  if (tag === 'TEXTAREA' && label.length > 5) {
    const answer = await askGemini(label, { role: roleTitle, company: companyName });
    if (answer) return input.fill(answer).catch(() => {});
  }
}

async function handleApplyForm(page, roleTitle, companyName, jobUrl) {
  await page.waitForTimeout(2000);

  // Wellfound apply panel — try multiple selectors
  const modalSelectors = [
    'div[role="dialog"]',
    '[class*="applyPanel"]',
    '[class*="apply-panel"]',
    '[class*="modal"]',
    '[class*="Modal"]',
    '[class*="drawer"]',
    '[class*="Drawer"]',
    'form',
  ];

  let modal = null;
  for (const sel of modalSelectors) {
    const candidate = page.locator(sel).first();
    if (await candidate.isVisible({ timeout: 2000 }).catch(() => false)) {
      modal = candidate;
      break;
    }
  }

  // If no modal, the apply form might be inline on the page itself
  if (!modal) {
    log(`  -> No modal found, trying inline page form for "${roleTitle}" at ${companyName}`);
    modal = page.locator('body');
  }

  // Cover letter / intro textarea
  const coverLetterBox = modal.locator(
    'textarea[name="note"], textarea[name="cover_letter"], textarea[placeholder*="note" i], textarea[placeholder*="cover" i], textarea[placeholder*="introduce" i], textarea[placeholder*="why" i], textarea'
  ).first();
  if (await coverLetterBox.isVisible({ timeout: 3000 }).catch(() => false)) {
    const coverText = generateCoverLetter(roleTitle, companyName);
    await coverLetterBox.fill(coverText);
    log(`  -> Cover letter filled for ${companyName}`);
  }

  // Multi-step form loop — keep filling and clicking Next/Submit until done
  let stepCount = 0;
  const maxSteps = 8;

  while (stepCount < maxSteps) {
    stepCount++;
    await page.waitForTimeout(1000);

    // Fill all visible text/number inputs
    const inputs = await modal.locator('input[type="text"], input[type="number"], input[type="tel"], input[type="email"], input[type="url"], textarea, select').all();
    for (const input of inputs) {
      if (!(await input.isVisible().catch(() => false))) continue;
      const currentVal = await input.inputValue().catch(() => '');
      if (currentVal && currentVal.trim().length > 0) continue; // already filled

      // Get label text from multiple sources
      const label = await input.evaluate(el => {
        // 1. <label for="id">
        if (el.id) {
          const lbl = document.querySelector(`label[for="${el.id}"]`);
          if (lbl) return lbl.innerText.trim();
        }
        // 2. Closest label ancestor
        const anc = el.closest('label');
        if (anc) return anc.innerText.trim();
        // 3. Previous sibling or parent text
        const parent = el.parentElement;
        if (parent) return parent.innerText.trim().split('\n')[0];
        return '';
      }).catch(() => '');

      const tag = await input.evaluate(el => el.tagName).catch(() => '');
      if (tag === 'SELECT') {
        // Pick first non-empty option
        await input.selectOption({ index: 1 }).catch(() => {});
      } else {
        await fillInput(input, label, roleTitle, companyName);
      }
    }

    // Handle radio buttons — prefer Yes / Authorized / Open to relocate
    const radios = await modal.locator('input[type="radio"]').all();
    for (const radio of radios) {
      if (!(await radio.isVisible().catch(() => false))) continue;
      const parentText = await radio.evaluate(el => {
        const lbl = el.closest('label') || el.parentElement;
        return lbl ? lbl.innerText.toLowerCase() : '';
      }).catch(() => '');
      if (/\byes\b|authorized|immediate|open|agree|relocate/.test(parentText)) {
        await radio.check().catch(() => {});
      }
    }

    // Handle checkboxes
    const checkboxes = await modal.locator('input[type="checkbox"]').all();
    for (const cb of checkboxes) {
      if (!(await cb.isVisible().catch(() => false))) continue;
      const parentText = await cb.evaluate(el => (el.closest('label') || el.parentElement)?.innerText?.toLowerCase() || '').catch(() => '');
      if (/agree|authorize|consent|terms|confirm/.test(parentText)) {
        await cb.check().catch(() => {});
      }
    }

    // Screenshot before submit
    const timeStamp = Date.now();
    const safeCompany = companyName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);
    const screenshotPath = path.join(APPLICATIONS_DIR, `wellfound_${safeCompany}_${timeStamp}.png`);
    await page.screenshot({ path: screenshotPath }).catch(() => {});

    // Find Submit / Send / Apply button
    const submitBtn = modal.locator([
      'button:has-text("Send application")',
      'button:has-text("Submit application")',
      'button:has-text("Submit")',
      'button:has-text("Apply")',
      'button:has-text("Send")',
      'button[type="submit"]',
      'input[type="submit"]',
    ].join(', ')).first();

    const nextBtn = modal.locator([
      'button:has-text("Next")',
      'button:has-text("Continue")',
      'button:has-text("Review")',
    ].join(', ')).first();

    if (!IS_LIVE) {
      log(`  -> [DRY RUN] Would submit for "${roleTitle}" at ${companyName} (step ${stepCount})`);
      return true;
    }

    if (await submitBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await submitBtn.click({ force: true });
      await page.waitForTimeout(3000);

      // Check for success confirmation
      const bodyText = await page.textContent('body').catch(() => '');
      const success = /application submitted|you applied|thank you|sent successfully/i.test(bodyText);

      const count = incrementTodayCount();
      appendToCsv(roleTitle, companyName, 'N/A', CV.skills, jobUrl);
      log(`  -> [APPLIED] Submitted to "${roleTitle}" at ${companyName} (${count}/${DAILY_CAP} today)${success ? ' ✓ confirmed' : ''}`);
      await sendApplicationEmail({ platform: 'Wellfound', jobTitle: roleTitle, company: companyName, jobUrl, screenshotPath });
      await pace(log, 'application submitted');   // 30-45s human-like gap
      return true;
    }

    if (await nextBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await nextBtn.click({ force: true });
      await page.waitForTimeout(1500);
      continue;
    }

    // Nothing to click — done
    break;
  }

  log(`  -> [SKIP] Could not complete apply form for "${roleTitle}" at ${companyName}`);
  return false;
}

async function runAutoApply() {
  const state = getTodayCount();
  log(`Starting Wellfound Auto-Apply (Mode: ${IS_LIVE ? 'LIVE' : 'DRY-RUN'}, Visible: ${IS_VISIBLE})`);
  log(`Today's application count: ${state.count}/${DAILY_CAP}`);

  if (state.count >= DAILY_CAP) {
    log(`Daily cap of ${DAILY_CAP} applications reached. Skipping run.`);
    return;
  }

  const ctx = await launchBrowser();
  let page = ctx.pages()[0] || (await ctx.newPage());

  try {
    page = await verifyLogin(ctx, page);

    if (IS_LOGIN_MODE) {
      log('Login verification complete. Session saved in .wellfound-chrome-profile.');
      return;
    }

    const keywords = searchKeywords.split(',').map((k) => k.trim()).filter(Boolean);
    let appliedRun = 0;

    for (const keyword of keywords) {
      if (getTodayCount().count >= DAILY_CAP) break;

      const searchUrl = `https://wellfound.com/jobs?q=${encodeURIComponent(keyword)}`;
      log(`--- Wellfound Searching for: "${keyword}" -> ${searchUrl} ---`);

      try {
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);

        // Wellfound uses a two-panel layout: click card → detail panel appears on right
        // Collect all job links from the search page first, then visit each one
        await page.waitForTimeout(2000);
        const jobLinks = await page.evaluate(() => {
          const anchors = Array.from(document.querySelectorAll('a[href]'));
          const seen = new Set();
          return anchors
            .map(a => a.href)
            .filter(href => {
              if (seen.has(href) || !/\/jobs\/\d+/.test(href)) return false;
              seen.add(href);
              return true;
            })
            .slice(0, 10);
        });

        log(`Found ${jobLinks.length} job link(s) on Wellfound for "${keyword}".`);

        for (const jobUrl of jobLinks) {
          if (getTodayCount().count >= DAILY_CAP) break;

          try {
            await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(2500);

            // Extract title and company from job detail page
            const title = (await page.locator('h1, h2').first().textContent().catch(() => 'Intern')).trim();
            const company = (await page.locator(
              '[class*="company"] a, [class*="startup"] a, [data-test="CompanyName"], h3 a'
            ).first().textContent().catch(() => 'Company')).trim();

            const pageText = (await page.textContent('body').catch(() => '')).toLowerCase();
            if (pageText.includes('you applied') || pageText.includes('application submitted')) {
              log(`[SKIP] Already applied on Wellfound to "${title}" at ${company}`);
              continue;
            }

            // Skip unpaid internships (paid-only filter)
            if (isUnpaid(`${title} ${pageText}`)) {
              log(`[SKIP] Unpaid internship skipped on Wellfound: "${title}" at ${company}`);
              continue;
            }

            // Apply button lives on the job detail page itself
            const applyBtn = page.locator(
              'button:has-text("Apply"), button[data-test="ApplyButton"], button:has-text("Apply to position"), a:has-text("Apply")'
            ).first();

            if (await applyBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
              await applyBtn.click({ force: true });
              const success = await handleApplyForm(page, title, company, jobUrl);
              if (success) appliedRun++;
              await page.waitForTimeout(3000);
            } else {
              log(`[SKIP] No direct apply button for "${title}" at ${company} — ${jobUrl}`);
            }
          } catch (err) {
            log(`ERROR processing Wellfound job ${jobUrl}: ${err.message.split('\n')[0]}`);
          }
        }
      } catch (err) {
        log(`ERROR during Wellfound search for "${keyword}": ${err.message.split('\n')[0]}`);
      }
    }

    log(`Wellfound Auto-Apply session finished: ${appliedRun} application(s) processed in this run.`);
    await sendSummaryEmail({ platform: 'Wellfound', appliedCount: appliedRun });
  } finally {
    await ctx.close();
  }
}

runAutoApply().catch((err) => {
  log(`Fatal Error: ${err.message}`);
  process.exit(1);
});
