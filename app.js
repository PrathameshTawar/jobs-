// App State
let state = {
  activeTab: 'dashboard',
  isRunning: false,
  currentTask: null,
  applications: [],
  filteredApps: [],
  appPage: 1,
  appPageSize: 10,
  targetCompanies: [],
  envData: {},
  schedulerInfo: null
};

// Initialize App
document.addEventListener('DOMContentLoaded', () => {
  setupNavigation();
  initSSE();
  fetchStatus();
  fetchApplications();
  fetchTargetCompanies();
  fetchEnvConfig();
  fetchLogFileContent();
});

// Navigation Setup
function setupNavigation() {
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const tab = item.dataset.tab;
      switchTab(tab);
    });
  });
}

function switchTab(tabId) {
  state.activeTab = tabId;

  // Update Nav Buttons
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });

  // Update Tab Pages
  document.querySelectorAll('.tab-page').forEach(page => {
    page.classList.toggle('active', page.id === `tab-${tabId}`);
  });

  // Update Topbar Titles
  const titles = {
    dashboard: { title: 'Executive Dashboard', subtitle: 'Real-time automation analytics and control panel' },
    runner: { title: 'Automation Control Terminal', subtitle: 'Live execution logs and Playwright script controller' },
    applications: { title: 'Applications Tracker', subtitle: 'Comprehensive history of auto-applied positions' },
    targets: { title: 'Target Companies Pipeline', subtitle: 'Curated list of high-priority target companies' },
    config: { title: 'Credentials & Environment', subtitle: 'Configure credentials, personal details and preferences' },
    scheduler: { title: 'Task Scheduler & Logs', subtitle: 'Windows hourly background automation controller' }
  };

  const t = titles[tabId] || titles.dashboard;
  document.getElementById('pageTitle').textContent = t.title;
  document.getElementById('pageSubtitle').textContent = t.subtitle;
}

// Toast Notifications
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// Fetch System Status
async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();

    document.getElementById('sidebarAccount').textContent = `Account: ${data.googleEmail}`;
    document.getElementById('kpiLastRefreshTime').textContent = data.lastRefresh ? `Log: ${data.lastRefresh.slice(0, 40)}...` : 'Never';

    if (data.scheduler) {
      state.schedulerInfo = data.scheduler;
      const schedState = data.scheduler.registered ? (data.scheduler.status || 'Active') : 'Not Scheduled';
      document.getElementById('kpiSchedulerState').textContent = schedState;
      document.getElementById('kpiSchedulerNext').textContent = data.scheduler.nextRun ? `Next: ${data.scheduler.nextRun}` : 'Task not registered';

      document.getElementById('schedStatusVal').textContent = schedState;
      document.getElementById('schedLastRunVal').textContent = data.scheduler.lastRun || 'N/A';
      document.getElementById('schedNextRunVal').textContent = data.scheduler.nextRun || 'N/A';
    }
  } catch (err) {
    console.error('Failed to fetch status:', err);
  }
}

// Real-Time SSE Log Listener
function initSSE() {
  const eventSource = new EventSource('/api/stream-logs');

  eventSource.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.type === 'status') {
        updateExecutionStatus(msg.isRunning, msg.task);
      } else if (msg.type === 'history') {
        const codeElem = document.getElementById('terminalCode');
        codeElem.innerHTML = '';
        msg.logs.forEach(log => appendTerminalLog(log));
      } else if (msg.type === 'log') {
        appendTerminalLog(msg);
      }
    } catch (e) {
      console.error('SSE Error parsing event:', e);
    }
  };

  eventSource.onerror = (err) => {
    console.warn('SSE connection lost, reconnecting...', err);
  };
}

