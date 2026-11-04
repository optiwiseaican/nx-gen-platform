import { randomUUID } from 'crypto';

/**
 * Platform Instance identity (License PRD §7).
 *
 * `instanceUid` is a random UUID created once during secure initialization and
 * is what licenses are cryptographically bound to. `instanceId` is the short
 * human-readable form shown in the UI and support conversations
 * (e.g. NXG-PLT-63A7-94FC); it is derived from the UID so the two can never
 * drift apart.
 */
export interface PlatformIdentity {
  instanceUid: string;
  instanceId: string;
}

export const PLATFORM_INSTANCE_ID_PATTERN = /^NXG-PLT-[0-9A-F]{4}-[0-9A-F]{4}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function derivePlatformInstanceId(instanceUid: string): string {
  const hex = instanceUid.replace(/-/g, '').toUpperCase();
  return `NXG-PLT-${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
}

export function createPlatformIdentity(): PlatformIdentity {
  const instanceUid = randomUUID();
  return { instanceUid, instanceId: derivePlatformInstanceId(instanceUid) };
}

export function isValidPlatformIdentity(identity: PlatformIdentity | null | undefined): boolean {
  if (!identity) return false;
  return (
    UUID_PATTERN.test(identity.instanceUid) &&
    PLATFORM_INSTANCE_ID_PATTERN.test(identity.instanceId) &&
    derivePlatformInstanceId(identity.instanceUid) === identity.instanceId
  );
}
