// Deliberately no framework — a private link and a couple of screens
// don't need a build step (portal-v0-spec.md §8, "keep it simple").
const app = document.getElementById('app');

function tokenFromHash() {
  const match = /token=([^&]+)/.exec(location.hash);
  return match
    ? decodeURIComponent(match[1])
    : localStorage.getItem('portal_client_token');
}

let token = tokenFromHash();
if (token) localStorage.setItem('portal_client_token', token);

// --- Signing in with Microsoft or Google (issue #342, sso-spec.md §2b) ---------------------------
// A contact either opens the one-time link its admin passed on (`#contact=<token>`), which ties its
// first identity, or signs in from here with no link. The provider comes back through the portal's
// callback host to `#sso=<code>`, which this page redeems with the secret it kept for the trip. All
// three values live in the fragment, which a browser never sends to a server, and are read once.

const SSO_FAILED =
  'That sign-in did not work. Try again, or use the private link you were sent.';

function takeFragment(name) {
  const match = new RegExp(`^#${name}=([A-Za-z0-9_.-]{1,200})$`).exec(location.hash);
  if (!match) return null;
  history.replaceState(null, '', location.pathname + location.search);
  return match[1];
}

/** Session storage for the trip to the provider: read once (and removed), or written. */
function kept(key, value) {
  try {
    if (value === undefined) {
      const held = sessionStorage.getItem(key);
      sessionStorage.removeItem(key);
      return held;
    }
    sessionStorage.setItem(key, value);
    return value;
  } catch {
    return null;
  }
}

function newBinding() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function leaveForProvider(provider, link) {
  const binding = newBinding();
  if (kept('portal_sso_binding', binding) === null) {
    return 'This browser will not keep what a sign-in needs. Use the private link you were sent.';
  }
  if (link) kept('portal_contact_link', link);
  const res = await fetch('/api/client/sso/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(link ? { provider, binding, link } : { provider, binding }),
  });
  if (!res.ok) {
    return res.status === 404
      ? 'This sign-in link is not valid any more. Ask for a new one.'
      : SSO_FAILED;
  }
  location.assign((await res.json()).url);
  return '';
}

const PROVIDER_LABEL = { google: 'Google', microsoft: 'Microsoft' };

async function renderSignIn(message, link) {
  let providers = [];
  try {
    const res = await fetch('/api/client/sso/providers');
    if (res.ok) providers = (await res.json()).providers;
  } catch {
    // no buttons: the private link is still the way in
  }
  app.innerHTML = `
    ${message ? `<p class="error">${escapeHtml(message)}</p>` : ''}
    <p>${
      link
        ? 'Sign in with your Microsoft or Google account to finish setting up your access.'
        : providers.length > 0
          ? 'Sign in with your Microsoft or Google account, or use the private link you were sent.'
          : 'No access link found. Use the private link you were sent.'
    }</p>
    <div class="sso">${providers
      .map(
        (p) =>
          `<button data-provider="${escapeHtml(p)}">Continue with ${escapeHtml(PROVIDER_LABEL[p] || p)}</button>`,
      )
      .join(' ')}</div>
  `;
  app.querySelectorAll('[data-provider]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const problem = await leaveForProvider(btn.dataset.provider, link);
      if (problem) renderSignIn(problem, link);
    });
  });
}

/** Back from a provider: redeems the code, linking first when a sign-in link started the trip. */
async function redeemReturn(code) {
  const binding = kept('portal_sso_binding');
  const link = kept('portal_contact_link');
  if (code === 'refused' || !binding) return renderSignIn(SSO_FAILED, link);
  const res = await fetch('/api/client/sso/redeem', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(link ? { code, binding, link } : { code, binding }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return renderSignIn(res.status === 409 ? body.error || SSO_FAILED : SSO_FAILED, link);
  }
  token = (await res.json()).token;
  localStorage.setItem('portal_client_token', token);
  return renderHome();
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const error = new Error(body.error || `request failed (${res.status})`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

function statusBadge(status) {
  return `<span class="status ${escapeHtml(status)}">${escapeHtml(String(status).replace('_', ' '))}</span>`;
}

// The portal's ISO 4217 code, filled into the page by the server (issue #327); every amount
// is formatted from it, never with a symbol written here.
const CURRENCY = document.querySelector('meta[name="portal-currency"]')?.content;

function money(n, digits = 2) {
  if (n == null) return '—';
  return CURRENCY
    ? new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: CURRENCY,
        // A per-word rate may need more places than the currency's own; an amount never does.
        ...(digits > 2 ? { maximumFractionDigits: digits } : {}),
      }).format(n)
    : n.toFixed(2);
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

// A plain link can't carry the bearer token, so a download is a fetch
// with the token in the header, handed to the browser as a blob.
async function downloadFile(path, filename) {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `download failed (${res.status})`);
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function wireDownloads(root) {
  root.querySelectorAll('[data-download]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await downloadFile(btn.dataset.download, btn.dataset.filename);
      } catch (err) {
        alert(err.message);
      } finally {
        btn.disabled = false;
      }
    });
  });
}

