const app = document.getElementById('app');

let token = sessionStorage.getItem('portal_admin_token');

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    sessionStorage.removeItem('portal_admin_token');
    token = null;
    renderLogin('Session expired — please log in again.');
    throw new Error('unauthorized');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `request failed (${res.status})`);
  }
  return res.json();
}

function renderLogin(message = '') {
  app.innerHTML = `
    <form id="login-form" class="card" style="max-width:20rem">
      <label>Email<input type="email" name="email" required /></label>
      <label>Password<input type="password" name="password" required /></label>
      <button type="submit">Log in</button>
      <p class="error" id="login-error">${escapeHtml(message)}</p>
    </form>
  `;
  app.querySelector('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = app.querySelector('#login-error');
    errorEl.textContent = '';
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: e.target.email.value,
          password: e.target.password.value,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'login failed');
      const { token: newToken } = await res.json();
      token = newToken;
      sessionStorage.setItem('portal_admin_token', token);
      renderOrderList();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });
}

function statusBadge(status) {
  return `<span class="status ${escapeHtml(status)}">${escapeHtml(String(status).replace('_', ' '))}</span>`;
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

function fileRows(files, downloadPath, withCounts = false, withChanged = false) {
  if (files.length === 0) {
    return `<tr><td colspan="${4 + (withCounts ? 1 : 0) + (withChanged ? 1 : 0)}" class="muted">none</td></tr>`;
  }
  return files
    .map(
      (f) => `<tr>
        <td>${escapeHtml(f.filename)}</td>
        <td>${escapeHtml(f.contentType)}</td>
        <td>${f.byteSize.toLocaleString()}</td>
        ${withCounts ? `<td>${f.wordCount == null ? '—' : f.wordCount.toLocaleString()}</td>` : ''}
        ${withChanged ? `<td>${changedCell(f)}</td>` : ''}
        <td><button class="secondary" data-download="${escapeHtml(downloadPath(f))}" data-filename="${escapeHtml(f.filename)}">Download</button></td>
      </tr>`,
    )
    .join('');
}

// An update order's per-file figure (portal-v0-spec.md §4a): the words in new
// or changed sentences, and whether there was an earlier file to compare with.
function changedCell(f) {
  if (f.changedWordCount == null) return '—';
  const n = f.changedWordCount.toLocaleString();
  return f.comparedToFileId == null ? `${n} <span class="muted">(new file)</span>` : n;
}

function money(n) {
  return n == null ? '—' : `$${n.toFixed(2)}`;
}

const NEXT_STATUSES = {
  submitted: ['approved', 'cancelled'],
  approved: ['in_progress', 'cancelled'],
  in_progress: ['delivered', 'cancelled'],
  delivered: [],
  cancelled: [],
};

// A rate with a per-file minimum prices each file on its own (portal-v0-spec.md
// §4b), so the admin confirms a count for every file instead of one total. The
// pre-fill is the same advice as the single total: the uploads' counts, or the
// changed words of an update order; a file with none is left blank.
function perFileForm(order, sourceFiles, suggested) {
  const rows = sourceFiles
    .map((f) => {
      const value = f.confirmedWordCount ?? suggested[f.id] ?? '';
      return `<tr>
        <td>${escapeHtml(f.filename)}</td>
        <td><input type="number" min="0" step="1" data-file-id="${f.id}" value="${value}" style="width:8rem" /></td>
      </tr>`;
    })
    .join('');
  const hint =
    order.wordCount != null
      ? ''
      : 'Pre-filled from the uploads’ counts where there are any. An estimate: check each, then confirm to price.';
  return `<form id="wc-form">
    <p class="muted">A rate on this order counts each file as at least a set number of words, so the price needs the words in each file. The order’s word count is their sum.</p>
    <table>
      <tr><th>File</th><th>Words</th></tr>
      ${rows}
    </table>
    <button type="submit">Set &amp; price</button>
  </form>
  <p class="muted">${hint}</p>`;
}

async function renderOrderDetail(id) {
  const {
    order,
    sourceFiles,
    suggestedWordCount,
    needsFileWordCounts,
    suggestedFileWordCounts,
    deliveredFiles,
    events,
  } = await api(`/api/admin/orders/${id}`);

  app.innerHTML = `
    <button class="secondary" id="back">&larr; All orders</button>
    <h2>Order #${order.id} ${statusBadge(order.status)}</h2>
    <p>${escapeHtml(order.srcLang)} &rarr; ${escapeHtml(order.tgtLangs.join(', '))}</p>
    ${order.previousOrderId == null ? '' : `<p>Update of order <a href="#" id="previous-order">#${order.previousOrderId}</a>: the figure below counts only new or changed sentences.</p>`}
    <p class="muted">${escapeHtml(order.notes || '')}</p>

    <div class="card">
      <label>Word count</label>
      ${
        needsFileWordCounts
          ? perFileForm(order, sourceFiles, suggestedFileWordCounts)
          : `<form id="wc-form" style="display:flex; gap:0.5rem; align-items:end">
        <input type="number" name="wordCount" min="0" value="${order.wordCount ?? suggestedWordCount ?? ''}" style="width:8rem" />
        <button type="submit" style="margin-top:0">Set &amp; price</button>
      </form>
      <p class="muted">${
        order.wordCount == null && suggestedWordCount != null
          ? order.previousOrderId == null
            ? 'Pre-filled from the uploads’ counts. An estimate: check it, then confirm to price.'
            : 'Pre-filled from the words in new or changed sentences. An estimate: a reflowed paragraph reads as changed, so check it against the files, then confirm to price.'
          : order.wordCount == null
            ? 'No automatic count for these files. Count them and enter it.'
            : ''
      }</p>`
      }
      <p>Price: <strong>${money(order.price)}</strong></p>
      <p class="error" id="wc-error"></p>
    </div>

    <div class="card">
      <label>Status</label>
      <div id="status-buttons"></div>
    </div>

    <h2>Source files</h2>
    <table>
      <tr><th>Filename</th><th>Type</th><th>Size</th><th>Words (est.)</th>${order.previousOrderId == null ? '' : '<th>Changed (est.)</th>'}<th></th></tr>
      ${fileRows(sourceFiles, (f) => `/api/admin/orders/${order.id}/source-files/${f.id}`, true, order.previousOrderId != null)}
    </table>

    <h2>Deliver final files</h2>
    <form id="deliver-form">
      <input type="file" name="files" multiple />
      <label><input type="checkbox" name="markDelivered" style="width:auto" /> Mark order delivered (notifies client)</label>
      <button type="submit">Upload</button>
      <p class="error" id="deliver-error"></p>
    </form>
    <table>
      <tr><th>Filename</th><th>Type</th><th>Size</th><th></th></tr>
      ${fileRows(deliveredFiles, (f) => `/api/admin/orders/${order.id}/delivered-files/${f.id}`)}
    </table>

    <h2>History</h2>
    <table>
      <tr><th>When</th><th>From</th><th>To</th><th>Note</th></tr>
      ${events.map((e) => `<tr><td>${escapeHtml(e.createdAt)}</td><td>${escapeHtml(e.fromStatus ?? '—')}</td><td>${escapeHtml(e.toStatus)}</td><td>${escapeHtml(e.note ?? '')}</td></tr>`).join('')}
    </table>
  `;

  app.querySelector('#back').addEventListener('click', renderOrderList);
  app.querySelector('#previous-order')?.addEventListener('click', (e) => {
    e.preventDefault();
    renderOrderDetail(order.previousOrderId);
  });

  app.querySelectorAll('[data-download]').forEach((btn) => {
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

  const statusButtons = app.querySelector('#status-buttons');
  const next = NEXT_STATUSES[order.status] || [];
  statusButtons.innerHTML = next.length
    ? next
        .map(
          (s) =>
            `<button data-status="${escapeHtml(s)}" style="margin-right:0.5rem">${escapeHtml(s)}</button>`,
        )
        .join('')
    : '<span class="muted">terminal status</span>';
  statusButtons.querySelectorAll('[data-status]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/admin/orders/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: btn.dataset.status }),
        });
        renderOrderDetail(id);
      } catch (err) {
        alert(err.message);
      }
    });
  });

  app.querySelector('#wc-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = app.querySelector('#wc-error');
    errorEl.textContent = '';
    let payload;
    if (needsFileWordCounts) {
      // A blank is not a zero: a file nobody counted must stop the price (§4b).
      const fileWordCounts = {};
      for (const input of e.target.querySelectorAll('[data-file-id]')) {
        if (input.value.trim() === '') {
          errorEl.textContent = 'Enter a word count for every file.';
          return;
        }
        fileWordCounts[input.dataset.fileId] = Number(input.value);
      }
      payload = { fileWordCounts };
    } else {
      payload = { wordCount: Number(e.target.wordCount.value) };
    }
    try {
      await api(`/api/admin/orders/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      renderOrderDetail(id);
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });

  app.querySelector('#deliver-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const errorEl = app.querySelector('#deliver-error');
    errorEl.textContent = '';
    const data = new FormData();
    for (const file of form.files.files) data.append('files', file, file.name);
    data.append('markDelivered', form.markDelivered.checked ? 'true' : 'false');
    try {
      const res = await fetch(`/api/admin/orders/${id}/deliver`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: data,
      });
      if (!res.ok) throw new Error((await res.json()).error || 'upload failed');
      renderOrderDetail(id);
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });
}

