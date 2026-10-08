/**
 * mailer.js — sends email notification after each job application.
 *
 * Uses Gmail with an App Password (not your main password).
 * Set NOTIFY_EMAIL and GMAIL_APP_PASSWORD in .env to enable.
 *
 * To generate a Gmail App Password:
 *   1. Go to https://myaccount.google.com/security
 *   2. Enable 2-Step Verification (required)
 *   3. Search "App passwords" → create one for "Mail"
 *   4. Paste the 16-char password into GMAIL_APP_PASSWORD in .env
 */

const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

function loadEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const E = loadEnv(path.join(__dirname, '.env'));
const g = (k, d = '') => (E[k] != null && E[k] !== '' ? E[k] : (process.env[k] || d));

const NOTIFY_EMAIL = g('NOTIFY_EMAIL') || g('EMAIL');
const GMAIL_APP_PASSWORD = g('GMAIL_APP_PASSWORD');
const GMAIL_USER = g('NOTIFY_EMAIL') || g('EMAIL');

let transporter = null;

function getTransporter() {
  if (!GMAIL_APP_PASSWORD) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: GMAIL_USER,
        pass: GMAIL_APP_PASSWORD.replace(/\s+/g, ''), // strip spaces from app password
      },
    });
  }
  return transporter;
}

/**
 * Send an application notification email.
 * @param {object} opts
 * @param {string} opts.platform   - e.g. 'Naukri', 'LinkedIn', 'Indeed', 'Wellfound'
 * @param {string} opts.jobTitle   - Job title applied for
 * @param {string} opts.company    - Company name
 * @param {string} [opts.jobUrl]   - URL of the job listing (optional)
 * @param {string} [opts.screenshotPath] - Path to screenshot file (optional)
 * @param {boolean} [opts.dryRun]  - Whether this was a dry run
 */
async function sendApplicationEmail({ platform, jobTitle, company, jobUrl = '', screenshotPath = '', dryRun = false }) {
  const t = getTransporter();
  if (!t) {
    // Silently skip if not configured
    return;
  }

  const subject = dryRun
    ? `[DRY-RUN] Application prepared — ${jobTitle} at ${company} (${platform})`
    : `Applied: ${jobTitle} at ${company} (${platform})`;

  const appliedAt = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: ${dryRun ? '#f0a500' : '#2ecc71'};">
        ${dryRun ? '🔍 Dry Run — Application Prepared' : '✅ Application Submitted'}
      </h2>
      <table style="width:100%; border-collapse: collapse;">
        <tr><td style="padding:8px; font-weight:bold; width:140px;">Platform</td><td style="padding:8px;">${platform}</td></tr>
        <tr style="background:#f9f9f9;"><td style="padding:8px; font-weight:bold;">Job Title</td><td style="padding:8px;">${jobTitle}</td></tr>
        <tr><td style="padding:8px; font-weight:bold;">Company</td><td style="padding:8px;">${company}</td></tr>
        <tr style="background:#f9f9f9;"><td style="padding:8px; font-weight:bold;">Applied At</td><td style="padding:8px;">${appliedAt}</td></tr>
        ${jobUrl ? `<tr><td style="padding:8px; font-weight:bold;">Job URL</td><td style="padding:8px;"><a href="${jobUrl}">${jobUrl}</a></td></tr>` : ''}
      </table>
      ${screenshotPath ? `<p style="margin-top:16px; color:#666;">Screenshot proof attached.</p>` : ''}
      <hr style="margin-top:24px; border:none; border-top:1px solid #eee;"/>
      <p style="color:#999; font-size:12px;">Sent by your Auto-Apply bot</p>
    </div>
  `;

  const mailOptions = {
    from: `"Auto-Apply Bot" <${GMAIL_USER}>`,
    to: NOTIFY_EMAIL,
    subject,
    html,
    attachments: screenshotPath && fs.existsSync(screenshotPath)
      ? [{ filename: path.basename(screenshotPath), path: screenshotPath }]
      : [],
  };

  try {
    await t.sendMail(mailOptions);
  } catch (err) {
    // Don't crash the apply script if email fails
    console.warn(`[mailer] Email send failed: ${err.message}`);
  }
}

/**
 * Send a session summary email after all applications in a run.
 * @param {object} opts
 * @param {string} opts.platform
 * @param {number} opts.appliedCount
 * @param {number} opts.skippedCount
 * @param {Array<{title:string, company:string}>} opts.applications
 */
async function sendSummaryEmail({ platform, appliedCount, skippedCount = 0, applications = [] }) {
  const t = getTransporter();
  if (!t) return;

  const subject = `Auto-Apply Summary: ${appliedCount} application(s) on ${platform}`;
  const appliedAt = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  const rows = applications.map(({ title, company, url }) =>
    `<tr>
      <td style="padding:6px; border-bottom:1px solid #eee;">${title}</td>
      <td style="padding:6px; border-bottom:1px solid #eee;">${company}</td>
      <td style="padding:6px; border-bottom:1px solid #eee;">${url ? `<a href="${url}">View Job</a>` : '-'}</td>
    </tr>`
  ).join('');

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #3498db;">📋 Auto-Apply Session Summary — ${platform}</h2>
      <table style="width:100%; border-collapse: collapse;">
        <tr><td style="padding:8px; font-weight:bold;">Platform</td><td style="padding:8px;">${platform}</td></tr>
        <tr style="background:#f9f9f9;"><td style="padding:8px; font-weight:bold;">Applications Submitted</td><td style="padding:8px; color:#2ecc71; font-weight:bold;">${appliedCount}</td></tr>
        <tr><td style="padding:8px; font-weight:bold;">Skipped</td><td style="padding:8px;">${skippedCount}</td></tr>
        <tr style="background:#f9f9f9;"><td style="padding:8px; font-weight:bold;">Completed At</td><td style="padding:8px;">${appliedAt}</td></tr>
      </table>
      ${applications.length > 0 ? `
        <h3 style="margin-top:24px;">Applications:</h3>
        <table style="width:100%; border-collapse: collapse; margin-top:8px;">
          <tr style="background:#3498db; color:white;">
            <th style="padding:8px; text-align:left;">Job Title</th>
            <th style="padding:8px; text-align:left;">Company</th>
            <th style="padding:8px; text-align:left;">Link</th>
          </tr>
          ${rows}
        </table>
      ` : ''}
      <hr style="margin-top:24px; border:none; border-top:1px solid #eee;"/>
      <p style="color:#999; font-size:12px;">Sent by your Auto-Apply bot</p>
    </div>
  `;

  try {
    await t.sendMail({
      from: `"Auto-Apply Bot" <${GMAIL_USER}>`,
      to: NOTIFY_EMAIL,
      subject,
      html,
    });
  } catch (err) {
    console.warn(`[mailer] Summary email send failed: ${err.message}`);
  }
}

module.exports = { sendApplicationEmail, sendSummaryEmail };
