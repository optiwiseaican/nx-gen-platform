import { loadConfig } from '../config/nxgen.config';
import { initPlatformForDev } from './dev-platform';

const config = loadConfig();
const { identity, installation } = initPlatformForDev(config);
console.log(`Data directory:        ${config.dataDir}`);
console.log(`Platform Instance ID:  ${identity.instanceId}`);
console.log(`Installation ID:       ${installation.installationId}`);
console.log(`Installation verified: ${installation.verification} (simulated)`);
