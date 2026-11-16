import type { SecurityPolicy } from '../config/nxgen.config';
import { DatabaseService } from '../database/database.service';

/** Column for each policy field in security_settings (migration 005). */
export const COLUMNS: Record<keyof SecurityPolicy, string> = {
  passwordMinLength: 'password_min_length',
  passwordHistory: 'password_history',
  passwordMaxAgeDays: 'password_max_age_days',
  maxFailedLogins: 'max_failed_logins',
  lockoutMinutes: 'lockout_minutes',
  sessionIdleMinutes: 'session_idle_minutes',
  sessionMaxHours: 'session_max_hours',
  independentApproval: 'independent_approval',
};

export const POLICY_LABELS: Record<keyof SecurityPolicy, string> = {
  passwordMinLength: 'Minimum password length',
  passwordHistory: 'Password history',
  passwordMaxAgeDays: 'Password expiry (days)',
  maxFailedLogins: 'Failed attempts before lockout',
  lockoutMinutes: 'Lockout duration (minutes)',
  sessionIdleMinutes: 'Inactivity sign-out (minutes)',
  sessionMaxHours: 'Maximum session (hours)',
  independentApproval: 'Independent review and approval',
};

export const KEYS = Object.keys(COLUMNS) as (keyof SecurityPolicy)[];

export interface SettingsRow {
  password_min_length: number;
  password_history: number;
  password_max_age_days: number;
  max_failed_logins: number;
  lockout_minutes: number;
  session_idle_minutes: number;
  session_max_hours: number;
  independent_approval: boolean;
  version_no: number;
  modified_by: string | null;
  modified_at: Date | null;
}

/** Reads the policy in force from security_settings (migration 005). */
export async function readSecurityPolicy(db: DatabaseService): Promise<{
  policy: SecurityPolicy;
  version: number;
  modifiedBy: string | null;
  modifiedAt: string | null;
} | null> {
  const [r] = await db.query<SettingsRow & Record<string, unknown>>(
    'SELECT * FROM security_settings WHERE id = 1',
  );
  if (!r) return null;
  const policy = Object.fromEntries(
    KEYS.map((k) => [k, r[COLUMNS[k] as keyof SettingsRow]]),
  ) as unknown as SecurityPolicy;
  return {
    policy,
    version: r.version_no,
    modifiedBy: r.modified_by,
    modifiedAt: r.modified_at?.toISOString() ?? null,
  };
}
