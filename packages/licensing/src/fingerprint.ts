import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { networkInterfaces, cpus, platform } from 'os';
import { readFile } from 'fs/promises';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Machine fingerprint (License PRD §8, §41).
 *
 * The fingerprint is a SECONDARY binding; the Platform Instance ID is primary.
 * It is built from several components with weights so that a single changed
 * part (RAM, extra disk, NIC) does not invalidate the license, while a
 * motherboard replacement (which changes systemUuid, baseboardSerial and
 * usually the onboard MAC) does.
 *
 * Only salted SHA-256 hashes of each component ever leave this module, so the
 * request file and license never contain raw serial numbers.
 */
export const FINGERPRINT_ALGORITHM = 'NXFP-1';

export const FINGERPRINT_COMPONENTS = [
  'systemUuid',
  'baseboardSerial',
  'osInstallId',
  'systemDiskSerial',
  'cpuModel',
  'primaryMac',
] as const;

export type FingerprintComponent = (typeof FINGERPRINT_COMPONENTS)[number];

export const COMPONENT_WEIGHTS: Record<FingerprintComponent, number> = {
  systemUuid: 3,
  baseboardSerial: 3,
  osInstallId: 2,
  systemDiskSerial: 2,
  cpuModel: 1,
  primaryMac: 1,
};

/** Default share of bound weight that must still match. */
export const DEFAULT_MATCH_THRESHOLD = 0.6;
/** Minimum total weight a request must carry for a license to be issued. */
export const MIN_BINDING_WEIGHT = 4;

export type RawFingerprint = Partial<Record<FingerprintComponent, string | null | undefined>>;
export type HashedFingerprint = Partial<Record<FingerprintComponent, string>>;

/** Placeholder values firmware vendors leave in SMBIOS fields. */
const JUNK_VALUES = new Set([
  '',
  '0',
  'NONE',
  'N/A',
  'NA',
  'DEFAULT STRING',
  'TO BE FILLED BY O.E.M.',
  'SYSTEM SERIAL NUMBER',
  'BASE BOARD SERIAL NUMBER',
  'NOT APPLICABLE',
  'NOT SPECIFIED',
  'INVALID',
  '00000000-0000-0000-0000-000000000000',
  'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF',
  '03000200-0400-0500-0006-000700080009',
  '00:00:00:00:00:00',
]);

export function normalizeComponent(value: string | null | undefined): string | null {
  if (value == null) return null;
  const normalized = value.trim().replace(/\s+/g, ' ').toUpperCase();
  if (JUNK_VALUES.has(normalized) || /^[0.\-: ]+$/.test(normalized)) return null;
  return normalized;
}

export function hashFingerprint(raw: RawFingerprint): HashedFingerprint {
  const hashed: HashedFingerprint = {};
  for (const name of FINGERPRINT_COMPONENTS) {
    const value = normalizeComponent(raw[name]);
    if (value) {
      hashed[name] = createHash('sha256').update(`${FINGERPRINT_ALGORITHM}|${name}|${value}`).digest('hex');
    }
  }
  return hashed;
}

export function bindingWeight(fp: HashedFingerprint): number {
  return FINGERPRINT_COMPONENTS.reduce((sum, name) => sum + (fp[name] ? COMPONENT_WEIGHTS[name] : 0), 0);
}

export interface FingerprintMatch {
  pass: boolean;
  score: number;
  matched: FingerprintComponent[];
  changed: FingerprintComponent[];
  missing: FingerprintComponent[];
}

export function matchFingerprint(
  bound: HashedFingerprint,
  current: HashedFingerprint,
  threshold: number = DEFAULT_MATCH_THRESHOLD,
): FingerprintMatch {
  const matched: FingerprintComponent[] = [];
  const changed: FingerprintComponent[] = [];
  const missing: FingerprintComponent[] = [];
  let boundWeight = 0;
  let matchedWeight = 0;

  for (const name of FINGERPRINT_COMPONENTS) {
    const expected = bound[name];
    if (!expected) continue;
    boundWeight += COMPONENT_WEIGHTS[name];
    const actual = current[name];
    if (!actual) missing.push(name);
    else if (actual === expected) {
      matched.push(name);
      matchedWeight += COMPONENT_WEIGHTS[name];
    } else changed.push(name);
  }

  const score = boundWeight === 0 ? 0 : matchedWeight / boundWeight;
  return { pass: boundWeight > 0 && score >= threshold, score, matched, changed, missing };
}

// ---------------------------------------------------------------------------
// Collection (best effort; every probe may fail and simply yields no value)
// ---------------------------------------------------------------------------

async function run(file: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(file, args, { timeout: 8000, windowsHide: true });
    return stdout;
  } catch {
    return '';
  }
}

const VIRTUAL_NIC = /vEthernet|virtual|vmware|vbox|hyper-v|docker|veth|bridge|utun|awdl|llw|tun|tap|loopback|zerotier|tailscale|wireguard/i;

function primaryMac(): string | null {
  const macs = Object.entries(networkInterfaces())
    .filter(([name]) => !VIRTUAL_NIC.test(name))
    .flatMap(([, addrs]) => addrs ?? [])
    .filter((a) => !a.internal && a.mac && a.mac !== '00:00:00:00:00:00')
    .map((a) => a.mac.toUpperCase());
  return [...new Set(macs)].sort()[0] ?? null;
}

async function collectWindows(): Promise<RawFingerprint> {
  const script = [
    '$ErrorActionPreference="SilentlyContinue"',
    '$csp=Get-CimInstance Win32_ComputerSystemProduct',
    '$bb=Get-CimInstance Win32_BaseBoard',
    '$guid=(Get-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Cryptography").MachineGuid',
    '$disk=(Get-Partition -DriveLetter $env:SystemDrive.Substring(0,1) | Get-Disk).SerialNumber',
    '[pscustomobject]@{systemUuid=$csp.UUID;baseboardSerial=$bb.SerialNumber;osInstallId=$guid;systemDiskSerial=$disk} | ConvertTo-Json -Compress',
  ].join(';');
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  try {
    return JSON.parse(out) as RawFingerprint;
  } catch {
    return {};
  }
}

async function collectMac(): Promise<RawFingerprint> {
  const out = await run('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
  const field = (key: string) => out.match(new RegExp(`"${key}" = "([^"]+)"`))?.[1] ?? null;
  return { systemUuid: field('IOPlatformUUID'), baseboardSerial: field('IOPlatformSerialNumber') };
}

async function collectLinux(): Promise<RawFingerprint> {
  const read = (p: string) => readFile(p, 'utf8').then((s) => s.trim()).catch(() => null);
  return {
    systemUuid: await read('/sys/class/dmi/id/product_uuid'),
    baseboardSerial: await read('/sys/class/dmi/id/board_serial'),
    osInstallId: await read('/etc/machine-id'),
  };
}

export async function collectRawFingerprint(): Promise<RawFingerprint> {
  const os = platform();
  const specific =
    os === 'win32' ? await collectWindows() : os === 'darwin' ? await collectMac() : await collectLinux();
  return {
    ...specific,
    cpuModel: cpus()[0]?.model ?? null,
    primaryMac: primaryMac(),
  };
}

export async function collectFingerprint(): Promise<HashedFingerprint> {
  return hashFingerprint(await collectRawFingerprint());
}
