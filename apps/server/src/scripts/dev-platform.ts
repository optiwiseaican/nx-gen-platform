import { randomBytes } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { NxGenConfig } from '../config/nxgen.config';
import { PlatformIdentityService } from '../platform/platform-identity.service';
import { SecureStorageService } from '../security/secure-storage.service';

/**
 * DEVELOPMENT ONLY. Simulates the two Smart Installer steps that licensing
 * depends on: secure initialization (Platform Instance ID) and a PASS
 * post-installation verification. Never ship scripts/ in a customer build.
 */
export function initPlatformForDev(config: NxGenConfig) {
  if (config.production)
    throw new Error('Refusing to simulate installation in production');
  const storage = new SecureStorageService(config);
  const platform = new PlatformIdentityService(config, storage);
  const audit = new AuditService(config);

  let identity = platform.getIdentity().identity;
  if (!identity) {
    identity = platform.initializeIdentity();
    audit.record({
      category: 'PLATFORM',
      action: 'PLATFORM_IDENTITY_CREATED',
      result: 'SUCCESS',
      actor: 'SYSTEM_INSTALLER',
      platformInstanceId: identity.instanceId,
      details: { simulated: true },
    });
  }

  // Older dev records predate the `source` marker: re-seal them as simulated.
  const existing = platform.getInstallation();
  if (existing && platform.isInstallationVerified() && !existing.source) {
    platform.recordInstallationVerification({
      ...existing,
      source: 'DEV_SIMULATION',
    });
  }

  if (!platform.isInstallationVerified()) {
    const installationId = `NXI-${new Date().getFullYear()}-DEV${randomBytes(2).toString('hex').toUpperCase()}`;
    platform.recordInstallationVerification({
      installationId,
      verification: 'PASS',
      verifiedAt: new Date().toISOString(),
      platformVersion: config.platformVersion,
      source: 'DEV_SIMULATION',
    });
    audit.record({
      category: 'PLATFORM',
      action: 'INSTALLATION_VERIFICATION_RECORDED',
      result: 'SUCCESS',
      actor: 'SYSTEM_INSTALLER',
      platformInstanceId: identity.instanceId,
      details: { installationId, verification: 'PASS', simulated: true },
    });
  }
  return { identity, installation: platform.getInstallation()!, storage };
}
