/**
 * License error catalogue.
 *
 * E001–E010 come from the License & Activation PRD V3.0 §33.
 * E011–E015 are extensions needed for conditions the PRD describes but does not
 * number (hardware change §41, version scope §22, pre-activation gate §9/§16,
 * code/package mismatch §14, platform identity integrity §19 step 2).
 * E016–E018 cover online activation through the AICAN License Portal (master
 * specification §11): portal unreachable, key not recognised, key used up.
 *
 * Messages follow PRD §34: what happened, whether data is safe, what to do.
 * They must never contain cryptographic detail or stack traces.
 */
export const LicenseErrorCode = {
  LICENSE_NOT_FOUND: 'NX-LIC-E001',
  PLATFORM_ENTITLEMENT_MISSING: 'NX-LIC-E002',
  LICENSE_INACTIVE: 'NX-LIC-E003',
  LICENSE_EXPIRED: 'NX-LIC-E004',
  INVALID_SIGNATURE: 'NX-LIC-E005',
  WRONG_PLATFORM_INSTANCE: 'NX-LIC-E006',
  UNSUPPORTED_FORMAT: 'NX-LIC-E007',
  PACKAGE_CORRUPTED: 'NX-LIC-E008',
  TIME_INTEGRITY: 'NX-LIC-E009',
  SERVICE_UNAVAILABLE: 'NX-LIC-E010',
  HARDWARE_CHANGED: 'NX-LIC-E011',
  VERSION_NOT_COVERED: 'NX-LIC-E012',
  INSTALLATION_NOT_VERIFIED: 'NX-LIC-E013',
  CODE_MISMATCH: 'NX-LIC-E014',
  PLATFORM_IDENTITY_INVALID: 'NX-LIC-E015',
  PORTAL_UNREACHABLE: 'NX-LIC-E016',
  KEY_NOT_RECOGNISED: 'NX-LIC-E017',
  KEY_DEVICE_LIMIT: 'NX-LIC-E018',
} as const;

export type LicenseErrorCode = (typeof LicenseErrorCode)[keyof typeof LicenseErrorCode];

export interface LicenseErrorInfo {
  title: string;
  message: string;
  action: string;
}

const DATA_SAFE = 'No laboratory data has been changed.';

export const LICENSE_ERRORS: Record<LicenseErrorCode, LicenseErrorInfo> = {
  'NX-LIC-E001': {
    title: 'License Package Required',
    message: 'The signed NxGen license package for this activation code could not be found.',
    action: 'Select the license file supplied for this platform, or contact your NxGen Administrator.',
  },
  'NX-LIC-E002': {
    title: 'Platform Entitlement Missing',
    message: `This license does not include the NxGen Platform entitlement. ${DATA_SAFE}`,
    action: 'Contact your NxGen Administrator.',
  },
  'NX-LIC-E003': {
    title: 'License Not Yet Active',
    message: `This license is not valid yet. ${DATA_SAFE}`,
    action: 'Check the system date, or contact your NxGen Administrator.',
  },
  'NX-LIC-E004': {
    title: 'License Expired',
    message: `This NxGen license has expired. ${DATA_SAFE}`,
    action: 'Contact your NxGen Administrator to renew the license.',
  },
  'NX-LIC-E005': {
    title: 'License Signature Invalid',
    message: `NxGen could not verify this license. The file may have been modified. ${DATA_SAFE}`,
    action: 'Use the original license file, or contact your NxGen Administrator.',
  },
  'NX-LIC-E006': {
    title: 'License Not Valid for This Platform',
    message: `This NxGen license is assigned to another Platform Instance. ${DATA_SAFE}`,
    action: 'Contact your NxGen Administrator.',
  },
  'NX-LIC-E007': {
    title: 'Unsupported License Format',
    message: `This license file is not in a format supported by this NxGen version. ${DATA_SAFE}`,
    action: 'Contact your NxGen Administrator for a compatible license file.',
  },
  'NX-LIC-E008': {
    title: 'License Package Damaged',
    message: `The license file could not be read. It may be incomplete or damaged. ${DATA_SAFE}`,
    action: 'Copy the original license file again, or contact your NxGen Administrator.',
  },
  'NX-LIC-E009': {
    title: 'License Time Integrity Warning',
    message: `The system clock appears to have been moved backwards. ${DATA_SAFE}`,
    action: 'Correct the system date and time, then try again.',
  },
  'NX-LIC-E010': {
    title: 'License Service Unavailable',
    message: `The NxGen License Service could not complete the request. ${DATA_SAFE}`,
    action: 'Restart NxGen. If the problem continues, contact NxGen Support.',
  },
  'NX-LIC-E011': {
    title: 'Reactivation Required',
    message: `This computer's hardware has changed significantly since activation. ${DATA_SAFE}`,
    action: 'Contact your NxGen Administrator to reactivate this platform.',
  },
  'NX-LIC-E012': {
    title: 'License Does Not Cover This Version',
    message: `This license does not cover the installed NxGen Platform version. ${DATA_SAFE}`,
    action: 'Contact your NxGen Administrator.',
  },
  'NX-LIC-E013': {
    title: 'Installation Not Verified',
    message: 'Activation cannot continue because NxGen installation verification has not passed.',
    action: 'Complete installation verification using the NxGen Smart Installer.',
  },
  'NX-LIC-E014': {
    title: 'Activation Code Does Not Match',
    message: 'The activation code does not match the selected license file.',
    action: 'Check the activation code and license file, then try again.',
  },
  'NX-LIC-E015': {
    title: 'Platform Identity Invalid',
    message: `The NxGen Platform identity on this computer could not be verified. ${DATA_SAFE}`,
    action: 'Contact NxGen Support. A repair installation may be required.',
  },
  'NX-LIC-E016': {
    title: 'License Portal Not Reachable',
    message: `NxGen could not reach the AICAN License Portal to activate this computer. ${DATA_SAFE}`,
    action:
      'Check the internet connection and try again, or activate offline: save the activation request, ' +
      'upload it on the AICAN License Portal from any computer, then select the license file you receive.',
  },
  'NX-LIC-E017': {
    title: 'Activation Key Not Recognised',
    message: `The AICAN License Portal does not recognise this activation key, or it has been withdrawn. ${DATA_SAFE}`,
    action: 'Check the key exactly as supplied, or contact AICAN.',
  },
  'NX-LIC-E018': {
    title: 'Activation Key Already Used',
    message: `This activation key has already been used on the number of computers it allows. ${DATA_SAFE}`,
    action: 'Contact AICAN for an additional key or to move the license to this computer.',
  },
};
