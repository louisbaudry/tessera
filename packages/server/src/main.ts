import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
mkdirSync(dirname(config.dbPath), { recursive: true });
mkdirSync(config.storageRoot, { recursive: true });

const app = await buildApp({ config });
await app.listen({ port: config.port, host: '0.0.0.0' });
