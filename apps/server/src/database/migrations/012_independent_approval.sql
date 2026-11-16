-- =============================================================================
-- NxGen Security — 012
-- Whether the person who prepared (or reviewed) a record may also review or
-- approve it. On by default (independent review and approval, as GMP expects);
-- a site may switch it off with a signed security-policy change, as the TLC
-- tablet's "separate reviewer" setting allows. Workflow definitions keep their
-- own independent_* flags; this policy applies on top of them.
-- =============================================================================

ALTER TABLE security_settings
  ADD COLUMN independent_approval boolean NOT NULL DEFAULT true;
