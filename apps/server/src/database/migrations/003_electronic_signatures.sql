-- =============================================================================
-- NxGen Compliance Core — 003
-- Electronic signatures (master spec §7; 21 CFR 11.50, 11.70, 11.100, 11.200, 11.300).
-- =============================================================================

-- Meanings (11.50(a)(3)): what the signer asserts by signing.
CREATE TABLE signature_meanings (
  code          text PRIMARY KEY CHECK (code ~ '^[A-Z][A-Z_]{1,40}$'),
  label         text NOT NULL,
  statement     text NOT NULL,
  created_by    text NOT NULL, created_at timestamptz NOT NULL,
  modified_by   text, modified_at timestamptz,
  version_no    integer NOT NULL,
  record_status text NOT NULL DEFAULT 'ACTIVE',
  is_deleted    boolean NOT NULL DEFAULT false, deleted_by text, deleted_at timestamptz
);

-- Which actions require a signature. `locked` rows can never be made optional.
CREATE TABLE signature_policies (
  action_code     text PRIMARY KEY CHECK (action_code ~ '^[A-Z][A-Z_]{1,60}$'),
  description     text NOT NULL,
  required        boolean NOT NULL,
  default_meaning text NOT NULL REFERENCES signature_meanings (code),
  locked          boolean NOT NULL DEFAULT false,
  created_by    text NOT NULL, created_at timestamptz NOT NULL,
  modified_by   text, modified_at timestamptz,
  version_no    integer NOT NULL,
  record_status text NOT NULL DEFAULT 'ACTIVE',
  is_deleted    boolean NOT NULL DEFAULT false, deleted_by text, deleted_at timestamptz,
  CHECK (NOT locked OR required)
);

CREATE TRIGGER signature_meanings_before BEFORE INSERT OR UPDATE OR DELETE ON signature_meanings FOR EACH ROW EXECUTE FUNCTION master_before_write();
CREATE TRIGGER signature_meanings_audit AFTER INSERT OR UPDATE ON signature_meanings FOR EACH ROW EXECUTE FUNCTION master_audit('code');
CREATE TRIGGER signature_policies_before BEFORE INSERT OR UPDATE OR DELETE ON signature_policies FOR EACH ROW EXECUTE FUNCTION master_before_write();
CREATE TRIGGER signature_policies_audit AFTER INSERT OR UPDATE ON signature_policies FOR EACH ROW EXECUTE FUNCTION master_audit('action_code');

-- ---------------------------------------------------------------------------
-- The signatures themselves. Append-only. Each row carries:
--   * the manifestation (printed name, date/time, meaning)        11.50
--   * exactly what was signed (signed_content) and its hash        11.70
--   * a signature hash over all of the above, so any later change
--     (even by a privileged user bypassing triggers) is detectable 11.70
-- ---------------------------------------------------------------------------
CREATE TABLE electronic_signatures (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signed_at            timestamptz NOT NULL,
  signer_user_id       uuid NOT NULL REFERENCES users (id),
  signer_username      text NOT NULL,
  signer_full_name     text NOT NULL,
  meaning_code         text NOT NULL REFERENCES signature_meanings (code),
  meaning_label        text NOT NULL,
  meaning_statement    text NOT NULL,
  reason               text NOT NULL,
  action_code          text NOT NULL,
  table_name           text NOT NULL,
  record_id            text NOT NULL,
  record_version       integer,
  signed_content       jsonb NOT NULL,
  content_hash         text NOT NULL,
  session_id           uuid,
  ip_address           text,
  machine_name         text,
  platform_instance_id text,
  signature_hash       text NOT NULL UNIQUE
);
CREATE INDEX electronic_signatures_record_idx ON electronic_signatures (table_name, record_id);
CREATE INDEX electronic_signatures_signer_idx ON electronic_signatures (signer_user_id);

