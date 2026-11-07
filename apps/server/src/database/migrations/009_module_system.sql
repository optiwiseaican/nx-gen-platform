-- =============================================================================
-- NxGen Core — 009
-- Module system (Technical Architecture §3–§6, Option B): signed .nxmod
-- packages installed into the core, each owning its own prefixed tables.
-- =============================================================================

CREATE TABLE installed_modules (
  module_id        text PRIMARY KEY CHECK (module_id ~ '^[a-z][a-z0-9-]{1,31}$'),
  name             text NOT NULL,
  version          text NOT NULL,
  previous_version text,
  module_status    text NOT NULL DEFAULT 'ENABLED' CHECK (module_status IN ('ENABLED', 'DISABLED')),
  manifest         jsonb NOT NULL,
  file_hashes      jsonb NOT NULL,
  package_sha256   text NOT NULL,
  signing_key_id   text NOT NULL,
  install_path     text NOT NULL,
  created_by    text NOT NULL, created_at timestamptz NOT NULL,
  modified_by   text, modified_at timestamptz,
  version_no    integer NOT NULL,
  record_status text NOT NULL DEFAULT 'ACTIVE',
  is_deleted    boolean NOT NULL DEFAULT false, deleted_by text, deleted_at timestamptz
);
CREATE TRIGGER installed_modules_before BEFORE INSERT OR UPDATE OR DELETE ON installed_modules FOR EACH ROW EXECUTE FUNCTION master_before_write();
CREATE TRIGGER installed_modules_audit AFTER INSERT OR UPDATE ON installed_modules FOR EACH ROW EXECUTE FUNCTION master_audit('module_id');

-- Module migrations, checksum-locked like the core's.
CREATE TABLE module_migrations (
  module_id    text NOT NULL REFERENCES installed_modules (module_id),
  filename     text NOT NULL,
  checksum     text NOT NULL,
  module_version text NOT NULL,
  applied_at   timestamptz NOT NULL DEFAULT now(),
  applied_by   text NOT NULL,
  PRIMARY KEY (module_id, filename)
);
CREATE FUNCTION module_migrations_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'NXGEN-MOD-001: module migration history is append-only'
    USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER module_migrations_no_update BEFORE UPDATE OR DELETE ON module_migrations
  FOR EACH ROW EXECUTE FUNCTION module_migrations_immutable();

-- Instrument types. The core knows the catalogue; a type is usable only when
-- the module that provides it is installed, enabled and licensed.
CREATE TABLE instrument_types (
  code          text PRIMARY KEY CHECK (code ~ '^[A-Z][A-Z0-9_]{1,15}$'),
  label         text NOT NULL,
  module_id     text,
  created_by    text NOT NULL, created_at timestamptz NOT NULL,
  modified_by   text, modified_at timestamptz,
  version_no    integer NOT NULL,
  record_status text NOT NULL DEFAULT 'ACTIVE',
  is_deleted    boolean NOT NULL DEFAULT false, deleted_by text, deleted_at timestamptz
);
CREATE TRIGGER instrument_types_before BEFORE INSERT OR UPDATE OR DELETE ON instrument_types FOR EACH ROW EXECUTE FUNCTION master_before_write();
CREATE TRIGGER instrument_types_audit AFTER INSERT OR UPDATE ON instrument_types FOR EACH ROW EXECUTE FUNCTION master_audit('code');

INSERT INTO instrument_types (code, label, module_id) VALUES
  ('OTHER', 'Other instrument (checklist calibration)', NULL),
  ('PH',    'pH meter',            'ph'),
  ('EC',    'Conductivity meter',  'ec'),
  ('TLC',   'TLC scanner',         'tlc');

ALTER TABLE devices DROP CONSTRAINT devices_instrument_type_check;
ALTER TABLE devices ADD CONSTRAINT devices_instrument_type_fk FOREIGN KEY (instrument_type) REFERENCES instrument_types (code);

-- Calibrations recorded by a module carry a display summary chosen by the module.
ALTER TABLE calibration_records ADD COLUMN display jsonb NOT NULL DEFAULT '[]'::jsonb;

INSERT INTO permissions (code, description) VALUES
  ('modules.manage', 'Install, enable and disable NxGen modules (signed)');
INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('SUPER_ADMINISTRATOR', 'modules.manage'),
  ('IT_ADMINISTRATOR',    'modules.manage');

INSERT INTO signature_policies (action_code, description, required, default_meaning, locked) VALUES
  ('MODULE_INSTALL', 'Install or upgrade a module',  true, 'APPROVED',    true),
  ('MODULE_DISABLE', 'Disable a module',             true, 'RESPONSIBLE', false),
  ('MODULE_ENABLE',  'Enable a module',              true, 'APPROVED',    false);