async function renderOrderList() {
  let orders;
  try {
    orders = await api('/api/admin/orders');
  } catch (err) {
    app.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
    return;
  }

  app.innerHTML = `
    ${navHtml('orders')}
    <h2>All orders</h2>
    <table>
      <tr><th>#</th><th>Client</th><th>Languages</th><th>Status</th><th>Words</th><th>Price</th></tr>
      ${
        orders
          .map(
            (o) => `
        <tr data-open="${o.id}" style="cursor:pointer">
          <td>${o.id}</td>
          <td>client #${o.clientId}</td>
          <td>${escapeHtml(o.srcLang)} → ${escapeHtml(o.tgtLangs.join(', '))}</td>
          <td>${statusBadge(o.status)}</td>
          <td>${o.wordCount ?? 'pending'}</td>
          <td>${money(o.price)}</td>
        </tr>`,
          )
          .join('') || '<tr><td colspan="6" class="muted">No orders yet.</td></tr>'
      }
    </table>
  `;
  app.querySelectorAll('[data-open]').forEach((row) => {
    row.addEventListener('click', () => renderOrderDetail(row.dataset.open));
  });
  wireNav();
}

/** The navigation bar every list screen shares, with the log-out button. */
function navHtml(active) {
  const tab = (id, label) =>
    `<button class="${active === id ? '' : 'secondary'}" data-nav="${id}">${label}</button>`;
  return `<div style="margin-bottom:1rem">
    ${tab('orders', 'Orders')} ${tab('clients', 'Clients')} ${tab('rates', 'Rates')}
    <button class="secondary" id="logout" style="float:right">Log out</button>
  </div>`;
}

