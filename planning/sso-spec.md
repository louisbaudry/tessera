# Single sign-on with Microsoft 365 and Google — spec

Status: decided 2026-10-25 in a scoping conversation with Louis. Slice 1 (#316) is built
(`core/auth/sso.ts`, platform schema v14, `server/src/sso.ts`); slices 2 and 3 are not. The
build is the three cards at the end (§8); this file is the design they share, and where
slice 1 learned something the text below says so (notes marked _Slice 1_).

Extends: `tenant-spec.md` (D2, D3, D6, D7, D14), `vendor-spec.md` §1 (invitations),
`portal-v0-spec.md` §7 and §9a, `audit-spec.md` §2.1 and §3.1.

## 0. Why

Staff, vendors and a tenant's clients sign in with an email and a password today
(`account`, `account_session`; the portal's `admin_user`; a client's private link).
Louis wants each of them able to use the Microsoft 365 or Google account they already
have: the people Tessera is sold to run their mail on one or the other, and a password
nobody must remember is also one fewer to leak. SSO is **an additional way in**, not a
replacement: the password stays.

## 1. Terms

- **Identity.** A person as one provider knows them: the provider, its issuer, and the
  stable `sub` (subject) claim of its ID token. Never the email.
- **Identity link.** A row tying one identity to one Tessera account (or, in a portal, to
  one client contact). A link is made once, by a person who has already proved who they
  are another way, and is the only thing a later SSO sign-in is matched on.
- **Callback host.** The one address, `auth.<CAT_BASE_DOMAIN>`, that receives every
  provider callback (D4).
- **Client contact.** A person at a tenant's client who signs in to that tenant's portal;
  email only, created by the tenant's admin (D6).

## 2. Decisions (2026-10-25)

**D1. SSO is invite-bound: it can sign in someone who already exists, and creates no one.**
A sign-in with no linked identity makes no account, however good the provider's email
claim looks. This keeps `tenant-spec.md` D7 (no signup route) and O4 (signup is a
commercial and legal call) true, and it is what stops "anyone with a Gmail address" from
becoming a Tessera user. Rejected: matching a verified email to an existing account
automatically, and open signup through SSO. Microsoft's own reference says its `email`
claim "isn't guaranteed to be correct and is mutable over time" and to "never use it for
authorization" (read 2026-10-25), and Google says to key a user on `sub`, not `email`, so an
address is never what opens an account here.

**D2. A sign-in is matched on `(provider, issuer, sub)`, never on the email.** The link
table is `account_identity`:

```sql
CREATE TABLE account_identity (
  id            INTEGER PRIMARY KEY,
  account_id    INTEGER NOT NULL REFERENCES account(id),
  provider      TEXT NOT NULL CHECK (provider IN ('google', 'microsoft')),  -- frozen literal
  issuer        TEXT NOT NULL,   -- Google: the issuer; Microsoft: the issuer of the token's tid
  subject       TEXT NOT NULL,
  linked_at     TEXT NOT NULL,
  last_login_at TEXT,
  UNIQUE (provider, issuer, subject)
);
CREATE INDEX account_identity_account ON account_identity(account_id);
```

The email the provider reported is **not stored**: it identifies a person and it cannot
be matched on, so it earns no column (an audit detail carries none either, as for every
platform event). An account may hold several links (a Google and a Microsoft one); an
identity belongs to exactly one account. For Microsoft the stable subject is per
application and per directory, so `issuer` carries the directory (`tid`) and a person
who signs in from two directories is two identities, linked deliberately.

**D3. Linking happens in three places, each behind proof of who the person is.**

1. **Accepting an invitation** (staff `staff_invitation`, vendor `vendor_invitation`):
   the one-time link, plus a provider sign-in in place of choosing a password. The
   invitation fixes the tenant, role and email as today. **The link is the proof**, as it
   is when the invitee types a password today: whoever holds the one-time secret chooses
   how the account will be opened, and no address from the provider is compared with the
   invited one (a Microsoft `email` claim cannot be trusted for that, D1). The account is
   then created with the link in the same transaction.
2. **An existing account's settings:** a person logged in by password links an identity,
   and may unlink it as long as they keep another way in (a password, or another link).
3. **A vendor joining a second roster** (`joinInvitation`, #187) behind the login gate:
   they sign in on that tenant's host by password or by a linked identity, as today's
   `join-signin`.

An account made by an invitation that chose SSO has **no password**. `account.password_hash`
is `NOT NULL` and `account` is referenced, so `rebuildTable` refuses it (`tenant-spec.md`
§4): such an account stores a fixed sentinel that no `verifyPassword` can match
(`NO_PASSWORD_HASH`, one definition in `core/auth/credentials.ts`), and the server
refuses a password login for it before comparing. Revisit the sentinel when the runner
can turn foreign keys off.

**D4. One operator-owned OAuth app per provider, and one neutral callback host.**
Louis chose (2026-10-25) one Google OAuth client and one Microsoft Entra multi-tenant
application, owned by the operator, so a tenant sets up nothing. Both providers accept
only exact redirect URLs, and each tenant is its own subdomain (`tenant-spec.md` D14),
so every callback goes to one address, `auth.<CAT_BASE_DOMAIN>` (`auth` is already a
reserved slug). The flow:

1. The tenant's host starts it: `POST /api/login/sso/start` with the provider and a
   **browser secret** the page made and keeps in session storage. The server mints a
   `state`, a `nonce` and a PKCE verifier, and stores them with the tenant's id, the
   purpose (`login` or `link` in slice 1; slice 2 adds the invitation purposes), the
   hash of the browser secret and a five-minute expiry, in `sso_attempt` (a row, never
   memory, so a restart does not strand a person mid-flow; deleted when used). It
   answers with the provider's URL.
2. The provider redirects to the callback host. That host looks the attempt up by
   `state`, exchanges the code (PKCE), verifies the ID token (D5), and **makes no
   session**. It mints a one-time hand-off code, stored only as its hash with a one-minute
   expiry, bound to the attempt, and redirects the browser to
   `<slug>.<base>/#sso=<code>`.
3. The tenant's host redeems the code (`POST /api/login/sso/redeem`, with the browser
   secret): the tenant in the attempt must equal `req.hostTenant`, the purpose must be
   the one it was for, a link only for the account that began it, and the browser the one
   that started it, or it is the one refusal of an unusable code, and **the code is spent
   by the try**. Only then is the session minted, so **a session still exists only on its
   own tenant's host** (D14 rule 1 holds) and the callback host holds no authority.

   _Slice 1:_ the browser secret is what stops a login CSRF: without it an attacker could
   start an attempt, sign in as themselves, and get a victim's browser to present the
   resulting code, landing the victim in the attacker's account. A link additionally
   needs the redeeming session to be the account that began it, so a victim's browser
   cannot complete another account's link. Why a callback host at all, and not a redirect
   URL per tenant: Microsoft caps redirect URIs per app (256 for work and school accounts,
   100 once personal accounts are allowed), forbids wildcards when personal accounts are
   allowed and itself recommends one shared redirect URI with a `state` parameter; Google
   allows no wildcard either (both read 2026-10-25).

The callback host is the first address that is no tenant's, an explicit exception to
D14's "nothing else answers": it serves exactly one route (the callback) and a fixed 404
for everything else, and it needs `auth.<base>` on the wildcard certificate (it already
matches). The hand-off code travels in a `#` fragment, never a path or query, as an
invitation token does. Unset `CAT_BASE_DOMAIN` (development) means one host: the callback
is on it and the redeem is in-process.

**D5. The ID token is verified, not decoded.** With `jose` (D8): signature (RS256 only)
against the provider's published keys, `iss`, `aud` equal to the app's client id, `exp`,
and the attempt's `nonce`. The endpoints and key URLs are read from each provider's
OpenID discovery document (2026-10-25) and **fixed in code** (`SSO_ENDPOINTS`), never taken
from a request or a setting; the keys are cached six hours and read again once when a token
names a key the cache lacks (a rotation). Microsoft's issuer names the directory, so the
token is verified first and its own `tid` (a GUID) is then used to build the issuer it must
equal; a personal account has the fixed `tid` `9188040d-6c67-4c5b-b112-36a304b66dad` and is a
legitimate identity (a freelancer on Outlook.com), recorded as such and not refused. No
redirect is followed and no error carries what a provider said, the rule a new outbound
call always gets (the draft engines, the webhook sender). Reading a reply back or refusing
it, never repairing it, as `core/draft/` does.

_Slice 1:_ the authorization request asks for the scope `openid` alone. The subject and,
for Microsoft, the directory come with it, and an address is neither needed nor wanted
(D1, D2). Slice 2's Google Workspace lock needs the `hd` claim; whether that takes a wider
scope is checked there, not assumed.

**D6. A tenant's clients sign in to the portal as client contacts, beside the link.**
`client_contact` (portal file, so per tenant: `portal-v0-spec.md` §9a, D13): `id`,
`client_id`, `email`, `created_at`, `disabled_at`; and `client_contact_identity`, the
same shape as D2 but keyed to a contact. The tenant's admin creates contacts (email
only; no name, so there is nothing to erase but an address), a contact sees only their
own client's orders, and an unmatched identity is one identical refusal. The private
link keeps working until the admin switches it off for a client (`client.link_enabled`,
default true, so no existing client is cut off by this). The portal is its own app per
tenant (D13): it holds its own `sso_attempt` and redeems on its own host, and it reaches
the callback host by the same D4 hand-off; nothing in it filters by tenant.

