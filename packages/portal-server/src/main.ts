import { buildGateway } from './gateway.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const gateway = await buildGateway({ config });
await gateway.listen(config.port, '0.0.0.0');