/** Makes the bar `navHtml` drew work. Call it after setting `app.innerHTML`. */
function wireNav() {
  const screens = { orders: renderOrderList, clients: renderClients, rates: renderRates };
  app.querySelectorAll('[data-nav]').forEach((btn) => {
    btn.addEventListener('click', () => screens[btn.dataset.nav]());
  });
  app.querySelector('#logout').addEventListener('click', async () => {
    await fetch('/api/admin/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
    sessionStorage.removeItem('portal_admin_token');
    token = null;
    renderLogin();
  });
}

/** A client's private link: the page's own address and the client's token (portal-v0-spec.md §9b). */
function clientLink(client) {
  return `${location.origin}/client.html#token=${encodeURIComponent(client.accessToken)}`;
}

async function postJson(path, body) {
  return api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Clients: who can use the portal, and each one's private link. `justMade` is a client just added. */
async function renderClients(justMade) {
  let clients;
  try {
    clients = await api('/api/admin/clients');
  } catch (err) {
    app.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
    return;
  }
  app.innerHTML = `
    ${navHtml('clients')}
    <h2>Clients</h2>
    ${
      justMade
        ? `<div class="card">
        <strong>${escapeHtml(justMade.name)}</strong> was added. Send them this private link. It is
        their only credential, so send it only to them.
        <input readonly id="new-link" value="${escapeHtml(clientLink(justMade))}" style="width:100%; margin-top:0.5rem" />
      </div>`
        : ''
    }
    <table>
      <tr><th>#</th><th>Name</th><th>Email</th><th>Private link</th></tr>
      ${
        clients
          .map(
            (c) => `<tr>
          <td>${c.id}</td>
          <td>${escapeHtml(c.name)}</td>
          <td>${escapeHtml(c.email)}</td>
          <td><button class="secondary" data-copy="${c.id}">Copy link</button></td>
        </tr>`,
          )
          .join('') || '<tr><td colspan="4" class="muted">No clients yet.</td></tr>'
      }
    </table>

    <h3>Add a client</h3>
    <form id="new-client" class="card" style="max-width:28rem">
      <label>Name<input name="name" required maxlength="200" /></label>
      <label>Email<input type="email" name="email" required maxlength="254" /></label>
      <button type="submit">Add client</button>
      <p class="error" id="client-error"></p>
    </form>
  `;
  wireNav();
  const newLink = app.querySelector('#new-link');
  if (newLink) newLink.addEventListener('focus', () => newLink.select());
  app.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const client = clients.find((c) => String(c.id) === btn.dataset.copy);
      const link = clientLink(client);
      try {
        await navigator.clipboard.writeText(link);
        btn.textContent = 'Copied';
      } catch {
        // No clipboard (an insecure context, a denied permission): show it to copy by hand.
        window.prompt("Copy this client's private link:", link);
      }
    });
  });
  app.querySelector('#new-client').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = app.querySelector('#client-error');
    errorEl.textContent = '';
    try {
      const created = await postJson('/api/admin/clients', {
        name: e.target.name.value,
        email: e.target.email.value,
      });
      renderClients(created);
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });
}