**D7. A tenant may require SSO for its staff, locked to its own directory or domain.**
`tenant_sso_policy` (absence-based: no row is no requirement): `tenant_id`,
`require_sso`, `microsoft_tid` (nullable), `google_hd` (nullable), and a staff sign-in
by password is refused while `require_sso` holds and the account has a link. A locked
provider accepts only that Microsoft directory or Google Workspace domain (`hd` is a hint
the token must also match). An admin cannot lock themselves out: the setting is refused
unless the acting admin holds a qualifying link. Vendors are never covered by a policy
(they belong to no tenant, D3) and there is no domain lock for them.

**D8. TypeScript, `jose`; no Rust/Wasm** (asked and decided 2026-10-25, as
`CLAUDE.md`'s rhythm requires). The work is protocol steps and access rules with no hot
kernel, the existing `inject` suites cover it with a fake identity provider that signs
tokens with a test key, and a maintained library (`jose`, MIT, a dependency of `core` and a
dev dependency of `server`'s fixture) does the signature check. MIT is already on the
allowlist, so no exception is recorded; `pnpm licenses:check` covers it, and an npm
dependency is not copied into `THIRD-PARTY-NOTICES.md` (`prior-art.md`).

**D9. Audit and enumeration.** New platform audit actions, each a frozen literal widened
with `rebuildTable`: `account.sso_linked`, `account.sso_unlinked`, `auth.sso_login`,
`auth.sso_login_failed` (slice 1, platform v14, named like the existing `auth.login`) and
`tenant.sso_policy_set` (slice 2). The actor is the person (or the `login`
system actor for a refusal), the tenant is the one the event is about, and no detail
carries an email, a subject or a provider claim. A sign-in that matches nothing, a
linked account that is not on the host's tenant, a disabled contact and an expired code
are **one identical refusal**: the form cannot be used to ask who has an account or who
works for whom (D14 rule 2).

## 3. Per audience

| Who | Gets in by | Lock |
| --- | --- | --- |
| Staff | invitation (D3.1), or linking from settings | optional, per tenant (D7) |
| Vendor | invitation (D3.1) or `join` (D3.3); any provider, personal accounts included | none |
| Client contact | the tenant admin's contact row, linked at first sign-in (D6) | none; link optional |

A freelancer on three rosters has one account and one linked identity, and three logins
(one per tenant host), as `tenant-spec.md` D14 rule 4 already says.

## 4. What the operator does, and Claude cannot

Creating the two registrations and holding their secrets is a credentials step that is
the operator's (`CLAUDE.md`, shared rules: credentials and consent):

- A Google Cloud OAuth client (web), redirect URI
  `https://auth.<base domain>/api/login/sso/callback`, scope `openid` (nothing more is asked).
  Whether Google requires an app verification for that scope alone is unconfirmed: its
  redirect-URI page does not say.
- A Microsoft Entra application registration, "accounts in any organizational directory
  and personal Microsoft accounts", the same redirect URI, ID tokens issued. Publisher
  verification is recommended so another organisation's admin is not shown an unverified
  warning; whether it is required here is unconfirmed.
- The ids and secrets are server environment variables (`GOOGLE_OAUTH_CLIENT_ID`,
  `GOOGLE_OAUTH_CLIENT_SECRET`, `MICROSOFT_OAUTH_CLIENT_ID`, `MICROSOFT_OAUTH_CLIENT_SECRET`),
  read at start; a provider with no pair is off and its button absent. They are never in
  this repo, a log or an error. `SSO_CALLBACK_ORIGIN` is `https://auth.<base domain>` by
  default and may be set only where there is no base domain (development: `http://localhost:3400`
  is allowed, plain http nowhere else); with a base domain the server recognises the callback
  host by that one name, so any other value is refused at startup. Single sign-on is off when no
  provider has a pair or there is nowhere to call back. The Microsoft registration's platform is
  "Web" (the secret stays on the server).
- Recorded in `INFRASTRUCTURE.md` (in `claude-shared`) when the cards land: a new external
  service provider and where its secrets live.

## 5. Privacy

An identity link holds a provider's opaque subject and no address. The provider learns
that a person signed in to Tessera (it must, to authenticate them), which is a
subprocessor fact for `worldwide-and-compliance-spec.md` §6.2, control 10: both providers
go on that list when the first card lands. No translation content or client name goes to
either provider.

## 6. Not decided here

- Enforcing SSO for vendors, a tenant bringing its own OAuth app, SAML, SCIM or
  just-in-time provisioning. A tenant-supplied app is a later enterprise add-on; the
  `account_identity` shape does not change for it (`issuer` already says whose).
- Automatic account merging. Two accounts for one person stay two accounts.
- A neutral login for vendors across tenants (`tenant-spec.md` D14 rule 4).

## 7. Tests first

Each is written before the code that enforces it, with a fake provider:

- A sign-in with no link makes no account and answers the one refusal.
- A token with the wrong `aud`, `iss`, `exp`, `nonce` or signature, or an unverified
  Google email, is refused.
- A linked account signing in on another tenant's host fails as a wrong password does.
- A hand-off code redeems once, only on its own tenant's host, within a minute.
- An unlinked or password-less account cannot be left with no way in.
- No audit detail and no table holds an address or a subject beyond `account_identity`.

## 8. Slices

| # | What | Size | After |
| - | ---- | ---- | ----- |
| 1 | `account_identity`, `sso_attempt`, token verification (`jose`), callback host, `login` by SSO, `NO_PASSWORD_HASH`, audit actions. **Built** (#214), with the login screen's buttons and the link and unlink routes; no settings screen | L | none |
| 2 | SSO in staff and vendor invitation acceptance, linking and unlinking from settings, `tenant_sso_policy` | M | 1 |
| 3 | Portal `client_contact`, its identity link, `client.link_enabled`, the admin's contact screen | L | 1 |

One session on one slice: slices 1 and 2 both change `platform/schema.ts`, and
migration numbers are checked against `main` just before merge. Slice 3 changes the
portal's schema only.
