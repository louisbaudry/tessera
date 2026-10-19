# Third-party notices

Tessera's own license (Apache-2.0) is in `LICENSE` and `NOTICE`. This file lists third-party code, data and assets that are **included in
this repository or bundled with the product**, with the license notice each
one requires. The rules for what may enter, and how authors are credited when
they are not required to be, are in `planning/prior-art.md`.

**Nothing is included yet.** Every entry below this line would carry: name
and version, SPDX license, copyright line, URL, what was taken, and where it
lives in the repository.

## npm dependencies

Production dependencies are installed from the registry, not copied here.
Their licenses are checked by `pnpm licenses:check` against the policy in
`scripts/license-policy.mjs`, and a distribution of the built product must
ship the notices those licenses require. Generate the list for a release with
`pnpm licenses list --prod --json`.

## Included code, data and assets

None.