/** Rates: the language pairs a client can order, and what each costs. Saving a pair that exists updates it. */
async function renderRates() {
  let rates;
  try {
    rates = await api('/api/admin/rates');
  } catch (err) {
    app.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
    return;
  }
  app.innerHTML = `
    ${navHtml('rates')}
    <h2>Rates</h2>
    <p class="muted">A client can order only the language pairs listed here.</p>
    <table>
      <tr><th>From</th><th>To</th><th>Per word</th><th>Minimum price</th><th>Minimum words per file</th></tr>
      ${
        rates
          .map(
            (r) => `<tr>
          <td>${escapeHtml(r.srcLang)}</td>
          <td>${escapeHtml(r.tgtLang)}</td>
          <td>${escapeHtml(r.ratePerWord)}</td>
          <td>${escapeHtml(r.minimumPrice)}</td>
          <td>${escapeHtml(r.minWordsPerFile ?? 0)}</td>
        </tr>`,
          )
          .join('') || '<tr><td colspan="5" class="muted">No rates yet.</td></tr>'
      }
    </table>

    <h3>Add or change a rate</h3>
    <form id="new-rate" class="card" style="max-width:28rem">
      <label>From (language code, such as en)<input name="srcLang" required /></label>
      <label>To (language code, such as es or pt-BR)<input name="tgtLang" required /></label>
      <label>Price per word<input type="number" name="ratePerWord" min="0" step="any" required /></label>
      <label>Minimum price for a job<input type="number" name="minimumPrice" min="0" step="any" required /></label>
      <label>Minimum words counted per file (optional, 0 is off)<input type="number" name="minWordsPerFile" min="0" step="1" /></label>
      <button type="submit">Save rate</button>
      <p class="error" id="rate-error"></p>
    </form>
  `;
  wireNav();
  app.querySelector('#new-rate').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = app.querySelector('#rate-error');
    errorEl.textContent = '';
    const f = e.target;
    const body = {
      srcLang: f.srcLang.value,
      tgtLang: f.tgtLang.value,
      ratePerWord: Number(f.ratePerWord.value),
      minimumPrice: Number(f.minimumPrice.value),
    };
    if (f.minWordsPerFile.value !== '')
      body.minWordsPerFile = Number(f.minWordsPerFile.value);
    try {
      await postJson('/api/admin/rates', body);
      renderRates();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });
}

if (token) {
  renderOrderList();
} else {
  renderLogin();
}
