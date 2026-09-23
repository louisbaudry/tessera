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
      <p class="error" id="login-error">${message}</p>
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
  return `<span class="status ${status}">${status.replace('_', ' ')}</span>`;
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

function fileRows(files, downloadPath) {
  if (files.length === 0) return '<tr><td colspan="4" class="muted">none</td></tr>';
  return files
    .map(
      (f) => `<tr>
        <td>${escapeHtml(f.filename)}</td>
        <td>${escapeHtml(f.contentType)}</td>
        <td>${f.byteSize.toLocaleString()}</td>
        <td><button class="secondary" data-download="${downloadPath(f)}" data-filename="${escapeHtml(f.filename)}">Download</button></td>
      </tr>`,
    )
    .join('');
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

async function renderOrderDetail(id) {
  const { order, sourceFiles, deliveredFiles, events } = await api(
    `/api/admin/orders/${id}`,
  );

  app.innerHTML = `
    <button class="secondary" id="back">&larr; All orders</button>
    <h2>Order #${order.id} ${statusBadge(order.status)}</h2>
    <p>${order.srcLang} &rarr; ${order.tgtLangs.join(', ')}</p>
    <p class="muted">${order.notes || ''}</p>

    <div class="card">
      <label>Word count</label>
      <form id="wc-form" style="display:flex; gap:0.5rem; align-items:end">
        <input type="number" name="wordCount" min="0" value="${order.wordCount ?? ''}" style="width:8rem" />
        <button type="submit" style="margin-top:0">Set &amp; price</button>
      </form>
      <p>Price: <strong>${money(order.price)}</strong></p>
      <p class="error" id="wc-error"></p>
    </div>

    <div class="card">
      <label>Status</label>
      <div id="status-buttons"></div>
    </div>

    <h2>Source files</h2>
    <table>
      <tr><th>Filename</th><th>Type</th><th>Size</th><th></th></tr>
      ${fileRows(sourceFiles, (f) => `/api/admin/orders/${order.id}/source-files/${f.id}`)}
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
      ${events.map((e) => `<tr><td>${e.createdAt}</td><td>${e.fromStatus ?? '—'}</td><td>${e.toStatus}</td><td>${e.note ?? ''}</td></tr>`).join('')}
    </table>
  `;

  app.querySelector('#back').addEventListener('click', renderOrderList);

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
          (s) => `<button data-status="${s}" style="margin-right:0.5rem">${s}</button>`,
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
    const wordCount = Number(e.target.wordCount.value);
    const errorEl = app.querySelector('#wc-error');
    errorEl.textContent = '';
    try {
      await api(`/api/admin/orders/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wordCount }),
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
    app.innerHTML = `<p class="error">${err.message}</p>`;
    return;
  }

  app.innerHTML = `
    <button class="secondary" id="logout" style="float:right">Log out</button>
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
          <td>${o.srcLang} → ${o.tgtLangs.join(', ')}</td>
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

if (token) {
  renderOrderList();
} else {
  renderLogin();
}