function fileRows(files, downloadPath) {
  if (files.length === 0) return '<tr><td colspan="3" class="muted">none</td></tr>';
  return files
    .map(
      (f) => `<tr>
        <td>${escapeHtml(f.filename)}</td>
        <td>${f.byteSize.toLocaleString()} bytes</td>
        <td>${
          downloadPath
            ? `<button class="secondary" data-download="${escapeHtml(downloadPath(f))}" data-filename="${escapeHtml(f.filename)}">Download</button>`
            : ''
        }</td>
      </tr>`,
    )
    .join('');
}

async function renderOrderDetail(id) {
  let detail;
  try {
    detail = await api(`/api/client/orders/${id}`);
  } catch (err) {
    app.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
    return;
  }
  const { order, sourceFiles, deliveredFiles, events } = detail;

  app.innerHTML = `
    <button class="secondary" id="back">&larr; All requests</button>
    <h2>Request #${order.id} ${statusBadge(order.status)}</h2>
    <p>${escapeHtml(order.srcLang)} &rarr; ${escapeHtml(order.tgtLangs.join(', '))}</p>
    ${order.previousOrderId == null ? '' : `<p class="muted">A new version of request #${order.previousOrderId}: only new or changed text is quoted.</p>`}
    <p class="muted">Words: ${order.wordCount ?? 'estimate pending'} · Price: ${money(order.price)}</p>
    ${order.notes ? `<p class="muted">${escapeHtml(order.notes)}</p>` : ''}

    <h2>Your translation</h2>
    ${
      order.status === 'delivered'
        ? ''
        : `<p class="muted">Files will appear here once the translation is delivered.</p>`
    }
    <table>
      <tr><th>File</th><th>Size</th><th></th></tr>
      ${fileRows(deliveredFiles, (f) => `/api/client/orders/${order.id}/delivered-files/${f.id}`)}
    </table>

    <h2>Files you sent</h2>
    <table>
      <tr><th>File</th><th>Size</th><th></th></tr>
      ${fileRows(sourceFiles, null)}
    </table>

    <h2>History</h2>
    <table>
      <tr><th>When</th><th>Status</th><th>Note</th></tr>
      ${events
        .map(
          (e) =>
            `<tr><td>${new Date(e.createdAt).toLocaleString()}</td><td>${statusBadge(e.toStatus)}</td><td>${escapeHtml(e.note ?? '')}</td></tr>`,
        )
        .join('')}
    </table>
  `;

  app.querySelector('#back').addEventListener('click', renderHome);
  wireDownloads(app);
}

// The client's own memory and glossary (backlog #162): theirs to take at any
// time, as TMX and CSV. Shown only when something is linked to them.
function resourcesSection(resources) {
  if (resources.length === 0) return '';
  const labels = { tm: 'Translation memory (TMX)', glossary: 'Glossary (CSV)' };
  return `
    <h2>Your memory and glossary</h2>
    <p class="muted">These belong to you. Download them whenever you like.</p>
    ${resources
      .map(
        (r) => `<div class="card">
          <strong>${escapeHtml(r.name)}</strong>
          <div class="muted">${escapeHtml(labels[r.kind] ?? r.kind)}</div>
          <button class="secondary" data-download="/api/client/resources/${escapeHtml(r.kind)}/export"
            data-filename="${escapeHtml(r.filename)}">Download</button>
        </div>`,
      )
      .join('')}
  `;
}

async function renderHome() {
  if (!token) return renderSignIn('');

  let me, orders, rates, resources;
  try {
    [me, orders, rates, resources] = await Promise.all([
      api('/api/client/me'),
      api('/api/client/orders'),
      api('/api/client/rates'),
      api('/api/client/resources'),
    ]);
  } catch (err) {
    // A link the admin turned off, or a session that ended: sign in again.
    if (err.status === 401) {
      localStorage.removeItem('portal_client_token');
      token = null;
      return renderSignIn('');
    }
    app.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
    return;
  }

  app.innerHTML = `
    <p>Welcome, ${escapeHtml(me.name)}.</p>

    <h2>New translation request</h2>
    <form id="new-order">
      <label>Source language</label>
      <select name="srcLang" required></select>

      <label>Target language(s) — hold Ctrl/Cmd to select more than one</label>
      <select name="tgtLangs" multiple required style="height: 5rem"></select>

      <div id="update-of-field" hidden>
        <label>Is this a new version of a request we already delivered? (optional)</label>
        <select name="updateOf">
          <option value="">No, a new request</option>
        </select>
        <p class="muted">We quote only the text that is new or changed, and confirm the figure before you approve.</p>
      </div>

      <label>Files</label>
      <input type="file" name="files" multiple required
        accept=".docx,.pptx,.xlsx,.pdf,.txt" />

      <label>Notes (optional)</label>
      <textarea name="notes" rows="3"></textarea>

      <button type="submit">Submit request</button>
      <p class="muted" style="margin-top:0.5rem">
        You'll see an estimated price once we confirm the word count.
      </p>
      <p class="error" id="new-order-error"></p>
    </form>

    <h2>Your requests</h2>
    <div id="orders"></div>
    ${resourcesSection(resources)}
  `;
  wireDownloads(app);

  const langs = [...new Set(rates.flatMap((r) => [r.srcLang, r.tgtLang]))].sort();
  const srcSelect = app.querySelector('select[name="srcLang"]');
  const tgtSelect = app.querySelector('select[name="tgtLangs"]');
  for (const lang of langs) {
    srcSelect.add(new Option(lang, lang));
    tgtSelect.add(new Option(lang, lang));
  }

  // A delivered request can be updated (spec §4a). Choosing one fixes the
  // languages to its own: the server only accepts the same source language.
  const delivered = orders.filter((o) => o.status === 'delivered');
  const updateSelect = app.querySelector('select[name="updateOf"]');
  if (delivered.length > 0) {
    app.querySelector('#update-of-field').hidden = false;
    for (const o of delivered) {
      updateSelect.add(
        new Option(`#${o.id} ${o.srcLang} → ${o.tgtLangs.join(', ')}`, o.id),
      );
    }
    updateSelect.addEventListener('change', () => {
      const picked = delivered.find((o) => String(o.id) === updateSelect.value);
      if (!picked) return;
      srcSelect.value = picked.srcLang;
      for (const opt of tgtSelect.options)
        opt.selected = picked.tgtLangs.includes(opt.value);
    });
  }

  const ordersDiv = app.querySelector('#orders');
  if (orders.length === 0) {
    ordersDiv.innerHTML = `<p class="muted">No requests yet.</p>`;
  } else {
    ordersDiv.innerHTML = orders
      .map(
        (o) => `
      <div class="card">
        <strong>#${o.id}</strong> ${escapeHtml(o.srcLang)} → ${escapeHtml(o.tgtLangs.join(', '))}
        ${statusBadge(o.status)}${o.previousOrderId == null ? '' : ` <span class="muted">update of #${o.previousOrderId}</span>`}
        <div class="muted">Words: ${o.wordCount ?? 'estimate pending'} · Price: ${money(o.price)}</div>
        ${
          o.status === 'submitted'
            ? `<button data-approve="${o.id}" data-price="${o.price}" ${o.price == null ? 'disabled title="Waiting on a word-count estimate before you can approve."' : ''}>${o.price == null ? 'Approve' : `Approve ${escapeHtml(money(o.price))}`}</button>`
            : ''
        }
        <button class="secondary" data-detail="${o.id}">${
          o.status === 'delivered' ? 'Download translation' : 'Details'
        }</button>
      </div>`,
      )
      .join('');

    ordersDiv.querySelectorAll('[data-detail]').forEach((btn) => {
      btn.addEventListener('click', () => renderOrderDetail(btn.dataset.detail));
    });

    ordersDiv.querySelectorAll('[data-approve]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          // The price shown is part of the approval: if the order was
          // re-priced since this page loaded, the server refuses (409).
          await api(`/api/client/orders/${btn.dataset.approve}/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ price: Number(btn.dataset.price) }),
          });
          renderHome();
        } catch (err) {
          alert(err.message);
          // Show the order as it is now, current price included.
          renderHome();
        }
      });
    });
  }

  app.querySelector('#new-order').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const errorEl = form.querySelector('#new-order-error');
    errorEl.textContent = '';

    const data = new FormData();
    data.append('srcLang', form.srcLang.value);
    for (const opt of form.tgtLangs.selectedOptions) data.append('tgtLangs', opt.value);
    data.append('notes', form.notes.value);
    if (form.updateOf.value) data.append('updateOf', form.updateOf.value);
    for (const file of form.files.files) data.append('files', file, file.name);

    try {
      const res = await fetch('/api/client/orders', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: data,
      });
      if (!res.ok) throw new Error((await res.json()).error || 'submission failed');
      renderHome();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });
}

const returning = takeFragment('sso');
const contactLink = returning === null ? takeFragment('contact') : null;
if (returning !== null) redeemReturn(returning);
else if (contactLink !== null) renderSignIn('', contactLink);
else renderHome();
