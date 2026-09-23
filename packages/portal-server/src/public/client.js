// Deliberately no framework — a private link and a couple of screens
// don't need a build step (portal-v0-spec.md §8, "keep it simple").
const app = document.getElementById('app');

function tokenFromHash() {
  const match = /token=([^&]+)/.exec(location.hash);
  return match
    ? decodeURIComponent(match[1])
    : localStorage.getItem('portal_client_token');
}

const token = tokenFromHash();
if (token) localStorage.setItem('portal_client_token', token);

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `request failed (${res.status})`);
  }
  return res.json();
}

function statusBadge(status) {
  return `<span class="status ${status}">${status.replace('_', ' ')}</span>`;
}

function money(n) {
  return n == null ? '—' : `$${n.toFixed(2)}`;
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
            ? `<button class="secondary" data-download="${downloadPath(f)}" data-filename="${escapeHtml(f.filename)}">Download</button>`
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

async function renderHome() {
  if (!token) {
    app.innerHTML = `<p class="error">No access link found. Use the private link Optime sent you.</p>`;
    return;
  }

  let me, orders, rates;
  try {
    [me, orders, rates] = await Promise.all([
      api('/api/client/me'),
      api('/api/client/orders'),
      api('/api/client/rates'),
    ]);
  } catch (err) {
    app.innerHTML = `<p class="error">${err.message}</p>`;
    return;
  }

  app.innerHTML = `
    <p>Welcome, ${me.name}.</p>

    <h2>New translation request</h2>
    <form id="new-order">
      <label>Source language</label>
      <select name="srcLang" required></select>

      <label>Target language(s) — hold Ctrl/Cmd to select more than one</label>
      <select name="tgtLangs" multiple required style="height: 5rem"></select>

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
  `;

  const langs = [...new Set(rates.flatMap((r) => [r.srcLang, r.tgtLang]))].sort();
  const srcSelect = app.querySelector('select[name="srcLang"]');
  const tgtSelect = app.querySelector('select[name="tgtLangs"]');
  for (const lang of langs) {
    srcSelect.add(new Option(lang, lang));
    tgtSelect.add(new Option(lang, lang));
  }

  const ordersDiv = app.querySelector('#orders');
  if (orders.length === 0) {
    ordersDiv.innerHTML = `<p class="muted">No requests yet.</p>`;
  } else {
    ordersDiv.innerHTML = orders
      .map(
        (o) => `
      <div class="card">
        <strong>#${o.id}</strong> ${o.srcLang} → ${o.tgtLangs.join(', ')}
        ${statusBadge(o.status)}
        <div class="muted">Words: ${o.wordCount ?? 'estimate pending'} · Price: ${money(o.price)}</div>
        ${
          o.status === 'submitted'
            ? `<button data-approve="${o.id}" ${o.price == null ? 'disabled title="Waiting on a word-count estimate before you can approve."' : ''}>Approve</button>`
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
          await api(`/api/client/orders/${btn.dataset.approve}/approve`, {
            method: 'POST',
          });
          renderHome();
        } catch (err) {
          alert(err.message);
          btn.disabled = false;
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

renderHome();
