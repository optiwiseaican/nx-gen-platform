-- =============================================================================
-- NxGen Compliance Core — 010
-- Per-user session timing. An administrator may give one account its own
-- inactivity sign-out and maximum session length (for example a shared
-- shop-floor terminal account with a shorter timeout). NULL means "use the
-- system security settings". The same validated limits as security_settings
-- apply, so no account can be configured outside them.
-- =============================================================================

ALTER TABLE users
  ADD COLUMN session_idle_minutes integer CHECK (session_idle_minutes IS NULL OR session_idle_minutes BETWEEN 5 AND 60),
  ADD COLUMN session_max_hours    integer CHECK (session_max_hours IS NULL OR session_max_hours BETWEEN 1 AND 24);

INSERT INTO signature_policies (action_code, description, required, default_meaning, locked) VALUES
  ('USER_SESSION_CHANGE', 'Change a user''s session timing (inactivity sign-out, maximum session)', true, 'APPROVED', false);