CREATE FUNCTION signature_hash(s electronic_signatures) RETURNS text
LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT encode(sha256(convert_to(concat_ws(E'\x1f',
    s.id::text,
    to_char(s.signed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    s.signer_user_id::text, s.signer_username, s.signer_full_name,
    s.meaning_code, s.meaning_label, s.meaning_statement, s.reason,
    s.action_code, s.table_name, s.record_id, coalesce(s.record_version::text, ''),
    s.content_hash, coalesce(s.session_id::text, ''), coalesce(s.ip_address, ''),
    coalesce(s.machine_name, ''), coalesce(s.platform_instance_id, '')
  ), 'UTF8')), 'hex')
$$;

CREATE FUNCTION electronic_signature_seal() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  NEW.id := coalesce(NEW.id, gen_random_uuid());
  NEW.signed_at := date_trunc('microseconds', clock_timestamp());
  NEW.content_hash := encode(sha256(convert_to(NEW.signed_content::text, 'UTF8')), 'hex');
  NEW.signature_hash := signature_hash(NEW);
  RETURN NEW;
END $$;

CREATE FUNCTION electronic_signature_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'NXGEN-ESIG-001: electronic signatures cannot be modified, deleted or transferred'
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER electronic_signatures_seal BEFORE INSERT ON electronic_signatures
  FOR EACH ROW EXECUTE FUNCTION electronic_signature_seal();
CREATE TRIGGER electronic_signatures_no_update BEFORE UPDATE OR DELETE ON electronic_signatures
  FOR EACH ROW EXECUTE FUNCTION electronic_signature_immutable();
CREATE TRIGGER electronic_signatures_no_truncate BEFORE TRUNCATE ON electronic_signatures
  FOR EACH STATEMENT EXECUTE FUNCTION electronic_signature_immutable();

-- True when the stored hashes still match the stored content.
CREATE FUNCTION verify_signature(s electronic_signatures) RETURNS boolean
LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT s.content_hash = encode(sha256(convert_to(s.signed_content::text, 'UTF8')), 'hex')
     AND s.signature_hash = signature_hash(s)
$$;

-- ---------------------------------------------------------------------------
-- Seeds
-- ---------------------------------------------------------------------------
INSERT INTO signature_meanings (code, label, statement) VALUES
  ('APPROVED',    'Approved',    'I approve this record or change.'),
  ('REVIEWED',    'Reviewed',    'I have reviewed this record or change.'),
  ('AUTHORED',    'Authored',    'I am the author of this record or change.'),
  ('VERIFIED',    'Verified',    'I have verified that this record or change is correct.'),
  ('RESPONSIBLE', 'Responsible', 'I take responsibility for this action.');

INSERT INTO signature_policies (action_code, description, required, default_meaning, locked) VALUES
  ('USER_CREATE',             'Create a user account',                   true,  'APPROVED',    false),
  ('USER_PROFILE_UPDATE',     'Edit a user''s name or email',            false, 'RESPONSIBLE', false),
  ('USER_ROLES_CHANGE',       'Change a user''s roles',                  true,  'APPROVED',    false),
  ('USER_DISABLE',            'Disable a user account',                  true,  'RESPONSIBLE', false),
  ('USER_ENABLE',             'Enable a user account',                   true,  'APPROVED',    false),
  ('USER_UNLOCK',             'Unlock a locked account',                 false, 'RESPONSIBLE', false),
  ('USER_PASSWORD_RESET',     'Reset a user''s password',                true,  'RESPONSIBLE', false),
  ('ROLE_CREATE',             'Create a role',                           true,  'APPROVED',    false),
  ('ROLE_PERMISSIONS_CHANGE', 'Change the permissions a role grants',    true,  'APPROVED',    false),
  ('SIGNATURE_POLICY_CHANGE', 'Change which actions require a signature', true, 'APPROVED',    true);

INSERT INTO permissions (code, description) VALUES
  ('security.manage', 'Change security configuration, including electronic signature requirements');
INSERT INTO role_permissions (role_code, permission_code) VALUES ('SUPER_ADMINISTRATOR', 'security.manage');
