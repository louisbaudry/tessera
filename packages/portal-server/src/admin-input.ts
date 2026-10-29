/**
 * Input checks for the admin's two write routes, `POST /api/admin/clients` and `POST /api/admin/rates`
 * (issue #328, `planning/portal-v0-spec.md` §9b). Pure functions that return a message for the admin or
 * `null`, so the routes stay a repository call with HTTP around it and the rules are provable without a
 * server. A form makes these checks necessary: a typo should be a clear 400, never a database error.
 */

/** A language tag as the portal uses it: `en`, `pt-BR`, `zh-Hant`. Not a full BCP-47 grammar on purpose. */
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const CLIENT_NAME_MAX_LENGTH = 200;
export const EMAIL_MAX_LENGTH = 254;

/** The values of a new client once trimmed, or the message to send back. */
export function checkClientInput(
  body: unknown,
): { name: string; email: string } | { problem: string } {
  const { name, email } = (body ?? {}) as { name?: unknown; email?: unknown };
  if (typeof name !== 'string' || name.trim() === '') {
    return { problem: 'name is required' };
  }
  if (name.trim().length > CLIENT_NAME_MAX_LENGTH) {
    return { problem: `name must be at most ${CLIENT_NAME_MAX_LENGTH} characters` };
  }
  if (typeof email !== 'string' || !EMAIL.test(email.trim())) {
    return { problem: 'email must be an email address' };
  }
  if (email.trim().length > EMAIL_MAX_LENGTH) {
    return { problem: `email must be at most ${EMAIL_MAX_LENGTH} characters` };
  }
  return { name: name.trim(), email: email.trim() };
}

/** The language pair and prices of a rate once trimmed, or the message to send back. */
export function checkRateInput(body: unknown):
  | {
      srcLang: string;
      tgtLang: string;
      ratePerWord: number;
      minimumPrice: number;
    }
  | { problem: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const src = typeof b.srcLang === 'string' ? b.srcLang.trim() : '';
  const tgt = typeof b.tgtLang === 'string' ? b.tgtLang.trim() : '';
  if (!LANGUAGE_TAG.test(src) || !LANGUAGE_TAG.test(tgt)) {
    return { problem: 'srcLang and tgtLang must be language tags such as en or pt-BR' };
  }
  if (src.toLowerCase() === tgt.toLowerCase()) {
    return { problem: 'srcLang and tgtLang must be different' };
  }
  const { ratePerWord, minimumPrice } = b;
  if (
    typeof ratePerWord !== 'number' ||
    !Number.isFinite(ratePerWord) ||
    ratePerWord <= 0
  ) {
    return { problem: 'ratePerWord must be a number above zero' };
  }
  if (
    typeof minimumPrice !== 'number' ||
    !Number.isFinite(minimumPrice) ||
    minimumPrice < 0
  ) {
    return { problem: 'minimumPrice must be a number, zero or more' };
  }
  return { srcLang: src, tgtLang: tgt, ratePerWord, minimumPrice };
}
