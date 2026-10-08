/**
 * form-filler.js
 * Smart form filler that:
 * 1. Auto-answers known questions from resume/config
 * 2. Uses Gemini AI for open-ended questions
 * 3. Pauses and asks YOU in the terminal for anything it can't answer
 */

const readline = require('readline');
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
const GEMINI_KEY = g('GEMINI_KEY');

// Cache answers given during this session so same question isn't asked twice
const answerCache = new Map();

// Ask user in terminal and wait for their response (30 second timeout)
async function askUser(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    // Auto-timeout after 30 seconds so browser doesn't freeze forever
    const timeout = setTimeout(() => {
      rl.close();
      console.log('\n   ⏱ No answer in 30s — skipping this field.');
      resolve('');
    }, 30000);

    process.stdout.write(`\n❓ UNKNOWN QUESTION (30s to answer, Enter to skip):\n   "${question}"\n> `);

    rl.once('line', ans => {
      clearTimeout(timeout);
      rl.close();
      resolve(ans.trim());
    });
  });
}

// Ask Gemini for an answer
async function askGemini(question, jobTitle, company, cv) {
  if (!GEMINI_KEY) return null;
  try {
    const prompt = `You are filling a job application form for "${jobTitle}" at "${company}".

Candidate profile:
- Name: ${cv.name}
- Skills: ${cv.skills}
- Experience: ${cv.yearsOfExperience || '1 year'}
- Education: ${cv.education}
- Location: ${cv.location}
- Notice period: ${cv.noticePeriod}
- Current role: ${cv.currentRole || 'Student/Fresher'}
- Highlights: ${(cv.highlights || []).join('. ')}

Form question: "${question}"

Reply with ONLY the answer, no explanation. Keep it under 100 words, professional and positive.`;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
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

/**
 * Get the right answer for a form field label.
 * Priority: hardcoded → Gemini → ask user
 */
async function getAnswer(label, fieldType, jobTitle, company, cv) {
  const l = (label || '').toLowerCase().trim();
  if (!l) return null;

  // --- Hardcoded answers from resume ---
  if (/phone|mobile|contact.?number/.test(l)) return cv.phone;
  if (/notice.?period|availability|joining/.test(l)) return cv.noticePeriod || '10 days';
  if (/current.?ctc|current.?salary|current.?stipend/.test(l)) return '15000';
  if (/expected.?ctc|expected.?salary|desired.?salary|expected.?stipend/.test(l)) {
    // Check if job context suggests remote or onsite
    const jobContext = `${jobTitle} ${company}`.toLowerCase();
    if (/remote/.test(jobContext)) return '20000-25000';
    if (/onsite|on.?site|office|hybrid/.test(jobContext)) return '30000-35000';
    return '20000-25000'; // default to remote range
  }
  if (/year[s]?.?(of)?.?exp|experience/.test(l)) return '1';
  if (/city|location|where.?are.?you/.test(l)) return cv.location || 'Pune, India';
  if (/github/.test(l)) return cv.github || '';
  if (/linkedin/.test(l)) return cv.linkedin || '';
  if (/portfolio|website|personal.?site/.test(l)) return cv.portfolio || '';
  if (/your.?name|full.?name/.test(l)) return cv.name || '';
  if (/email/.test(l)) return cv.email || '';
  if (/dob|date.?of.?birth|birth.?date/.test(l)) return cv.dob || '';
  if (/gender/.test(l)) return cv.gender || 'Male';
  if (/skills/.test(l)) return cv.skills || '';
  if (/education|qualification/.test(l)) return cv.education || '';
  if (/college|university|institute/.test(l)) return cv.education || '';
  if (/degree/.test(l)) return 'B.Tech';
  if (/graduation.?year|passing.?year/.test(l)) return '2027';
  if (/gpa|cgpa|percentage/.test(l)) return '8.5';
  if (/10th|ssc/.test(l)) return '85';
  if (/12th|hsc/.test(l)) return '80';
  if (/language[s]?/.test(l)) return 'English, Hindi, Marathi';
  if (/relocat/.test(l)) return 'Yes';
  if (/remote/.test(l)) return 'Yes';
  if (/authorized|eligible.?to.?work/.test(l)) return 'Yes';
  if (/disability|differently.?abled/.test(l)) return 'No';
  if (/veteran/.test(l)) return 'No';

  // --- Additional hardcoded & pattern answers ---
  if (/sponsorship|visa/i.test(l)) return 'No';
  if (/authorized|eligible.?to.?work|legally/i.test(l)) return 'Yes';
  if (/background.?check|drug.?screen/i.test(l)) return 'Yes';
  if (/headline|summary|title/i.test(l)) return cv.currentRole || 'Full Stack Engineer';
  if (/years|how.?many.?year|experience/i.test(l)) return '1';

  // --- Cover letter / open-ended or unknown questions — try Gemini first ---
  if (fieldType === 'textarea' || fieldType === 'input' || /cover.?letter|why.?you|why.?this|motivation|about.?yourself|introduce|strength|weakness|achiev|project|intern|question/.test(l)) {
    const cacheKey = `${l}::${jobTitle}::${company}`;
    if (answerCache.has(cacheKey)) return answerCache.get(cacheKey);

    if (GEMINI_KEY) {
      console.log(`\n🤖 Asking Gemini: "${label}"`);
      const geminiAnswer = await askGemini(label, jobTitle, company, cv);
      if (geminiAnswer) {
        console.log(`   ✅ Gemini answered: "${geminiAnswer.slice(0, 80)}..."`);
        answerCache.set(cacheKey, geminiAnswer);
        return geminiAnswer;
      }
    }
  }

  // --- Unknown question — ask the user (with 30s timeout) ---
  if (fieldType === 'textarea') {
    const cacheKey = `USER::${l}`;
    if (answerCache.has(cacheKey)) return answerCache.get(cacheKey);

    console.log(`\n⚠️  Unknown question — type answer in terminal (30s) or press Enter to skip:`);
    const userAnswer = await askUser(label);
    if (userAnswer) {
      answerCache.set(cacheKey, userAnswer);
      return userAnswer;
    }
  }

  // For numeric inputs that need a number
  if (/number|count|amount|qty|how.?many|rating|score|experience|years/i.test(l)) {
    return '1';
  }

  return null;
}

/**
 * Fill all visible inputs in a form/modal container.
 * @param {import('playwright-core').Locator} container - the modal/form locator
 * @param {string} jobTitle
 * @param {string} company
 * @param {object} cv - CV object from config
 */
async function fillForm(container, jobTitle, company, cv) {
  const inputs = await container.locator(
    'input[type="text"], input[type="number"], input[type="tel"], input[type="email"], input[type="url"], textarea, select'
  ).all();

  for (const input of inputs) {
    if (!(await input.isVisible().catch(() => false))) continue;

    // Skip already-filled fields
    const currentVal = await input.inputValue().catch(() => '');
    if (currentVal && currentVal.trim().length > 0) continue;

    const tag = await input.evaluate(el => el.tagName).catch(() => 'INPUT');
    const inputType = await input.evaluate(el => el.type).catch(() => 'text');
    const fieldType = tag === 'TEXTAREA' ? 'textarea' : tag === 'SELECT' ? 'select' : 'input';

    // Get label from multiple sources
    const label = await input.evaluate(el => {
      if (el.id) {
        const lbl = document.querySelector(`label[for="${el.id}"]`);
        if (lbl) return lbl.innerText.trim();
      }
      const anc = el.closest('label');
      if (anc) return anc.innerText.trim();

      // Check fieldset legend or parent container text
      const fieldset = el.closest('fieldset');
      const legend = fieldset ? fieldset.querySelector('legend') : null;
      if (legend) return legend.innerText.trim();

      const parent = el.parentElement;
      if (parent) {
        const prev = parent.previousElementSibling;
        if (prev && (prev.tagName === 'LABEL' || prev.tagName === 'SPAN')) return prev.innerText.trim();
        return parent.innerText.trim().split('\n')[0].trim();
      }
      return el.placeholder || el.getAttribute('aria-label') || '';
    }).catch(() => '');

    if (fieldType === 'select') {
      const options = await input.evaluate(el =>
        Array.from(el.options).map((o, i) => ({ i, text: o.text.trim(), val: o.value }))
      ).catch(() => []);
      
      const labelLower = label.toLowerCase();
      let matchedIndex = -1;

      if (/experience|years/i.test(labelLower)) {
        matchedIndex = options.findIndex(o => /1|2|1-2|0-1|one|two/i.test(o.text) && o.i > 0);
      } else if (/education|degree|qualification/i.test(labelLower)) {
        matchedIndex = options.findIndex(o => /bachelor|b\.tech|undergraduate|degree/i.test(o.text) && o.i > 0);
      } else if (/notice|availability|joining/i.test(labelLower)) {
        matchedIndex = options.findIndex(o => /immediate|0|10|15|1 month/i.test(o.text) && o.i > 0);
      }

      if (matchedIndex > 0) {
        await input.selectOption({ index: matchedIndex }).catch(() => {});
      } else {
        const nonEmpty = options.find(o => o.val && o.val !== '' && o.i > 0);
        if (nonEmpty) await input.selectOption({ index: nonEmpty.i }).catch(() => {});
      }
      continue;
    }

    let answer = await getAnswer(label, fieldType, jobTitle, company, cv);
    if (!answer && inputType === 'number') {
      answer = '1';
    }
    if (answer) {
      await input.fill(String(answer)).catch(() => {});
    }
  }

  // --- Handle Radio Buttons (including grouped radio fieldsets) ---
  // 1. Group radios by container/name
  const radioGroups = await container.evaluate(modalEl => {
    const groups = [];
    const fieldsets = Array.from(modalEl.querySelectorAll('fieldset, div[role="radiogroup"], .fb-form-element, div[data-test-form-builder-repeater]'));
    
    // Process fieldset/group elements
    fieldsets.forEach(fs => {
      const radios = Array.from(fs.querySelectorAll('input[type="radio"]'));
      if (radios.length > 0) {
        const legend = fs.querySelector('legend, span.fb-dash-form-element__label, label') ? (fs.querySelector('legend, span.fb-dash-form-element__label, label').innerText || '') : '';
        groups.push({
          legend,
          radios: radios.map(r => ({
            id: r.id,
            checked: r.checked,
            label: r.closest('label') ? r.closest('label').innerText : (r.parentElement ? r.parentElement.innerText : '')
          }))
        });
      }
    });

    // Also catch any ungrouped radios
    const allRadios = Array.from(modalEl.querySelectorAll('input[type="radio"]'));
    const handledIds = new Set(groups.flatMap(g => g.radios.map(r => r.id)));
    const remaining = allRadios.filter(r => r.id && !handledIds.has(r.id));
    if (remaining.length > 0) {
      groups.push({
        legend: '',
        radios: remaining.map(r => ({
          id: r.id,
          checked: r.checked,
          label: r.closest('label') ? r.closest('label').innerText : (r.parentElement ? r.parentElement.innerText : '')
        }))
      });
    }

    return groups;
  }).catch(() => []);

  for (const group of radioGroups) {
    // If any radio in this group is already checked, skip
    if (group.radios.some(r => r.checked)) continue;

    const legendLower = group.legend.toLowerCase();
    let targetRadioId = null;

    // High priority checks based on question text
    if (/sponsorship|visa|convict|disability|veteran/i.test(legendLower)) {
      const noOpt = group.radios.find(r => /\bno\b/i.test(r.label));
      if (noOpt) targetRadioId = noOpt.id;
    } else if (/relocat|authorized|commute|onsite|remote|background|experience|comfortable|agree/i.test(legendLower)) {
      const yesOpt = group.radios.find(r => /\byes\b|authorized|immediate|agree/i.test(r.label));
      if (yesOpt) targetRadioId = yesOpt.id;
    }

    // Secondary priority: pick "Yes" if present
    if (!targetRadioId) {
      const yesOpt = group.radios.find(r => /\byes\b/i.test(r.label));
      if (yesOpt) targetRadioId = yesOpt.id;
    }

    // Fallback: pick the first radio button in group so step isn't blocked
    if (!targetRadioId && group.radios.length > 0) {
      targetRadioId = group.radios[0].id;
    }

    if (targetRadioId) {
      const radioLoc = container.locator(`input[id="${targetRadioId.replace(/"/g, '\\"')}"]`).first();
      await radioLoc.check({ force: true }).catch(() => radioLoc.click({ force: true })).catch(() => {});
    }
  }

  // --- Handle Checkboxes ---
  const checkboxes = await container.locator('input[type="checkbox"]').all();
  for (const cb of checkboxes) {
    if (!(await cb.isVisible().catch(() => false))) continue;
    if (await cb.isChecked().catch(() => false)) continue;

    const parentText = await cb.evaluate(el => {
      const lbl = el.closest('label') || el.parentElement;
      return lbl ? lbl.innerText.toLowerCase() : '';
    }).catch(() => '');

    if (/agree|authorize|consent|terms|confirm|accept|certify|acknowledge/i.test(parentText) || checkboxes.length === 1) {
      await cb.check({ force: true }).catch(() => {});
    }
  }
}

module.exports = { fillForm, getAnswer, askUser };

