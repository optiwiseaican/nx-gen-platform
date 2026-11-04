import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { AuditService } from '../audit/audit.service';
import { loadConfig } from '../config/nxgen.config';
import { PlatformIdentityService } from '../platform/platform-identity.service';
import { SecureStorageService } from '../security/secure-storage.service';

/**
 * DEVELOPMENT ONLY: removes the activated license so the three activation
 * screens can be exercised again. The audit trail is kept and records the reset.
 * Restart the server afterwards (license state is held in memory).
 */
const config = loadConfig();
if (config.production)
  throw new Error('dev:reset-activation is not available in production');

const active = join(config.dataDir, 'licensing', 'active.nxlic.enc');
if (!existsSync(active)) {
  console.log('Platform is not activated; nothing to reset.');
  process.exit(0);
}
rmSync(active);
const platform = new PlatformIdentityService(
  config,
  new SecureStorageService(config),
);
new AuditService(config).record({
  category: 'LICENSING',
  action: 'DEV_ACTIVATION_RESET',
  result: 'INFO',
  actor: 'DEVELOPER',
  platformInstanceId: platform.getIdentity().identity?.instanceId ?? null,
  reason: 'Development reset of activation state',
});
console.log('Activation reset. Restart the server (npm run dev:server).');
