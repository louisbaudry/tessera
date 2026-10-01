/**
 * What a project or memory may be called on the server (v1-spec.md §2.5,
 * §7.5): a slug that is also its file's basename. One definition for
 * the server, which builds paths from it, and the SPA, which checks a
 * name as it is typed and suggests one from a title.
 *
 * The alphabet is the server's whole defence against path traversal:
 * nothing matching it can contain a separator, a dot, or be empty.
 */
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export const SLUG_MAX_LENGTH = 64;

export function isSlug(name: string): boolean {
  return SLUG.test(name);
}

/**
 * The slug a title suggests: accents dropped, lowercased, every other
 * run of characters a single hyphen, trimmed to the alphabet's length.
 * Empty when nothing in the title survives (a title all in another
 * script); the caller then asks for one.
 */
export function slugify(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/^-+|-+$/g, '');
}
