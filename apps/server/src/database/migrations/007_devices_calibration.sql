-- =============================================================================
-- NxGen Device Layer — 007
-- Device registration (master spec §4 Device Layer, §9) and calibration
-- management (§4, §7 "Calibration Approval"; LabApp calibration rules).
-- =============================================================================

CREATE SEQUENCE device_code_seq;
CREATE TABLE devices (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                       text NOT NULL UNIQUE,
  instrument_type            text NOT NULL CHECK (instrument_type IN ('PH', 'EC', 'TLC', 'OTHER')),
  name                       text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  manufacturer               text NOT NULL CHECK (length(manufacturer) BETWEEN 1 AND 120),
  model                      text NOT NULL CHECK (length(model) BETWEEN 1 AND 120),
  serial_number              text NOT NULL CHECK (length(serial_number) BETWEEN 1 AND 80),
  asset_tag                  text,
  location                   text NOT NULL DEFAULT '',
  firmware_version           text NOT NULL DEFAULT '',
  installed_on               date,
  device_status              text NOT NULL DEFAULT 'ACTIVE'
                               CHECK (device_status IN ('ACTIVE', 'OUT_OF_SERVICE', 'RETIRED')),
  calibration_interval_days  integer NOT NULL DEFAULT 30 CHECK (calibration_interval_days BETWEEN 1 AND 730),
  calibration_warning_days   integer NOT NULL DEFAULT 7 CHECK (calibration_warning_days BETWEEN 0 AND 60),
  created_by    text NOT NULL, created_at timestamptz NOT NULL,
  modified_by   text, modified_at timestamptz,
  version_no    integer NOT NULL,
  record_status text NOT NULL DEFAULT 'ACTIVE',
  is_deleted    boolean NOT NULL DEFAULT false, deleted_by text, deleted_at timestamptz,
  UNIQUE (manufacturer, model, serial_number)
);
CREATE UNIQUE INDEX devices_asset_tag_idx ON devices (lower(asset_tag)) WHERE asset_tag IS NOT NULL;
CREATE TRIGGER devices_before BEFORE INSERT OR UPDATE OR DELETE ON devices FOR EACH ROW EXECUTE FUNCTION master_before_write();
CREATE TRIGGER devices_audit AFTER INSERT OR UPDATE ON devices FOR EACH ROW EXECUTE FUNCTION master_audit('id');

-- A retired device never returns to service.
CREATE FUNCTION devices_retired_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.device_status = 'RETIRED' AND NEW.device_status <> 'RETIRED' THEN
    RAISE EXCEPTION 'NXGEN-DEV-001: a retired device cannot return to service'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER devices_retired_final BEFORE UPDATE ON devices FOR EACH ROW EXECUTE FUNCTION devices_retired_final();

-- Calibration records. Readings are captured as performed; the computed result
-- is stored with the acceptance limits that were applied. Governed by the
-- CALIBRATION_APPROVAL workflow and locked once submitted.
CREATE SEQUENCE calibration_code_seq;
CREATE TABLE calibration_records (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code               text NOT NULL UNIQUE,
  device_id          uuid NOT NULL REFERENCES devices (id),
  performed_at       timestamptz NOT NULL,
  performed_by       uuid NOT NULL REFERENCES users (id),
  data_source        text NOT NULL DEFAULT 'MANUAL' CHECK (data_source IN ('MANUAL', 'INSTRUMENT')),
  temperature_c      numeric(5, 2),
  readings           jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(readings) = 'array'),
  limits             jsonb NOT NULL,
  results            jsonb NOT NULL DEFAULT '{}'::jsonb,
  outcome            text NOT NULL CHECK (outcome IN ('PASS', 'WARNING', 'FAIL')),
  remarks            text NOT NULL DEFAULT '',
  created_by    text NOT NULL, created_at timestamptz NOT NULL,
  modified_by   text, modified_at timestamptz,
  version_no    integer NOT NULL,
  record_status text NOT NULL DEFAULT 'ACTIVE',
  is_deleted    boolean NOT NULL DEFAULT false, deleted_by text, deleted_at timestamptz
);
CREATE INDEX calibration_records_device_idx ON calibration_records (device_id, performed_at DESC);
CREATE TRIGGER calibration_records_lock BEFORE UPDATE OR DELETE ON calibration_records FOR EACH ROW EXECUTE FUNCTION workflow_lock();
CREATE TRIGGER calibration_records_before BEFORE INSERT OR UPDATE OR DELETE ON calibration_records FOR EACH ROW EXECUTE FUNCTION master_before_write();
CREATE TRIGGER calibration_records_audit AFTER INSERT OR UPDATE ON calibration_records FOR EACH ROW EXECUTE FUNCTION master_audit('id');

-- ---------------------------------------------------------------------------
-- Seeds
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, description) VALUES
  ('devices.view',          'View instruments, their status and calibration history'),
  ('devices.manage',        'Register instruments, edit them and change their status'),
  ('calibration.perform',   'Record calibrations and submit them for approval'),
  ('calibration.approve',   'Approve, reject and invalidate calibrations (signed)');

-- Segregation of duties: whoever performs a calibration does not approve it (LabApp SoD rule).
INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('SUPER_ADMINISTRATOR', 'devices.view'),
  ('IT_ADMINISTRATOR',    'devices.view'), ('IT_ADMINISTRATOR', 'devices.manage'),
  ('QA_MANAGER',          'devices.view'), ('QA_MANAGER', 'calibration.approve'),
  ('QA_REVIEWER',         'devices.view'),
  ('ANALYST',             'devices.view'), ('ANALYST', 'calibration.perform'),
  ('OPERATOR',            'devices.view'), ('OPERATOR', 'calibration.perform'),
  ('AUDITOR',             'devices.view');

-- Calibration: performer submits, an independent approver signs. No separate review stage.
INSERT INTO workflow_definitions (code, name, record_table, edit_permission, review_permission, approve_permission,
                                  require_review, independent_reviewer, independent_approver)
VALUES ('CALIBRATION_APPROVAL', 'Calibration approval', 'calibration_records', 'calibration.perform',
        'calibration.approve', 'calibration.approve', false, true, true);

INSERT INTO signature_policies (action_code, description, required, default_meaning, locked) VALUES
  ('DEVICE_REGISTER',       'Register an instrument',                   true,  'APPROVED',    false),
  ('DEVICE_UPDATE',         'Edit an instrument''s details',            false, 'RESPONSIBLE', false),
  ('DEVICE_STATUS_CHANGE',  'Take an instrument out of service, return or retire it', true, 'RESPONSIBLE', false);
