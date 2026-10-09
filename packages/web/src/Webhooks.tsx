/**
 * The owner's webhook endpoints (backlog #125; `vendor-spec.md`, its #125 note):
 * where Tessera posts signed events about assignments and payables, with what has
 * become of what was sent. The signing secret is shown once, in the response that
 * creates an endpoint, and never again. What the lines say is `webhooks.ts`'s.
 */
import { useCallback, useState, type FormEvent } from 'react';

import { api, type WebhookView } from './api.js';
import { useAction } from './use-action.js';
import { useLoad } from './use-load.js';
import {
  deliverySummary,
  lastAnswer,
  needsAttention,
  SIGNATURE_HELP,
  urlProblem,
} from './webhooks.js';

export function Webhooks() {
  // Read again after every write, so what shows is what is stored.
  const [version, setVersion] = useState(0);
  const [fresh, setFresh] = useState<{ host: string; secret: string } | null>(null);
  const list = useLoad(
    useCallback(
      (token, signal) => {
        void version;
        return api.webhooks(token, signal);
      },
      [version],
    ),
  );
  const endpoints = list.state === 'done' ? list.data.webhooks : [];
  return (
    <section className="list webhooks" aria-label="Webhooks">
      <h3>Webhooks</h3>
      <p className="muted">
        Tessera posts a signed message to your address when an assignment changes or a
        payable locks. The message carries ids and states only, never a name, a note or an
        amount: read the details from the API.
      </p>
      <Add
        existing={endpoints.length}
        onAdded={(host, secret) => {
          setFresh({ host, secret });
          setVersion((v) => v + 1);
        }}
      />
      {fresh && <FreshSecret host={fresh.host} secret={fresh.secret} />}
      {list.state === 'error' && <p className="error">{list.message}</p>}
      {endpoints.length > 0 && (
        <ul>
          {endpoints.map((w) => (
            <Endpoint key={w.id} webhook={w} onChanged={() => setVersion((v) => v + 1)} />
          ))}
        </ul>
      )}
    </section>
  );
}

function Add({
  existing,
  onAdded,
}: {
  existing: number;
  onAdded: (host: string, secret: string) => void;
}) {
  const action = useAction();
  const [url, setUrl] = useState('');
  const problem = urlProblem(url, existing);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (problem !== null) return;
    const done = await action.run((token) => api.addWebhook(token, url.trim()));
    if (done) {
      onAdded(done.webhook.host, done.secret);
      setUrl('');
    }
  };
  return (
    <form className="panel form" onSubmit={(e) => void submit(e)}>
      <label>
        Address that receives the events
        <input
          type="url"
          value={url}
          placeholder="https://example.com/hooks/tessera"
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      <div className="actions">
        <button type="submit" disabled={action.busy || problem !== null}>
          Add address
        </button>
        {url !== '' && problem && <span className="muted">{problem}</span>}
        {action.error && <span className="error">{action.error}</span>}
      </div>
    </form>
  );
}

/** The secret, once. Closing the page or adding another forgets it: only the server's copy remains. */
function FreshSecret({ host, secret }: { host: string; secret: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      // No clipboard permission: the box below can be selected by hand.
    }
  };
  return (
    <section className="panel fresh-link" aria-label="New signing secret">
      <h3>Signing secret for {host}</h3>
      <p className="muted">
        Copy it now and keep it where the receiver can read it. It is not shown again; if
        it is lost, remove the address and add it again.
      </p>
      <div className="copy-row">
        <input
          type="text"
          readOnly
          value={secret}
          aria-label="Signing secret"
          onFocus={(e) => e.currentTarget.select()}
        />
        <button type="button" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <ul className="muted">
        {SIGNATURE_HELP.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </section>
  );
}

function Endpoint({
  webhook,
  onChanged,
}: {
  webhook: WebhookView;
  onChanged: () => void;
}) {
  const action = useAction();
  const [note, setNote] = useState<string | null>(null);
  const answer = lastAnswer(webhook);
  return (
    <li>
      <span>
        {webhook.host}
        {needsAttention(webhook) && <span className="chip warn"> needs attention</span>}
      </span>
      <span className="muted record">
        {deliverySummary(webhook)}
        {answer ? ` · ${answer}` : ''}
        {note ? ` · ${note}` : ''}
        {action.error && <span className="error"> {action.error}</span>}
      </span>
      <span className="row-actions">
        <button
          type="button"
          className="link"
          disabled={action.busy}
          onClick={() =>
            void action
              .run((token) => api.testWebhook(token, webhook.id))
              .then((done) => {
                if (done) {
                  setNote('test queued');
                  window.setTimeout(onChanged, 1500);
                }
              })
          }
        >
          Send a test
        </button>
        <button
          type="button"
          className="link"
          disabled={action.busy}
          onClick={() =>
            void action
              .run((token) => api.removeWebhook(token, webhook.id))
              .then((done) => {
                if (done) onChanged();
              })
          }
        >
          Remove
        </button>
      </span>
    </li>
  );
}
