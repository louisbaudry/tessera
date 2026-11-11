/**
 * The consent page (backlog #381, `planning/chat-connector-spec.md` §6b): a chat host sent
 * this browser here to ask whether it may connect to the signed-in person's account. The page
 * says who is asking (the client's own claim), where the answer goes (checked), what the
 * connection can and cannot do, and takes one answer. Either answer sends the browser back to
 * the chat host; the server builds that address, never the page.
 */
import { useCallback } from 'react';

import { api } from './api.js';
import {
  CONNECT_LIMITS,
  CONNECT_SCOPE,
  consentBody,
  destinationLine,
  type ConnectRequest,
} from './connect.js';
import { useAction } from './use-action.js';
import { useLoad } from './use-load.js';

export function Connect({ request }: { request: ConnectRequest }) {
  const load = useCallback(
    (t: string, signal: AbortSignal) => api.connectRequest(t, request, signal),
    [request],
  );
  const loaded = useLoad(load);
  const action = useAction();

  const answer = async (allow: boolean) => {
    const sent = await action.run((t) =>
      api.connectAnswer(t, consentBody(request, allow)),
    );
    // Leaves the application: the chat host takes it from here.
    if (sent) window.location.assign(sent.redirect);
  };

  if (loaded.state === 'loading') return <p className="muted">Loading{'\u2026'}</p>;
  if (loaded.state === 'error') {
    return (
      <div className="page connect">
        <h2>Connect a chat assistant</h2>
        <p className="error">
          This request cannot be used. Start again from your chat assistant.
        </p>
      </div>
    );
  }
  const client = loaded.data;
  return (
    <div className="page connect">
      <h2>Connect a chat assistant</h2>
      <p>
        An application that calls itself <strong>{client.clientName}</strong> asks to
        connect to your account. That name is its own and has not been checked.
      </p>
      <p>{destinationLine(client)}</p>
      {client.staff ? (
        <>
          <p>If you allow it, it can:</p>
          <ul>
            {CONNECT_SCOPE.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="muted">{CONNECT_LIMITS}</p>
          <p className="muted">
            You can end the connection at any time under Account. Allow it only if you
            started this from your own chat assistant just now.
          </p>
          {action.error && (
            <p className="error" role="alert">
              {action.error}
            </p>
          )}
          <div className="actions">
            <button
              type="button"
              disabled={action.busy}
              onClick={() => void answer(true)}
            >
              Allow
            </button>
            <button
              type="button"
              className="secondary"
              disabled={action.busy}
              onClick={() => void answer(false)}
            >
              Deny
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="error">
            Only a member of an organisation can connect a chat assistant; this account
            cannot.
          </p>
          <button
            type="button"
            className="secondary"
            disabled={action.busy}
            onClick={() => void answer(false)}
          >
            Go back
          </button>
        </>
      )}
    </div>
  );
}
