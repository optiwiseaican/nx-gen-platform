export * from './canonical-json';
export * from './activation-code';
export * from './errors';
export * from './platform-identity';
export * from './fingerprint';
export * from './keys';
export * from './schema';
export * from './request';
export * from './issue';
export * from './verify';
export * from './recovery';

/** Internal license states (License PRD §31) plus EXPIRED for runtime. */
export const LicenseState = {
  NOT_ACTIVATED: 'NOT_ACTIVATED',
  ACTIVATING: 'ACTIVATING',
  ACTIVE: 'ACTIVE',
  ACTIVATION_ERROR: 'ACTIVATION_ERROR',
  REACTIVATION_REQUIRED: 'REACTIVATION_REQUIRED',
  EXPIRED: 'EXPIRED',
} as const;
export type LicenseState = (typeof LicenseState)[keyof typeof LicenseState];