function updateExecutionStatus(isRunning, task) {
  state.isRunning = isRunning;
  state.currentTask = task;

  const runningBadge = document.getElementById('runningBadge');
  const stopBtn = document.getElementById('stopTaskBtn');
  const runBtn = document.getElementById('runCustomTaskBtn');

  if (isRunning) {
    runningBadge.classList.remove('hidden');
    stopBtn.classList.remove('hidden');
    runBtn.disabled = true;
    runBtn.style.opacity = '0.5';
  } else {
    runningBadge.classList.add('hidden');
    stopBtn.classList.add('hidden');
    runBtn.disabled = false;
    runBtn.style.opacity = '1';
  }
}

function appendTerminalLog(logData) {
  const codeElem = document.getElementById('terminalCode');
  const line = document.createElement('div');
  line.className = `log-${logData.level || 'stdout'}`;
  line.textContent = logData.text;
  codeElem.appendChild(line);

  const autoScroll = document.getElementById('terminalAutoScroll').checked;
  if (autoScroll) {
    const body = document.getElementById('terminalBody');
    body.scrollTop = body.scrollHeight;
  }
}

function clearTerminal() {
  document.getElementById('terminalCode').innerHTML = '// Console cleared.\n';
}

// Quick Launch Trigger
async function quickLaunch(script, args = [], taskName = 'Automation Run') {
  switchTab('runner');
  try {
    const res = await fetch('/api/run-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script, args, taskName })
    });
    const data = await res.json();
    if (res.ok) {
      showToast(`Started task: ${taskName}`, 'success');
    } else {
      showToast(`Failed: ${data.error}`, 'error');
    }
  } catch (err) {
    showToast(`Server error: ${err.message}`, 'error');
  }
}

// Custom Task Execute
function executeCustomTask() {
  const script = document.getElementById('runnerScript').value;
  const args = [];

  if (document.getElementById('flagVisible').checked) args.push('--visible');
  if (document.getElementById('flagLive').checked) args.push('--live');
  if (document.getElementById('flagDryRun').checked) args.push('--dry-run');
  if (document.getElementById('flagLogin').checked) args.push('login');

  const scriptNames = {
    'naukri-profile-refresh.js': 'Naukri Profile Refresh',
    'naukri-auto-apply.js': 'Naukri Auto Apply',
    'linkedin-auto-apply.js': 'LinkedIn Auto Apply',
    'indeed-auto-apply.js': 'Indeed Auto Apply',
    'wellfound-auto-apply.js': 'Wellfound Auto Apply',
    'target-companies-apply.js': 'Target Companies Apply'
  };

  quickLaunch(script, args, scriptNames[script] || script);
}

