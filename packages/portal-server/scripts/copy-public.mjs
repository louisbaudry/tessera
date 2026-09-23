// Copies the static UI into dist/ after tsc builds — tsc only compiles
// .ts files, so the plain HTML/JS/CSS under src/public needs its own step.
import { cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
cpSync(join(here, '..', 'src', 'public'), join(here, '..', 'dist', 'public'), {
  recursive: true,
});
