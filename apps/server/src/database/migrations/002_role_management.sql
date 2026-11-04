-- =============================================================================
-- NxGen Compliance Core — 002
-- Role administration permission. (001 is immutable once applied; changes to
-- the validated schema always arrive as a new migration.)
-- =============================================================================

INSERT INTO permissions (code, description) VALUES
  ('roles.manage', 'Create roles and change which permissions a role grants');

INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('SUPER_ADMINISTRATOR', 'roles.manage');

UPDATE permissions SET description = 'Create users, edit profiles, assign roles, disable/enable, unlock and reset passwords'
 WHERE code = 'users.manage';

-- Lookup used by the user history view.
CREATE INDEX audit_trail_record_prefix_idx ON audit_trail (record_id text_pattern_ops);