async function stopRunningTask() {
  try {
    const res = await fetch('/api/stop-task', { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      showToast('Stopping task execution...', 'info');
    } else {
      showToast(`Error: ${data.error}`, 'error');
    }
  } catch (err) {
    showToast(`Failed to stop task: ${err.message}`, 'error');
  }
}

// Applications Fetch & Filter
async function fetchApplications() {
  try {
    const res = await fetch('/api/applications');
    const data = await res.json();

    state.applications = data.applications || [];
    document.getElementById('kpiTotalApps').textContent = state.applications.length;
    document.getElementById('kpiDetailedCount').textContent = `${data.detailedCount || 0} detailed JSON records`;

    renderPlatformDistribution();
    renderRecentApps();
    filterApplications();
  } catch (err) {
    console.error('Failed to fetch applications:', err);
  }
}

function renderPlatformDistribution() {
  const counts = { Naukri: 0, LinkedIn: 0, Indeed: 0, Wellfound: 0, Other: 0 };
  state.applications.forEach(app => {
    const site = (app.Site || '').trim();
    if (counts[site] !== undefined) counts[site]++;
    else counts.Other++;
  });

  const total = state.applications.length || 1;
  const container = document.getElementById('platformBars');
  container.innerHTML = '';

  const colors = {
    Naukri: '#10b981',
    LinkedIn: '#6366f1',
    Indeed: '#06b6d4',
    Wellfound: '#f59e0b',
    Other: '#94a3b8'
  };

  Object.entries(counts).forEach(([platform, count]) => {
    const pct = Math.round((count / total) * 100);
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.innerHTML = `
      <div class="bar-label-group">
        <span><strong>${platform}</strong> (${count})</span>
        <span class="text-muted">${pct}%</span>
      </div>
      <div class="bar-track">
        <div class="bar-fill" style="width: ${pct}%; background: ${colors[platform]};"></div>
      </div>
    `;
    container.appendChild(row);
  });
}

function renderRecentApps() {
  const recentList = document.getElementById('recentAppsList');
  const recent = state.applications.slice(0, 5);

  if (recent.length === 0) {
    recentList.innerHTML = '<div class="text-center p-4 text-muted">No applications recorded yet.</div>';
    return;
  }

  recentList.innerHTML = recent.map(app => {
    const dateStr = app.Date ? new Date(app.Date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Recent';
    const site = app.Site || 'Job';
    const siteBadgeClass = `badge-${site.toLowerCase()}`;
    return `
      <div class="p-3 mb-2 glass" style="border-radius: 8px; display: flex; align-items: center; justify-content: space-between;">
        <div>
          <div style="font-weight: 600; font-size: 0.92rem;">${escapeHtml(app.Role || 'Application')}</div>
          <div style="font-size: 0.78rem;" class="text-muted">${escapeHtml(app.Company || '')} • ${dateStr}</div>
        </div>
        <span class="platform-badge ${siteBadgeClass}">${escapeHtml(site)}</span>
      </div>
    `;
  }).join('');
}

function filterApplications() {
  const query = document.getElementById('appSearchInput').value.toLowerCase();
  const siteFilter = document.getElementById('appSiteFilter').value;

  state.filteredApps = state.applications.filter(app => {
    const matchesSite = siteFilter === 'ALL' || (app.Site || '').toLowerCase() === siteFilter.toLowerCase();
    const matchesQuery = !query || 
      (app.Role || '').toLowerCase().includes(query) ||
      (app.Company || '').toLowerCase().includes(query) ||
      (app.Skills || '').toLowerCase().includes(query);
    return matchesSite && matchesQuery;
  });

  state.appPage = 1;
  renderApplicationsTable();
}

function renderApplicationsTable() {
  const tbody = document.getElementById('applicationsTableBody');
  const total = state.filteredApps.length;

  if (total === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center p-4 text-muted">No matching applications found.</td></tr>';
    document.getElementById('tableInfoText').textContent = 'Showing 0 of 0 entries';
    return;
  }

  const start = (state.appPage - 1) * state.appPageSize;
  const end = Math.min(start + state.appPageSize, total);
  const pageApps = state.filteredApps.slice(start, end);

  tbody.innerHTML = pageApps.map(app => {
    const dateStr = app.Date ? new Date(app.Date).toLocaleString() : 'N/A';
    const site = app.Site || 'Other';
    const siteBadge = `badge-${site.toLowerCase()}`;
    const link = app.JobLink ? `<a href="${escapeHtml(app.JobLink)}" target="_blank" class="btn btn-sm btn-outline">View Job ↗</a>` : 'N/A';

    return `
      <tr>
        <td style="font-size: 0.82rem;" class="text-muted">${dateStr}</td>
        <td><span class="platform-badge ${siteBadge}">${escapeHtml(site)}</span></td>
        <td><strong>${escapeHtml(app.Role || 'N/A')}</strong></td>
        <td>${escapeHtml(app.Company || 'N/A')}</td>
        <td class="text-muted">${escapeHtml(app.Salary || 'N/A')}</td>
        <td>${link}</td>
      </tr>
    `;
  }).join('');

  document.getElementById('tableInfoText').textContent = `Showing ${start + 1} to ${end} of ${total} entries`;
  document.getElementById('currentPageText').textContent = state.appPage;
  document.getElementById('prevPageBtn').disabled = state.appPage === 1;
  document.getElementById('nextPageBtn').disabled = end >= total;
}

function changeAppPage(delta) {
  state.appPage += delta;
  renderApplicationsTable();
}

// Target Companies
async function fetchTargetCompanies() {
  try {
    const res = await fetch('/api/target-companies');
    const data = await res.json();

    state.targetCompanies = data.companies || [];
    document.getElementById('kpiTargetCompanies').textContent = state.targetCompanies.length;
    renderTargetCompanies();
  } catch (err) {
    console.error('Failed to fetch target companies:', err);
  }
}

function renderTargetCompanies() {
  const container = document.getElementById('targetCompaniesTags');
  const filter = (document.getElementById('targetFilterInput').value || '').toLowerCase();

  const filtered = state.targetCompanies.filter(c => c.toLowerCase().includes(filter));

  container.innerHTML = filtered.map((company, idx) => `
    <div class="target-tag">
      <span>${escapeHtml(company)}</span>
      <button class="tag-remove" onclick="removeTargetCompany('${escapeHtml(company)}')">×</button>
    </div>
  `).join('');
}

function addTargetCompany() {
  const input = document.getElementById('newTargetInput');
  const name = input.value.trim();
  if (!name) return;

  if (!state.targetCompanies.includes(name)) {
    state.targetCompanies.unshift(name);
    renderTargetCompanies();
    input.value = '';
    showToast(`Added ${name} to target pipeline`, 'info');
  }
}

function removeTargetCompany(name) {
  state.targetCompanies = state.targetCompanies.filter(c => c !== name);
  renderTargetCompanies();
}

async function saveTargetCompanies() {
  try {
    const res = await fetch('/api/target-companies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companies: state.targetCompanies })
    });
    if (res.ok) {
      showToast('Saved target companies list successfully!', 'success');
      document.getElementById('kpiTargetCompanies').textContent = state.targetCompanies.length;
    } else {
      showToast('Failed to save target companies.', 'error');
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

// Env Config Read & Write
async function fetchEnvConfig() {
  try {
    const res = await fetch('/api/env');
    const data = await res.json();

    state.envData = data;
    const form = document.getElementById('envForm');
    Object.keys(data).forEach(key => {
      const input = form.querySelector(`[name="${key}"]`);
      if (input) input.value = data[key];
    });
  } catch (err) {
    console.error('Failed to fetch env config:', err);
  }
}

async function saveEnvConfig() {
  const form = document.getElementById('envForm');
  const formData = new FormData(form);
  const updatedEnv = { ...state.envData };

  for (const [key, value] of formData.entries()) {
    updatedEnv[key] = value;
  }

  try {
    const res = await fetch('/api/env', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updatedEnv)
    });
    if (res.ok) {
      showToast('Updated .env settings successfully!', 'success');
      fetchStatus();
    } else {
      showToast('Failed to update .env', 'error');
    }
  } catch (err) {
    showToast(`Error saving .env: ${err.message}`, 'error');
  }
}

function togglePasswordVisibility(inputId) {
  const input = document.getElementById(inputId);
  if (input.type === 'password') {
    input.type = 'text';
  } else {
    input.type = 'password';
  }
}

// Scheduler Controller
async function triggerSchedulerAction(action) {
  try {
    const res = await fetch('/api/scheduler', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    });
    const data = await res.json();
    if (res.ok) {
      showToast(`Scheduler Action Completed: ${data.message || 'Success'}`, 'success');
      fetchStatus();
    } else {
      showToast(`Error: ${data.error}`, 'error');
    }
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
  }
}

// Log File Inspector
async function fetchLogFileContent() {
  const file = document.getElementById('logFileSelect').value;
  try {
    const res = await fetch(`/api/logs?file=${file}`);
    const data = await res.json();
    document.getElementById('logFileViewer').textContent = data.content;
  } catch (err) {
    document.getElementById('logFileViewer').textContent = 'Failed to load log file.';
  }
}

// Utilities
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
