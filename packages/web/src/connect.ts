/**
 * The consent page's logic (backlog #381, `planning/chat-connector-spec.md` §6b): what a chat
 * host's request looks like once it reaches the application, and what the page says about it.
 * Pure, so it is tested without a DOM; `Connect.tsx` only renders.
 *
 * The page trusts nothing here: the server checks the client and its redirect address again
 * when the page asks what to show and again when the person answers.
 */

/** A chat host's request to connect, as the authorization endpoint put it in the address. */
export interface ConnectRequest {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  /** The client's own value, handed back untouched; null when it sent none. */
  readonly state: string | null;
}

/** What the server says of the client that is asking (`GET /api/oauth/request`). */
export interface ConnectClient {
  /** What the client calls itself: its own claim, which nobody checked. */
  readonly clientName: string;
  /** The host the answer is sent to: checked against what the client registered. */
  readonly redirectHost: string;
  /** Whether that address is a program on this computer. */
  readonly loopback: boolean;
  /** Whether the signed-in account is staff, the only kind that may connect. */
  readonly staff: boolean;
}

/**
 * Reads a request from the query of `#/connect?…`.
 *
 * @returns null when a required part is missing, so the page is never shown half a request.
 */
export function parseConnectRequest(query: string): ConnectRequest | null {
  const params = new URLSearchParams(query);
  const clientId = params.get('client_id');
  const redirectUri = params.get('redirect_uri');
  const codeChallenge = params.get('code_challenge');
  if (!clientId || !redirectUri || !codeChallenge) return null;
  return { clientId, redirectUri, codeChallenge, state: params.get('state') };
}

/** The body of the person's answer (`POST /api/oauth/consent`). */
export function consentBody(
  request: ConnectRequest,
  allow: boolean,
): Record<string, unknown> {
  return {
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    code_challenge: request.codeChallenge,
    ...(request.state === null ? {} : { state: request.state }),
    allow,
  };
}

/**
 * Where the answer goes, in words. The address is the one fact on the page that was checked,
 * so it is said plainly; the name is the client's own and is shown as that.
 */
export function destinationLine(client: ConnectClient): string {
  return client.loopback
    ? 'The answer goes to a program on this computer.'
    : `The answer goes to ${client.redirectHost}.`;
}

/** What connecting lets the assistant do, as of this version: read-only, and no text. */
export const CONNECT_SCOPE: readonly string[] = [
  'See your projects: their names, languages and how many files each has.',
  'See progress: how many segments are translated or confirmed.',
  'See quality-check results as counts.',
];

/** What it cannot do, said on the page because it is what a careful person asks first. */
export const CONNECT_LIMITS =
  'It cannot read or change any document text, file name, memory or glossary, and it cannot confirm, approve or share anything.';
