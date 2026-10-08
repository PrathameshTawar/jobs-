/**
 * Loads all personal data + credentials from .env so nothing sensitive lives in code.
 * Tiny hand-rolled parser — no dependency needed for a flat KEY=value file.
 */
const fs = require('fs');
const path = require('path');

function loadEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
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

if (!g('NAME') && !g('EMAIL') && !g('NAUKRI_EMAIL') && !g('GOOGLE_EMAIL')) {
  console.warn('[config] .env missing or empty — copy .env.example to .env and fill it in.');
}

const CV = {
  name: g('NAME'),
  email: g('EMAIL') || g('NAUKRI_EMAIL') || g('GOOGLE_EMAIL'),
  phone: g('PHONE'),
  location: g('LOCATION'),
  currentRole: g('CURRENT_ROLE'),
  company: g('COMPANY') || ((g('CURRENT_ROLE') || '').split(' at ')[1] || '').split(' (')[0],
  education: g('EDUCATION'),
  yearsOfExperience: g('YEARS_EXPERIENCE'),
  skills: g('SKILLS'),
  highlights: g('HIGHLIGHTS') ? g('HIGHLIGHTS').split('||').map((s) => s.trim()).filter(Boolean) : [],
  // application answers
  noticePeriod: g('NOTICE_PERIOD'),
  currentCTC: g('CURRENT_CTC'),                 // bare number for chatbots, e.g. "10"
  expectedCTC: g('EXPECTED_CTC'),               // e.g. "18-25"
  currentSalary: g('CURRENT_CTC') ? g('CURRENT_CTC') + ' LPA' : '',     // formatted for free-text fields
  expectedSalary: g('EXPECTED_CTC') ? g('EXPECTED_CTC') + ' LPA' : '',
  dob: g('DOB'),
  gender: g('GENDER'),
  workAuth: g('WORK_AUTH', 'Authorized to work in my country of residence.'),
  // links
  github: g('GITHUB_URL'),
  linkedin: g('LINKEDIN_URL'),
  portfolio: g('PORTFOLIO_URL'),
  links: `GitHub: ${g('GITHUB_URL')} | LinkedIn: ${g('LINKEDIN_URL')} | Portfolio: ${g('PORTFOLIO_URL')}`,
  // derived sentences
  remoteOk: 'Yes, I am fully set up for remote work and also open to hybrid/onsite.',
  relocate: `Yes, I am open to relocation. I am currently based in ${g('LOCATION')}.`,
  startDate: `I can start within ${g('NOTICE_PERIOD')}.`,
};

const CREDS = {
  naukriEmail: g('NAUKRI_EMAIL') || g('EMAIL'),
  naukriPassword: g('NAUKRI_PASSWORD'),
  googleEmail: g('GOOGLE_EMAIL') || g('EMAIL'),
  googlePassword: g('GOOGLE_PASSWORD'),
  linkedinEmail: g('LINKEDIN_EMAIL') || g('EMAIL'),
  linkedinPassword: g('LINKEDIN_PASSWORD'),
  indeedEmail: g('INDEED_EMAIL') || g('EMAIL'),
  indeedPassword: g('INDEED_PASSWORD'),
  wellfoundEmail: g('WELLFOUND_EMAIL') || g('EMAIL'),
  wellfoundPassword: g('WELLFOUND_PASSWORD'),
  email: g('NAUKRI_EMAIL') || g('GOOGLE_EMAIL') || g('EMAIL'),
  password: g('NAUKRI_PASSWORD') || g('GOOGLE_PASSWORD'),
};

const geminiKey = g('GEMINI_KEY');
const naukriProfileUrl = g('NAUKRI_PROFILE_URL', 'https://www.naukri.com/mnjuser/profile');
const searchKeywords = g('SEARCH_KEYWORDS', 'full stack intern, software engineer intern, web developer intern');
const searchLocation = g('SEARCH_LOCATION', '');
const headless = g('HEADLESS', 'false').toLowerCase() === 'true';
const browserChannel = g('BROWSER_CHANNEL', 'chrome');

module.exports = { CV, CREDS, geminiKey, naukriProfileUrl, searchKeywords, searchLocation, headless, browserChannel };


