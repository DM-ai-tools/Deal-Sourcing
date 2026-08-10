/**
 * Dashboard.
 *
 * Plain JavaScript on purpose. There is no bundler, no framework and no build
 * step, so there is nothing between the file on disk and the page in the
 * browser — one less thing that can fail on a deploy, which is worth more here
 * than any convenience a framework would buy.
 */
const $ = (id) => document.getElementById(id);
const money = (n) => (n == null ? '<span class="muted">—</span>' : '$' + n.toLocaleString('en-US'));
const escape = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

const LABEL = {
  new: 'New',
  email_sent: 'Email sent',
  nda_signed: 'NDA signed',
  cim_sent: 'CIM sent',
  in_progress: 'In progress',
  loi_sent: 'LOI sent',
  deal_flow: 'Deal flow',
  rejected: 'Rejected',
};

let META = { industries: [], states: [], defaultIndustries: [] };
let STATUSES = [];
let pollTimer = null;

async function api(path, options) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Request failed (${response.status})`);
  }
  return payload;
}

function toast(message) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function banner(kind, title, body) {
  return `<div class="banner ${kind}"><b>${escape(title)}</b>${body}</div>`;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

document.querySelectorAll('nav button').forEach((button) => {
  button.onclick = () => {
    document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b === button));
    document.querySelectorAll('.view').forEach((v) =>
      v.classList.toggle('on', v.id === `view-${button.dataset.view}`),
    );
    if (button.dataset.view === 'tracker') loadListings();
    if (button.dataset.view === 'runs') loadRuns();
    if (button.dataset.view === 'searches') loadSearches();
  };
});

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

async function loadListings() {
  const query = new URLSearchParams({
    status: $('statusFilter').value || 'all',
    q: $('q').value.trim(),
  });

  try {
    const { listings, counts, statuses } = await api(`/api/listings?${query}`);
    STATUSES = statuses;

    if ($('statusFilter').options.length <= 1) {
      for (const status of statuses) {
        const option = new Option(LABEL[status] ?? status, status);
        $('statusFilter').add(option);
      }
    }

    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    $('stats').innerHTML = [
      ['Listings found', total],
      ['Contacted', counts.email_sent ?? 0],
      ['In progress', (counts.in_progress ?? 0) + (counts.cim_sent ?? 0) + (counts.nda_signed ?? 0)],
      ['Deal flow', counts.deal_flow ?? 0],
    ]
      .map(([label, value]) => `<div class="stat"><b>${value}</b><span>${label}</span></div>`)
      .join('');

    if (!listings.length) {
      $('listings').innerHTML =
        '<tr><td colspan="8" class="empty">No listings yet. Save a search, then start a run.</td></tr>';
      return;
    }

    $('listings').innerHTML = listings
      .map((l) => {
        const failed = l.outreach?.some((o) => o.status === 'failed');
        // Sent means an outreach row actually reached 'sent'. A dry run prepares
        // messages without sending, and showing those as contacted would be the
        // most misleading thing this table could do.
        const sent = l.outreach?.some((o) => o.status === 'sent');
        const replied = Boolean(l.respondedAt);
        const outreachFlag = replied
          ? `<span class="flag replied" title="Replied ${escape(when(l.respondedAt))}"><span class="dot"></span>Responded</span>`
          : sent
            ? `<span class="flag sent" title="Sent ${escape(when(l.contactedAt))}"><span class="dot"></span>Sent</span>`
            : '<span class="flag none">Not contacted</span>';
        return `<tr>
          <td>
            <a href="${escape(l.url)}" target="_blank" rel="noreferrer">${escape(l.title)}</a>
            <div class="muted" style="font-size:12px">
              ${escape(l.location ?? '')}${l.brokerName ? ' · ' + escape(l.brokerName) : ''}
              ${l.brokerPhone ? ' · ' + escape(l.brokerPhone) : ''}
              ${failed ? ' · <span style="color:var(--bad)">send failed</span>' : ''}
            </div>
            ${l.responseNote ? `<div style="font-size:12px;color:#8ee79c;margin-top:4px">${escape(l.responseNote).slice(0, 140)}</div>` : ''}
          </td>
          <td class="muted" style="font-size:12px;white-space:nowrap">${escape(l.datePosted ?? '-')}</td>
          <td class="num">${money(l.askingPrice)}</td>
          <td class="num">${money(l.grossRevenue)}</td>
          <td class="num">${money(l.cashFlow)}</td>
          <td class="num">${money(l.ebitda)}</td>
          <td>
            ${outreachFlag}
            <button class="reply" data-id="${l.id}" title="Record their reply"
              style="margin-top:5px;padding:3px 8px;font-size:11px">Log reply</button>
          </td>
          <td>
            <select class="status" data-id="${l.id}">
              ${STATUSES.map(
                (s) => `<option value="${s}" ${s === l.status ? 'selected' : ''}>${LABEL[s] ?? s}</option>`,
              ).join('')}
            </select>
          </td>
        </tr>`;
      })
      .join('');

    document.querySelectorAll('select.status').forEach((select) => {
      select.onchange = async () => {
        try {
          await api(`/api/listings/${select.dataset.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: select.value }),
          });
          toast('Status updated');
          loadListings();
        } catch (err) {
          toast(err.message);
        }
      };
    });
    document.querySelectorAll('button.reply').forEach((button) => {
      button.onclick = async () => {
        const note = prompt('What did they say? This shows in the tracker and the Google Sheet.');
        if (note === null) return;
        try {
          await api(`/api/listings/${button.dataset.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ responded: true, responseNote: note }),
          });
          toast('Reply recorded');
          loadListings();
        } catch (err) {
          toast(err.message);
        }
      };
    });
  } catch (err) {
    $('listings').innerHTML = `<tr><td colspan="8" class="empty">${escape(err.message)}</td></tr>`;
  }
}

/** Short, readable timestamp. */
function when(value) {
  return value
    ? new Date(value).toLocaleString(undefined, {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
      })
    : '';
}

$('q').oninput = debounce(loadListings, 350);
$('statusFilter').onchange = loadListings;

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ---------------------------------------------------------------------------
// Searches
// ---------------------------------------------------------------------------

function renderChips(containerId, items, selected) {
  $(containerId).innerHTML = items
    .map(
      (item) => `<label class="chip ${selected.includes(item.value) ? 'on' : ''}">
        <input type="checkbox" value="${escape(item.value)}" ${selected.includes(item.value) ? 'checked' : ''}>
        ${escape(item.label)}
      </label>`,
    )
    .join('');

  $(containerId).querySelectorAll('input').forEach((input) => {
    input.onchange = () => input.closest('.chip').classList.toggle('on', input.checked);
  });
}

const chosen = (containerId) =>
  [...$(containerId).querySelectorAll('input:checked')].map((i) => i.value);

function filtersFromForm() {
  return {
    name: $('sName').value.trim() || 'Untitled search',
    states: chosen('states'),
    industries: chosen('industries'),
    cashFlowMin: Number($('sCfMin').value) || null,
    cashFlowMax: Number($('sCfMax').value) || null,
    excludeAuctions: $('sNoAuctions').checked,
  };
}

$('saveSearch').onclick = async () => {
  try {
    await api('/api/searches', { method: 'POST', body: JSON.stringify(filtersFromForm()) });
    toast('Search saved');
    loadSearches();
  } catch (err) {
    toast(err.message);
  }
};

$('previewSearch').onclick = async () => {
  try {
    const { name, ...filters } = filtersFromForm();
    const { urls, count } = await api('/api/searches/preview', {
      method: 'POST',
      body: JSON.stringify(filters),
    });
    $('searchPreview').innerHTML = banner(
      'good',
      `${count} search page${count === 1 ? '' : 's'} will be swept`,
      `<div class="log" style="margin-top:8px;max-height:180px">${urls
        .slice(0, 40)
        .map((u) => `<div>${escape(u)}</div>`)
        .join('')}</div>`,
    );
  } catch (err) {
    toast(err.message);
  }
};

async function loadSearches() {
  const { searches } = await api('/api/searches');
  if (!searches.length) {
    $('searchList').innerHTML = '<div class="card"><div class="empty">No saved searches yet.</div></div>';
    return;
  }

  $('searchList').innerHTML = searches
    .map(
      (s) => `<div class="card">
        <div class="row">
          <div style="flex:1">
            <h3 style="margin:0 0 4px">${escape(s.name)}</h3>
            <div class="muted" style="font-size:12.5px">
              ${(s.industries || []).length} industries ·
              ${(s.states || []).length ? (s.states || []).join(', ') : 'all locations'} ·
              SDE ${s.cashFlowMin ? '$' + s.cashFlowMin.toLocaleString() : 'any'}–${s.cashFlowMax ? '$' + s.cashFlowMax.toLocaleString() : 'any'} ·
              ${s._count.runs} run(s), ${s._count.listings} listing(s)
            </div>
          </div>
          <button class="primary" data-run="${s.id}">Start dry run</button>
          <button data-live="${s.id}">Start live run</button>
          <button class="danger" data-del="${s.id}">Delete</button>
        </div>
      </div>`,
    )
    .join('');

  $('searchList').querySelectorAll('[data-run]').forEach((b) => {
    b.onclick = () => startRun(b.dataset.run, true);
  });
  $('searchList').querySelectorAll('[data-live]').forEach((b) => {
    b.onclick = () => {
      if (!confirm('This will send real messages to brokers. Continue?')) return;
      startRun(b.dataset.live, false);
    };
  });
  $('searchList').querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Delete this search?')) return;
      await api(`/api/searches/${b.dataset.del}`, { method: 'DELETE' });
      loadSearches();
    };
  });
}

async function startRun(searchId, dryRun) {
  try {
    const { dryRun: actual } = await api('/api/runs', {
      method: 'POST',
      body: JSON.stringify({ searchId, dryRun }),
    });
    toast(actual ? 'Dry run started — nothing will be sent' : 'Live run started');
    document.querySelector('nav button[data-view="runs"]').click();
  } catch (err) {
    toast(err.message);
  }
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

async function loadRuns() {
  const { runs } = await api('/api/runs');
  if (!runs.length) {
    $('runList').innerHTML = '<div class="card"><div class="empty">No runs yet.</div></div>';
    return;
  }

  $('runList').innerHTML = runs
    .map(
      (r) => `<div class="card">
        <div class="row">
          <div style="flex:1">
            <div class="row" style="gap:8px">
              <strong>${escape(r.search?.name ?? 'Search')}</strong>
              <span class="pill ${r.dryRun ? 'dry' : 'live'}">${r.dryRun ? 'Dry run' : 'Live'}</span>
              <span class="badge">${escape(r.status)}</span>
              ${r.live ? '<span class="badge" style="color:var(--good)">running</span>' : ''}
            </div>
            <div class="muted" style="font-size:12.5px;margin-top:5px">
              ${r.pagesRead} pages · ${r.listingsFound} listings (${r.listingsNew} new) ·
              ${r.messagesSent} sent · ${r.messagesFailed} failed ·
              via ${escape(r.transport)} · ${new Date(r.startedAt).toLocaleString()}
            </div>
            ${r.error ? `<div style="color:var(--bad);font-size:12.5px;margin-top:6px">${escape(r.error)}</div>` : ''}
          </div>
          ${r.live ? `<button class="danger" data-stop="${r.id}">Stop</button>` : ''}
          <button data-open="${r.id}">Log</button>
        </div>
      </div>`,
    )
    .join('');

  $('runList').querySelectorAll('[data-stop]').forEach((b) => {
    b.onclick = async () => {
      await api(`/api/runs/${b.dataset.stop}/stop`, { method: 'POST' });
      toast('Stopping…');
      loadRuns();
    };
  });
  $('runList').querySelectorAll('[data-open]').forEach((b) => {
    b.onclick = () => openRun(b.dataset.open);
  });

  const live = runs.find((r) => r.live);
  clearTimeout(pollTimer);
  if (live) pollTimer = setTimeout(loadRuns, 3000);
}

async function openRun(id) {
  $('runDetail').style.display = 'block';
  const { run } = await api(`/api/runs/${id}`);
  $('runLog').innerHTML =
    run.events
      .map(
        (e) =>
          `<div class="${e.level}">${new Date(e.createdAt).toLocaleTimeString()} — ${escape(e.message)}</div>`,
      )
      .join('') || '<div class="muted">No events yet.</div>';
  if (run.live) setTimeout(() => openRun(id), 3000);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function loadSettings() {
  const { settings, sentToday } = await api('/api/settings');

  $('fullName').value = settings.fullName ?? '';
  $('email').value = settings.email ?? '';
  $('phone').value = settings.phone ?? '';
  $('messageTemplate').value = settings.messageTemplate ?? '';
  $('sendingEnabled').checked = settings.sendingEnabled;
  $('dailyCap').value = settings.dailyCap;
  $('minDelay').value = settings.minDelaySeconds;
  $('maxDelay').value = settings.maxDelaySeconds;
  $('transport').value = settings.transport;
  $('sheetsEnabled').checked = Boolean(settings.sheetsEnabled);
  $('sheetId').value = settings.sheetId ?? '';
  $('googleHint').textContent = settings.hasGoogle ? '- saved' : '- not set';
  $('bbsEmail').value = settings.bizbuysellEmail ?? '';
  $('proxyServer').value = settings.proxyServer ?? '';
  $('proxyUsername').value = settings.proxyUsername ?? '';
  $('pwHint').textContent = settings.hasLogin ? '— saved' : '— not set';

  $('armPill').className = `pill ${settings.sendingEnabled ? 'live' : 'dry'}`;
  $('armPill').textContent = settings.sendingEnabled ? `Armed · ${sentToday} sent today` : 'Dry run';

  const alerts = [];
  if (!settings.sendingEnabled) {
    alerts.push(
      banner(
        'warn',
        'Sending is off — every run is a dry run',
        'Listings are found, financials recorded and messages prepared, but nothing is sent. ' +
          'Arm sending in Settings when you are ready.',
      ),
    );
  }
  if (settings.transport === 'firecrawl') {
    alerts.push(
      banner(
        'bad',
        'Firecrawl cannot currently reach BizBuySell search pages',
        'BizBuySell is behind Akamai bot protection. Measured 6 Aug 2026: the homepage returns, ' +
          'search and listing pages are refused — through Firecrawl, through headless and headed Chrome, ' +
          'and through a plain request. Switch to the <b>local browser</b> transport on a machine the site ' +
          'already trusts, or configure <b>residential proxies</b>. Use “Test connection” below to check.',
      ),
    );
  }
  $('alerts').innerHTML = alerts.join('');
}

$('saveSettings').onclick = async () => {
  try {
    const saved = await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        fullName: $('fullName').value,
        email: $('email').value,
        phone: $('phone').value,
        messageTemplate: $('messageTemplate').value,
        sendingEnabled: $('sendingEnabled').checked,
        dailyCap: Number($('dailyCap').value),
        minDelaySeconds: Number($('minDelay').value),
        maxDelaySeconds: Number($('maxDelay').value),
        transport: $('transport').value,
        bizbuysellEmail: $('bbsEmail').value || null,
        bizbuysellPassword: $('bbsPassword').value || null,
        sheetsEnabled: $('sheetsEnabled').checked,
        sheetId: $('sheetId').value || null,
        googleCredentials: $('googleCredentials').value || null,
        proxyServer: $('proxyServer').value || null,
        proxyUsername: $('proxyUsername').value || null,
        proxyPassword: $('proxyPassword').value || null,
      }),
    });
    $('bbsPassword').value = '';
    $('googleCredentials').value = '';
    $('proxyPassword').value = '';
    // Arming the switch starts a live run. Say so — someone who has just caused
    // real messages to go to real brokers should not have to infer it from a
    // progress bar appearing somewhere else on the page.
    toast(
      saved.startedRunId
        ? 'Sending armed — a live run has started. Messages are going out now.'
        : // An arming attempt that started nothing must say why. Reporting
          // "Settings saved" while nothing happened is how someone waits a week
          // for messages that were never going to be sent.
          saved.armingNote || 'Settings saved',
    );
    loadSettings();
  } catch (err) {
    toast(err.message);
  }
};

const VERDICT_TONE = { works: 'good', empty: 'bad', blocked: 'bad', error: 'bad' };

function verdictRow(v) {
  const label = { works: 'WORKS', empty: 'EMPTY', blocked: 'BLOCKED', error: 'ERROR' }[v.verdict] ?? v.verdict;
  return `<div class="${v.verdict === 'works' ? '' : 'error'}">${label.padEnd(8)} ${escape(v.mode).padEnd(10)} ` +
    `${String(v.listings).padStart(3)} listings  ${v.seconds}s  ${escape(v.detail).slice(0, 70)}</div>`;
}

$('testTransport').onclick = async () => {
  $('transportResult').innerHTML =
    '<p class="muted" style="margin-top:12px">Testing… a browser mode takes up to 90 seconds.</p>';
  try {
    const { result } = await api('/api/settings/test-transport', {
      method: 'POST',
      body: JSON.stringify({ mode: $('transport').value }),
    });
    $('transportResult').innerHTML = banner(
      result.ok ? 'good' : 'bad',
      result.ok ? 'Reachable' : 'Not returning data',
      escape(result.detail) + `<div class="log" style="margin-top:8px">${verdictRow(result.verdict)}</div>`,
    );
  } catch (err) {
    $('transportResult').innerHTML = banner('bad', 'Test failed', escape(err.message));
  }
};

// Reading and writing have failed independently here: a green transport test
// coexisted with forty-four failed sends for days. This exercises the real send
// path — navigate, fill, read back, locate the submit control — and stops.
$('testSend').onclick = async () => {
  $('transportResult').innerHTML =
    '<p class="muted" style="margin-top:12px">Filling a real contact form… up to 90 seconds. ' +
    'Nothing will be sent.</p>';
  try {
    const result = await api('/api/settings/test-send', { method: 'POST', body: '{}' });
    const outcome = result.outcome;
    $('transportResult').innerHTML = banner(
      outcome.ok ? 'good' : 'bad',
      outcome.ok ? 'The send path works — arming will send' : 'The send path is broken',
      escape(outcome.confirmation || outcome.error || '') +
        `<div class="muted" style="margin-top:8px">via <b>${escape(result.mode)}</b> on ` +
        `${escape(result.listing)}</div>` +
        (outcome.screenshot
          ? `<img src="${outcome.screenshot}" style="margin-top:10px;max-width:100%;border-radius:8px">`
          : ''),
    );
  } catch (err) {
    $('transportResult').innerHTML = banner('bad', 'Send test failed', escape(err.message));
  }
};

$('testAllModes').onclick = async () => {
  $('transportResult').innerHTML =
    '<p class="muted" style="margin-top:12px">Testing every mode in turn — this takes a few minutes. ' +
    'Each one launches its own browser.</p>';
  try {
    const { verdicts, working, recommendation } = await api('/api/settings/test-all-modes', { method: 'POST' });
    $('transportResult').innerHTML = banner(
      working.length ? 'good' : 'bad',
      working.length ? `Working: ${working.join(', ')}` : 'No mode returned data from here',
      escape(recommendation) +
        `<div class="log" style="margin-top:8px">${verdicts.map(verdictRow).join('')}</div>` +
        '<p style="margin:8px 0 0;font-size:12px;opacity:.8">EMPTY means the page was served with no ' +
        'listings in it — a silent block, not an error.</p>',
    );
  } catch (err) {
    $('transportResult').innerHTML = banner('bad', 'Test failed', escape(err.message));
  }
};

$('testSheet').onclick = async () => {
  $('sheetResult').innerHTML = '<p class="muted" style="margin-top:12px">Checking...</p>';
  try {
    const { result } = await api('/api/sheets/test', { method: 'POST' });
    $('sheetResult').innerHTML = banner(
      result.ok ? 'good' : 'bad',
      result.ok ? 'Sheet reachable' : 'Could not reach the sheet',
      escape(result.error ?? ''),
    );
  } catch (err) {
    $('sheetResult').innerHTML = banner('bad', 'Test failed', escape(err.message));
  }
};

$('syncSheet').onclick = async () => {
  toast('Syncing to Google Sheet...');
  try {
    const { result } = await api('/api/sheets/sync', { method: 'POST' });
    toast(result.ok ? `Sheet updated - ${result.rows} rows` : `Sync failed: ${result.error}`);
  } catch (err) {
    toast(err.message);
  }
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * Is the database actually there?
 *
 * Without this the whole dashboard fails silently: every data call rejects,
 * the tracker sits on "Loading…" forever, and nothing on screen says why. An
 * app that looks broken and explains nothing is worse than one that says
 * plainly what is missing.
 */
async function checkDatabase() {
  try {
    const health = await fetch('/api/health').then((r) => r.json());
    if (health.database === 'ok') return true;
    $('alerts').innerHTML = banner(
      'bad',
      'No database connected — this is why nothing loads',
      'The dashboard is running, but there is nowhere to store searches, listings or settings. ' +
        'Set <code>DATABASE_URL</code> to a Postgres connection string and run ' +
        '<code>npx prisma migrate deploy</code>. On Railway, add a Postgres service and set it to ' +
        '<code>${{Postgres.DATABASE_URL}}</code>.' +
        (health.problems?.length
          ? `<div class="log" style="margin-top:8px">${health.problems.map((p) => `<div class="error">${escape(p)}</div>`).join('')}</div>`
          : ''),
    );
    $('listings').innerHTML =
      '<tr><td colspan="6" class="empty">No database connected — see the message above.</td></tr>';
    return false;
  } catch (err) {
    $('alerts').innerHTML = banner('bad', 'Cannot reach the server', escape(err.message));
    return false;
  }
}

(async function boot() {
  try {
    const meta = await api('/api/meta');
    META = meta;
    renderChips(
      'industries',
      meta.industries.map((i) => ({ value: i.slug, label: i.label })),
      meta.defaultIndustries,
    );
    renderChips(
      'states',
      meta.states.map((s) => ({ value: s.code, label: s.code })),
      [],
    );
  } catch (err) {
    $('alerts').innerHTML = banner('bad', 'Cannot reach the server', escape(err.message));
    return;
  }

  if (!(await checkDatabase())) return;

  // Each of these can fail independently; one failing must not blank the rest.
  await loadSettings().catch((err) => toast(err.message));
  await loadListings().catch((err) => toast(err.message));
})();
