import {
  ActivationRequest,
  issueLicense,
  LicenseErrorCode,
  parseActivationCode,
  parseActivationRequest,
  serializeLicenseFile,
} from '@crescent/licensing';
import { PortalStore } from './store';

/** A refusal the NxGen client shows with its catalogue message (errorCode) — never a stack trace. */
export class PortalRefusal extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: LicenseErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ActivateInput {
  activationCode: string;
  /** The activation request: object, .nxreq JSON text or NXR1 code. */
  request: unknown;
  channel: 'ONLINE' | 'OFFLINE';
  clientIp?: string | null;
}

/**
 * Issues a signed licence bound to the requesting computer (master specification §11, steps 5–8).
 * The same computer (Platform Instance) asking again gets a fresh licence without using another slot,
 * e.g. after a hardware repair; a new computer uses a slot until the key's device limit is reached.
 */
export async function activate(
  store: PortalStore,
  privateKeyPem: string,
  input: ActivateInput,
  now = new Date(),
): Promise<{ licenseText: string; licenseId: string; fileName: string }> {
  const parsedCode = parseActivationCode(typeof input.activationCode === 'string' ? input.activationCode : '');
  if (!parsedCode.valid)
    throw new PortalRefusal(400, LicenseErrorCode.KEY_NOT_RECOGNISED, 'The activation key is not in the NXG-XXXX-XXXX-XXXX format.');
  const code = parsedCode.code;

  let request: ActivationRequest;
  try {
    request = typeof input.request === 'string' ? parseActivationRequest(input.request) : parseActivationRequest(JSON.stringify(input.request));
  } catch {
    throw new PortalRefusal(400, LicenseErrorCode.UNSUPPORTED_FORMAT, 'The activation request could not be read.');
  }

  return store.withLockedKey(code, async (key, tx) => {
    if (!key || key.revokedAt) throw new PortalRefusal(404, LicenseErrorCode.KEY_NOT_RECOGNISED, 'Unknown or withdrawn activation key.');
    if (key.expiresAt && key.expiresAt.getTime() <= now.getTime())
      throw new PortalRefusal(410, LicenseErrorCode.LICENSE_EXPIRED, 'This activation key has expired.');

    const computers = await tx.computers();
    const known = computers.includes(request.platform.instanceUid);
    if (!known && computers.length >= key.deviceLimit)
      throw new PortalRefusal(409, LicenseErrorCode.KEY_DEVICE_LIMIT, `Key already used on ${computers.length} of ${key.deviceLimit} computer(s).`);

    let license;
    try {
      license = issueLicense({
        request,
        privateKeyPem,
        customer: { id: key.customerId, name: key.customerName, ...(key.site ? { site: key.site } : {}) },
        licenseType: key.licenseType,
        expiresAt: key.expiresAt,
        modules: key.modules.map((id) => ({ id, expiresAt: key.expiresAt ? key.expiresAt.toISOString() : null })),
        limits: { users: key.userLimit, devices: key.instrumentLimit },
        activationCode: code,
        now,
      });
    } catch (err) {
      // e.g. too few stable hardware identifiers in the request.
      throw new PortalRefusal(422, LicenseErrorCode.UNSUPPORTED_FORMAT, (err as Error).message);
    }
    const licenseText = serializeLicenseFile(license);
    await tx.record({
      instanceUid: request.platform.instanceUid,
      instanceId: request.platform.instanceId,
      requestId: request.requestId,
      licenseId: license.payload.licenseId,
      licenseText,
      channel: input.channel,
      clientIp: input.clientIp ?? null,
    });
    return { licenseText, licenseId: license.payload.licenseId, fileName: `${request.platform.instanceId}.nxlic` };
  });
}
