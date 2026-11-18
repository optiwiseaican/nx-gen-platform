import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { arch, hostname, platform as osPlatform, release } from 'os';
import { join, resolve } from 'path';
import { Client } from 'pg';
import { BootstrapJournal } from '../audit/bootstrap-journal';
import type { NxGenConfig } from '../config/nxgen.config';
import {
  InstallationVerification,
  PlatformIdentityService,
} from '../platform/platform-identity.service';
import { SecureStorageService } from '../security/secure-storage.service';

export interface InstallationCheck {
  id: string;
  label: string;
  status: 'PASS' | 'WARNING' | 'FAIL';
  detail?: string;
}

export interface InstallationReport {
  installationId: string;
  verification: InstallationVerification;
  softwareVersion: string;
  machineName: string;
  operatingSystem: string;
  installedAt: string;
  platformInstanceId: string | null;
  checks: InstallationCheck[];
}

export interface SmartInstallerOptions {
  /** The service's own folder (dist/..): checked for its files and migrations. */
  serviceDir?: string;
  /** The screens' folder (NXGEN_WEB_DIR) when the service serves them. */
  webDir?: string | null;
  now?: Date;
  /** Replaces the PostgreSQL connection check (tests). */
  checkDatabase?: () => Promise<string>;
}

/**
 * The Smart Installer's secure initialization and post-installation verification (master specification
 * §15–16), run by the desktop app at every start before the service: the first time it creates the
 * Platform Instance identity and records the verification; afterwards it only re-verifies after an update
 * (another platform version) or a failed run. Writes installation-report.json beside the record.
 */
export async function runSmartInstaller(
  config: NxGenConfig,
  options: SmartInstallerOptions = {},
): Promise<{ ran: boolean; report: InstallationReport | null }> {
  const storage = new SecureStorageService(config);
  const platform = new PlatformIdentityService(config, storage);
  const journal = new BootstrapJournal(config);

  const existing = platform.getInstallation();
  const { identity: current, intact } = platform.getIdentity();
  if (
    current &&
    intact &&
    existing &&
    platform.isInstallationVerified() &&
    existing.platformVersion === config.platformVersion &&
    existing.source !== 'DEV_SIMULATION'
  )
    return { ran: false, report: null };

  const checks: InstallationCheck[] = [];
  const check = async (
    id: string,
    label: string,
    fn: () => Promise<string | void> | string | void,
  ) => {
    try {
      const detail = await fn();
      checks.push({ id, label, status: 'PASS', ...(detail ? { detail } : {}) });
    } catch (err) {
      checks.push({ id, label, status: 'FAIL', detail: (err as Error).message });
    }
  };

  // Secure initialization: the identity is created once and never regenerated (a damaged one fails).
  let identity = current;
  await check('IDENTITY', 'Platform Instance identity', () => {
    if (current && !intact)
      throw new Error('The Platform Instance identity on this computer is damaged; it is never regenerated');
    if (!identity) {
      identity = platform.initializeIdentity();
      journal.record({
        category: 'PLATFORM',
        action: 'PLATFORM_IDENTITY_CREATED',
        result: 'SUCCESS',
        actor: 'SYSTEM_INSTALLER',
        platformInstanceId: identity.instanceId,
      });
      return `created ${identity.instanceId}`;
    }
    return identity.instanceId;
  });

  await check('DATA_FOLDER', 'Data folder writable', () => {
    mkdirSync(config.dataDir, { recursive: true });
    const probe = join(config.dataDir, `.write-${randomBytes(4).toString('hex')}`);
    writeFileSync(probe, 'ok');
    rmSync(probe);
    return config.dataDir;
  });

  const serviceDir = options.serviceDir ?? resolve(__dirname, '..', '..');
  await check('SERVICE_FILES', 'NxGen service files', () => {
    if (!existsSync(join(serviceDir, 'dist', 'main.js')))
      throw new Error(`dist/main.js missing in ${serviceDir}`);
    const migrations = readdirSync(join(serviceDir, 'dist', 'database', 'migrations')).filter((f) => f.endsWith('.sql'));
    if (migrations.length === 0) throw new Error('No database migrations found');
    return `${migrations.length} migrations`;
  });

  if (options.webDir)
    await check('SCREENS', 'NxGen screens', () => {
      if (!existsSync(join(options.webDir!, 'index.html')))
        throw new Error(`index.html missing in ${options.webDir}`);
    });

  await check('DATABASE', 'Database reachable', async () => {
    if (options.checkDatabase) return options.checkDatabase();
    if (!config.database) throw new Error('No database configured');
    const client = new Client({
      connectionString: config.database.connectionString,
      ssl: config.database.ssl,
      connectionTimeoutMillis: 15_000,
    });
    await client.connect();
    try {
      const { rows } = await client.query<{ v: string }>("SELECT current_setting('server_version') AS v");
      return `PostgreSQL ${rows[0].v}`;
    } finally {
      await client.end();
    }
  });

  if (config.trustedKeys.length === 0)
    checks.push({ id: 'LICENSE_KEYS', label: 'Trusted license-signing keys', status: 'FAIL', detail: 'none configured' });
  else checks.push({ id: 'LICENSE_KEYS', label: 'Trusted license-signing keys', status: 'PASS', detail: `${config.trustedKeys.length}` });

  const verification: InstallationVerification = checks.some((c) => c.status === 'FAIL')
    ? 'FAIL'
    : checks.some((c) => c.status === 'WARNING')
      ? 'PASS_WITH_WARNING'
      : 'PASS';
  const now = options.now ?? new Date();
  const installationId =
    existing?.installationId && !existing.installationId.includes('DEV')
      ? existing.installationId
      : `NXI-${now.getFullYear()}-${randomBytes(3).toString('hex').toUpperCase()}`;
  const report: InstallationReport = {
    installationId,
    verification,
    softwareVersion: config.platformVersion,
    machineName: hostname(),
    operatingSystem: `${osPlatform()} ${release()} ${arch()}`,
    installedAt: now.toISOString(),
    platformInstanceId: identity?.instanceId ?? null,
    checks,
  };

  // A failed verification is recorded too: activation stays closed until a later start passes.
  if (identity && checks.find((c) => c.id === 'IDENTITY')?.status === 'PASS')
    platform.recordInstallationVerification({
      installationId,
      verification,
      verifiedAt: verification === 'FAIL' ? null : now.toISOString(),
      platformVersion: config.platformVersion,
      source: 'SMART_INSTALLER',
    });
  mkdirSync(join(config.dataDir, 'platform'), { recursive: true });
  writeFileSync(join(config.dataDir, 'platform', 'installation-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  journal.record({
    category: 'PLATFORM',
    action: 'INSTALLATION_VERIFICATION_RECORDED',
    result: verification === 'FAIL' ? 'FAILURE' : 'SUCCESS',
    actor: 'SYSTEM_INSTALLER',
    platformInstanceId: identity?.instanceId ?? null,
    details: {
      installationId,
      verification,
      failed: checks.filter((c) => c.status === 'FAIL').map((c) => c.id).join(',') || null,
    },
  });
  return { ran: true, report };
}
