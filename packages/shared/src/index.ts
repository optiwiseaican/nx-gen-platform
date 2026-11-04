/**
 * Shared types used across the Compliance Core, server, web and desktop apps.
 */

export enum Role {
  SuperAdministrator = 'SUPER_ADMINISTRATOR',
  ITAdministrator = 'IT_ADMINISTRATOR',
  QAManager = 'QA_MANAGER',
  QAReviewer = 'QA_REVIEWER',
  Analyst = 'ANALYST',
  Operator = 'OPERATOR',
  Auditor = 'AUDITOR',
}

export enum DeploymentMode {
  Standalone = 'STANDALONE',
  ClientServer = 'CLIENT_SERVER',
}

export enum LicenseType {
  Device = 'DEVICE',
  NamedUser = 'NAMED_USER',
  ConcurrentUser = 'CONCURRENT_USER',
  Site = 'SITE',
  Subscription = 'SUBSCRIPTION',
  Perpetual = 'PERPETUAL',
}

export type AuditAction =
  | 'CREATE'
  | 'UPDATE'
  | 'DELETE'
  | 'LOGIN'
  | 'LOGOUT'
  | 'APPROVAL'
  | 'CONFIG_CHANGE'
  | 'LICENSE_EVENT'
  | 'DEVICE_EVENT'
  | 'BACKUP'
  | 'RESTORE'
  | 'STARTUP';

/** Audit trail entry (spec §6). Append-only; never updated or deleted. */
export interface AuditEntry {
  id: string;
  recordId: string;
  tableName: string;
  action: AuditAction;
  oldValue: unknown | null;
  newValue: unknown | null;
  userId: string;
  timestamp: string;
  machineName: string;
  ipAddress: string;
  reason: string | null;
}

/** Columns required on every master table (spec §8). */
export interface MasterRecordFields {
  createdBy: string;
  createdAt: string;
  modifiedBy: string | null;
  modifiedAt: string | null;
  versionNo: number;
  recordStatus: string;
  isDeleted: boolean;
  deletedBy: string | null;
  deletedAt: string | null;
}
