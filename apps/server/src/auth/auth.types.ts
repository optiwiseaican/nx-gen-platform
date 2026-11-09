import { hostname } from 'os';
import type { Request } from 'express';

/** The authenticated user attached to a request. */
export interface Principal {
  userId: string;
  username: string;
  fullName: string;
  roles: string[];
  permissions: string[];
  mustChangePassword: boolean;
  passwordExpiresAt: string | null;
  sessionId: string;
  /** When this session ends: after inactivity, and at the latest. */
  session?: { idleExpiresAt: string; expiresAt: string };
  /** Inactivity sign-out in force for this account (its own setting or the system's). */
  sessionIdleMinutes?: number;
}

/** Response headers that tell the client when its session ends. */
export const SESSION_IDLE_HEADER = 'X-NxGen-Session-Idle-Expires';
export const SESSION_MAX_HEADER = 'X-NxGen-Session-Expires';
/** Server clock at response time, so clients can correct for their own clock. */
export const SERVER_TIME_HEADER = 'X-NxGen-Server-Time';

/** Where a request came from — recorded on every audit event. */
export interface RequestOrigin {
  ipAddress: string | null;
  machineName: string;
  userAgent: string | null;
}

export type NxGenRequest = Request & { principal?: Principal };

export function originOf(req: Request): RequestOrigin {
  return {
    ipAddress: req.ip ?? req.socket?.remoteAddress ?? null,
    // Standalone deployment: the client workstation is the server host.
    machineName: hostname(),
    userAgent: (req.headers['user-agent'] ?? '').slice(0, 300) || null,
  };
}

export const SESSION_COOKIE = 'nxgen_session';

export function readSessionCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export const SETUP_ACTOR = 'SYSTEM_SETUP';
