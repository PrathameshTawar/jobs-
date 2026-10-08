/**
 * Naukri Profile Refresh — toggles a trailing "." on the resume headline
 * so the profile counts as "updated" every run.
 *
 * Hourly:  Windows Task Scheduler runs:  node naukri-profile-refresh.js   (off-screen Chrome)
 * Debug:   node naukri-profile-refresh.js login                           (visible Chrome window)
 *
 * Login is automatic: if session is gone, uses direct Naukri credentials or Google sign-in.
 */
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const { CREDS, naukriProfileUrl, headless: envHeadless, browserChannel: envChannel } = require('./config');

const PROFILE_URL = naukriProfileUrl;
const LOGIN_URL = `https://www.naukri.com/nlogin/login?URL=${encodeURIComponent(PROFILE_URL)}`;

const PROFILE_DIR = path.join(__dirname, '.naukri-chrome-profile');
const LOG_FILE = path.join(__dirname, 'naukri-refresh.log');
const ERROR_SHOT = path.join(__dirname, 'naukri-refresh-error.png');
const LOGIN_MODE = process.argv[2] === 'login';

const log = (msg) => {
  const line = `[${new Date().toLocaleString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
};

const onProfile = (url) => url.pathname.startsWith('/mnjuser');

async function directNaukriLogin(ctx, page) {
  log('Session gone — signing in with direct Naukri credentials...');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const usernameInput = page.locator('#usernameField, input[placeholder*="Email"], input[placeholder*="Username"], input[type="text"]').first();
  await usernameInput.waitFor({ state: 'visible', timeout: 20000 });
  await usernameInput.fill(CREDS.naukriEmail);

  const passwordInput = page.locator('#passwordField, input[placeholder*="Password"], input[type="password"]').first();
  await passwordInput.waitFor({ state: 'visible', timeout: 20000 });
  await passwordInput.fill(CREDS.naukriPassword);

  const loginBtn = page.locator('button.loginbtn, button[type="submit"]:has-text("Login"), button:has-text("Login")').first();
  await loginBtn.click();

  await page.waitForTimeout(3000);

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const done = ctx.pages().find((p) => {
      try { return onProfile(new URL(p.url())); } catch { return false; }
    });
    if (done) { log('Direct Naukri login OK, session saved.'); return done; }
    if (/\/mnjuser/.test(page.url())) { log('Direct Naukri login OK, session saved.'); return page; }
    await page.waitForTimeout(2000);
  }
  throw new Error('Direct Naukri login did not complete — check your credentials or CAPTCHA.');
}

async function googleLogin(ctx, page) {
  log('Session gone — signing in with Google...');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const googleBtn = page.locator('.socialbtn.google, [class*="socialbtn"][class*="google"], button:has-text("Google")').first();
  await googleBtn.waitFor({ timeout: 20000 });
  await googleBtn.click();

  let g = null;
  for (let i = 0; i < 30 && !g; i++) {
    await page.waitForTimeout(1000);
    g = ctx.pages().find((p) => /accounts\.google\./.test(p.url())) || null;
  }
  if (!g) throw new Error('Google sign-in popup/page never appeared');
  await g.waitForLoadState('domcontentloaded');

  const emailToUse = CREDS.googleEmail || CREDS.email;
  const passToUse = CREDS.googlePassword || CREDS.password;

  const knownAccount = g.locator(`[data-email="${emailToUse}"]`).first();
  if (await knownAccount.isVisible().catch(() => false)) {
    await knownAccount.click();
  } else {
    const emailBox = g.locator('input#identifierId, input[type="email"], input[name="identifier"]').first();
    await emailBox.waitFor({ state: 'visible', timeout: 60000 });
    await emailBox.fill(emailToUse);
    await g.locator('#identifierNext, button:has-text("Next")').first().click();

    const passBox = g.locator('input[type="password"], input[name="Passwd"]').first();
    await passBox.waitFor({ state: 'visible', timeout: 60000 });
    await passBox.fill(passToUse);
    await g.locator('#passwordNext, button:has-text("Next")').first().click();
  }

  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (!g.isClosed()) {
      await g.locator('button:has-text("Continue")').first().click({ timeout: 500 }).catch(() => {});
    }
    const done = ctx.pages().find((p) => {
      try { return onProfile(new URL(p.url())); } catch { return false; }
    });
    if (done) { log('Google login OK, session saved.'); return done; }
    if (g.isClosed() || /naukri\.com/.test(g.url())) {
      await page.goto(PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      if (onProfile(new URL(page.url()))) { log('Google login OK, session saved.'); return page; }
    }
    await page.waitForTimeout(2000);
  }
  throw new Error(
    'Google login did not complete — likely a 2-step verification prompt. ' +
    'Run "node naukri-profile-refresh.js login" and approve it once manually.'
  );
}

async function manualLogin(ctx, page) {
  log('No valid Naukri session found.');
  log('Opening login page. Please complete login manually in the Chrome window if prompted...');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    for (const p of ctx.pages()) {
      try {
        if (onProfile(new URL(p.url()))) {
          log('Manual Naukri login successful, session saved.');
          return p;
        }
      } catch {}
    }
    await page.waitForTimeout(2000);
  }
  throw new Error('Manual login was not completed within 5 minutes.');
}

async function performLogin(ctx, page) {
  if (CREDS.naukriEmail && CREDS.naukriPassword) {
    try {
      return await directNaukriLogin(ctx, page);
    } catch (e) {
      log(`Direct login failed: ${e.message}. Falling back to manual login...`);
      return await manualLogin(ctx, page);
    }
  } else if ((CREDS.googleEmail || CREDS.email) && CREDS.googlePassword && CREDS.googlePassword !== 'your-google-password') {
    try {
      return await googleLogin(ctx, page);
    } catch (e) {
      log(`Google auto-login failed: ${e.message}. Falling back to manual login...`);
      return await manualLogin(ctx, page);
    }
  } else {
    return await manualLogin(ctx, page);
  }
}

async function launchBrowser() {
  const isHeadless = envHeadless && !LOGIN_MODE;
  const launchOptions = {
    headless: isHeadless,
    viewport: LOGIN_MODE ? null : { width: 1440, height: 900 },
    args: [
      '--disable-blink-features=AutomationControlled',
      ...(LOGIN_MODE ? ['--start-maximized'] : []),
      ...(!isHeadless && !LOGIN_MODE ? ['--window-position=-32000,-32000'] : []),
    ],
  };

  try {
    return await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: envChannel || 'chrome',
      ...launchOptions,
    });
  } catch (err) {
    const msg = String(err && err.message || err);
    // Another run (e.g. Task Scheduler + a manual run) already holds the Chrome profile.
    if (/existing browser session|profile is already in use|in use/i.test(msg)) {
      const e = new Error('Chrome profile is already in use by another run — skipping this run.');
      e.code = 'PROFILE_LOCKED';
      throw e;
    }
    log(`Warning: Failed to launch with browser channel "${envChannel}", falling back to bundled Chromium.`);
    try {
      return await chromium.launchPersistentContext(PROFILE_DIR, launchOptions);
    } catch (err2) {
      const msg2 = String(err2 && err2.message || err2);
      if (/existing browser session|profile is already in use|in use/i.test(msg2)) {
        const e = new Error('Chrome profile is already in use by another run — skipping this run.');
        e.code = 'PROFILE_LOCKED';
        throw e;
      }
      throw err2;
    }
  }
}

(async () => {
  let ctx;
  try {
    ctx = await launchBrowser();
  } catch (err) {
    if (err && err.code === 'PROFILE_LOCKED') {
      log(`SKIP: ${err.message}`);
      process.exit(0); // not a failure — another run is active
    }
    log(`ERROR: ${String(err && err.message || err).split('\n')[0]}`);
    process.exitCode = 1;
    return;
  }
  let page = ctx.pages()[0] || (await ctx.newPage());

  try {
    await page.goto(PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    if (!onProfile(new URL(page.url()))) {
      page = await performLogin(ctx, page);
    }

    if (!/\/mnjuser\/profile/.test(page.url())) {
      await page.goto(PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }

    const closeModals = async (p) => {
      await p.keyboard.press('Escape').catch(() => {});
      await p.waitForTimeout(300);

      // Close any open promotional modal / lightbox if present
      const closeBtn = p.locator('[class*="closeButton"], [class*="close-btn"], ._cross, .crossLayer, [class*="crossLayer"]').first();
      if (await closeBtn.isVisible().catch(() => false)) {
        await closeBtn.click({ force: true }).catch(() => {});
        await p.waitForTimeout(500);
      }
    };

    // One attempt: mount lazy sections, then click the pencil INSIDE the
    // Profile Summary / Resume headline heading. Returns a status string.
    const tryOpenEditor = async (p) => {
      // Naukri lazy-loads the widgets below the fold — sweep down, then come back up
      for (const y of [700, 1400, 2100, 2800, 1400, 0]) {
        await p.evaluate((sc) => window.scrollTo(0, sc), y).catch(() => {});
        await p.waitForTimeout(350);
        const r = await clickHeadingPencil(p);
        if (r.startsWith('clicked')) return r;
      }
      // Fallback: use the "Profile summary" Quick link to scroll/mount the section
      const viaLink = await p.evaluate(() => {
        const links = Array.from(document.querySelectorAll('div, a, span')).filter(
          (e) => e.offsetWidth > 0 && /^profile\s*summary$/i.test((e.innerText || '').trim())
        );
        if (!links.length) return 'no quick link';
        links[0].scrollIntoView({ block: 'center' });
        links[0].click();
        return 'quick-link clicked';
      });
      await p.waitForTimeout(1500);
      const r = await clickHeadingPencil(p);
      return r.startsWith('clicked') ? `${viaLink} → ${r}` : `${viaLink} → ${r}`;
    };

    // Finds the Profile Summary / Resume headline heading and clicks its own pencil.
    const clickHeadingPencil = async (p) => p.evaluate(() => {
      const wants = (t) => /^\s*(profile\s*summary|resume\s*headline)/i.test((t || '').trim());
      const headings = Array.from(document.querySelectorAll('h1, h2, h3, .section-heading, .heading-container'));
      const notes = [];
      for (const h of headings) {
        if (h.offsetWidth === 0 || !wants(h.innerText)) continue;
        let box = h;
        for (let i = 0; i < 4 && box; i++) {
          const txt = (box.innerText || '').trim();
          if (txt.length > 150) break; // too broad — would hit a neighbouring section's pencil
          const pen = box.querySelector('.new-pencil, [class*="pencil"]');
          if (pen && pen.offsetWidth > 0) {
            pen.scrollIntoView({ block: 'center' });
            pen.click();
            return 'clicked heading pencil: "' + txt.slice(0, 40) + '"';
          }
          box = box.parentElement;
        }
        notes.push('no pencil for: "' + (h.innerText || '').trim().slice(0, 40) + '"');
      }
      // Fallback: known section class names
      const sec = document.querySelector('[class*="profileSummary"], [class*="resumeHeadline"], [class*="ResumeHeadline"]');
      if (sec) {
        const pen = sec.querySelector('.new-pencil, [class*="pencil"]');
        if (pen) { pen.scrollIntoView({ block: 'center' }); pen.click(); return 'clicked section fallback pencil'; }
      }
      return notes.length ? notes.join(' | ') : 'heading not mounted yet';
    });

    // Opens the Profile Summary / Resume headline editor and returns its input element.
    // Retries: the section is lazily mounted, so the first sweep can miss it.
    const openEditor = async (p) => {
      await closeModals(p);

      const input = p.locator('textarea#summary, #resumeHeadlineTxt, #profileSummaryTxt, textarea:visible').first();

      for (let attempt = 1; attempt <= 5; attempt++) {
        // Editor may already be open (e.g. verification pass right after a save)
        if (await input.isVisible().catch(() => false)) return input;

        const status = await tryOpenEditor(p);
        log(`[editor] attempt ${attempt}: ${status}`);

        await input.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
        if (await input.isVisible().catch(() => false)) return input;

        await closeModals(p);
        await p.waitForTimeout(800);
      }
      throw new Error('Editor did not open after 5 attempts (no textarea found) — Naukri UI may have changed.');
    };

    const textarea = await openEditor(page);

    const getVal = async (el) => {
      return (await el.evaluate(e => e.value || e.innerText || e.textContent || '')).trimEnd();
    };

    const current = await getVal(textarea);
    const inputId = (await textarea.getAttribute('id').catch(() => '')) || '';
    // textarea#summary allows 1000 chars; the legacy headline field allows 250
    const LIMIT = inputId === 'summary' ? 1000 : 250;

    let updated;
    if (!current) {
      updated = 'Full Stack Developer with expertise in Web Development and AI.';
    } else if (current.endsWith('.')) {
      updated = current.slice(0, -1).trimEnd();
    } else if (current.length < LIMIT) {
      updated = current + '.';
    } else {
      // At the character limit — toggle a space instead of truncating content
      updated = current.trimEnd() + ' ';
    }

    const setVal = async (el, val) => {
      const isCE = await el.evaluate(e => e.isContentEditable || e.tagName !== 'TEXTAREA').catch(() => false);
      if (isCE) {
        await el.evaluate((e, v) => {
          e.innerText = v;
          e.dispatchEvent(new Event('input', { bubbles: true }));
          e.dispatchEvent(new Event('change', { bubbles: true }));
        }, val);
      } else {
        await el.fill(val);
      }
    };

    await setVal(textarea, updated);
    await page.waitForTimeout(500);

    // Click the Save button in the open modal (#submit-btn on the new Naukri UI)
    const clicked = await page.evaluate(() => {
      const vis = (b) => b && b.offsetWidth > 0 && b.offsetHeight > 0;
      const submit = document.querySelector('#submit-btn');
      if (vis(submit)) { submit.click(); return 'submit-btn'; }
      const btns = Array.from(document.querySelectorAll('button, div, span, a'))
        .filter(b => b.innerText && b.innerText.trim() === 'Save' && vis(b));
      if (btns.length > 0) {
        btns[0].click();
        return 'text-Save';
      }
      return '';
    });

    if (!clicked) {
      const saveBtn = page.locator('button:has-text("Save"):visible').first();
      await saveBtn.click({ force: true });
    }
    log(`[editor] Save clicked (${clicked || 'forced locator'})`);

    await page.waitForTimeout(4000);
    await closeModals(page);

    // Reload profile page to verify changes were saved on server
    await page.goto(PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);

    let saved = null;
    try {
      const verifyTextarea = await openEditor(page);
      saved = await getVal(verifyTextarea);
      await closeModals(page);
    } catch (e) {
      log(`Verify step failed: ${e.message.split('\n')[0]}`);
    }

    if (saved === updated) {
      log(`OK: profile update successful (verified on server) → "${updated.slice(0, 60)}${updated.length > 60 ? '…' : ''}"`);
    } else if (saved === null) {
      log('ERROR: could not re-open the editor to verify the save.');
      process.exitCode = 1;
    } else {
      log(`ERROR: save did not stick — server has "${String(saved).slice(0, 60)}" (expected "${updated.slice(0, 60)}").`);
      process.exitCode = 1;
    }
  } catch (err) {
    const pages = ctx.pages();
    for (let i = 0; i < pages.length; i++) {
      await pages[i].screenshot({ path: ERROR_SHOT.replace('.png', `-${i}.png`) }).catch(() => {});
    }
    log(`ERROR: ${err.message.split('\n')[0]} (screenshots saved to naukri-refresh-error-*.png)`);
    process.exitCode = 1;
  } finally {
    await ctx.close();
  }
})();
