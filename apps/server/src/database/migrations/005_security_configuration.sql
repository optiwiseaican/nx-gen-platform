-- =============================================================================
-- NxGen Compliance Core — 005
-- Security configuration and administrator recovery.
--   * security_settings: password, lockout and session rules, editable by an
--     authorised administrator with a reason and an electronic signature.
--     The CHECK constraints are the validated limits: no change can weaken the
--     rules below them, whatever the application does.
--   * recovery_requests: support-assisted Super Administrator recovery,
--     completed only with a response signed by the vendor key.
-- =============================================================================

CREATE TABLE security_settings (
  id                     integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  password_min_length    integer NOT NULL CHECK (password_min_length BETWEEN 8 AND 64),
  password_history       integer NOT NULL CHECK (password_history BETWEEN 1 AND 24),
  password_max_age_days  integer NOT NULL CHECK (password_max_age_days BETWEEN 30 AND 365),
  max_failed_logins      integer NOT NULL CHECK (max_failed_logins BETWEEN 3 AND 10),
  lockout_minutes        integer NOT NULL CHECK (lockout_minutes BETWEEN 5 AND 1440),
  session_idle_minutes   integer NOT NULL CHECK (session_idle_minutes BETWEEN 5 AND 60),
  session_max_hours      integer NOT NULL CHECK (session_max_hours BETWEEN 1 AND 24),
  created_by    text NOT NULL, created_at timestamptz NOT NULL,
  modified_by   text, modified_at timestamptz,
  version_no    integer NOT NULL,
  record_status text NOT NULL DEFAULT 'ACTIVE',
  is_deleted    boolean NOT NULL DEFAULT false, deleted_by text, deleted_at timestamptz
);
CREATE TRIGGER security_settings_before BEFORE INSERT OR UPDATE OR DELETE ON security_settings FOR EACH ROW EXECUTE FUNCTION master_before_write();
CREATE TRIGGER security_settings_audit AFTER INSERT OR UPDATE ON security_settings FOR EACH ROW EXECUTE FUNCTION master_audit('id');

-- Values in force until now (previously fixed at installation).
INSERT INTO security_settings (password_min_length, password_history, password_max_age_days, max_failed_logins,
                               lockout_minutes, session_idle_minutes, session_max_hours)
VALUES (12, 5, 90, 5, 30, 15, 12);

INSERT INTO signature_policies (action_code, description, required, default_meaning, locked) VALUES
  ('SECURITY_POLICY_CHANGE', 'Change password, lockout and session rules', true, 'APPROVED', true);

UPDATE permissions SET description = 'Change security configuration: password, lockout and session rules, and electronic signature requirements'
 WHERE code = 'security.manage';

CREATE TABLE recovery_requests (
  id                uuid PRIMARY KEY,
  user_id           uuid REFERENCES users (id),
  username          text NOT NULL,
  nonce             text NOT NULL,
  contact_reason    text NOT NULL,
  request_status    text NOT NULL DEFAULT 'PENDING'
                      CHECK (request_status IN ('PENDING', 'COMPLETED', 'FAILED', 'SUPERSEDED')),
  expires_at        timestamptz NOT NULL,
  failed_attempts   integer NOT NULL DEFAULT 0,
  support_reference text,
  issued_by         text,
  signing_key_id    text,
  completed_at      timestamptz,
  created_by    text NOT NULL, created_at timestamptz NOT NULL,
  modified_by   text, modified_at timestamptz,
  version_no    integer NOT NULL,
  record_status text NOT NULL DEFAULT 'ACTIVE',
  is_deleted    boolean NOT NULL DEFAULT false, deleted_by text, deleted_at timestamptz
);
CREATE INDEX recovery_requests_pending_idx ON recovery_requests (username) WHERE request_status = 'PENDING';
CREATE TRIGGER recovery_requests_before BEFORE INSERT OR UPDATE OR DELETE ON recovery_requests FOR EACH ROW EXECUTE FUNCTION master_before_write();
CREATE TRIGGER recovery_requests_audit AFTER INSERT OR UPDATE ON recovery_requests FOR EACH ROW EXECUTE FUNCTION master_audit('id');
