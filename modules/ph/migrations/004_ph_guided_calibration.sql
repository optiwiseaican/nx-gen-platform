-- pH module — 004. Guided calibration from NxGen (NxGen Sense PH2 calibration).
-- Acceptance limits gain the largest permitted difference between the meter's
-- reading and the buffer. Each instrument has its own calibration settings.

ALTER TABLE ph_acceptance_profiles
  ADD COLUMN deviation_max_ph numeric(4, 2) NOT NULL DEFAULT 0.05 CHECK (deviation_max_ph BETWEEN 0.01 AND 2);

CREATE TABLE ph_calibration_settings (
  device_id      uuid PRIMARY KEY REFERENCES devices (id),
  point_count    integer NOT NULL CHECK (point_count IN (3, 5)),
  timer_seconds  integer NOT NULL CHECK (timer_seconds BETWEEN 5 AND 600),
  require_stable boolean NOT NULL,
  buffers        jsonb NOT NULL CHECK (jsonb_typeof(buffers) = 'object'),
  created_by    text NOT NULL, created_at timestamptz NOT NULL,
  modified_by   text, modified_at timestamptz,
  version_no    integer NOT NULL,
  record_status text NOT NULL DEFAULT 'ACTIVE',
  is_deleted    boolean NOT NULL DEFAULT false, deleted_by text, deleted_at timestamptz
);
CREATE TRIGGER ph_calibration_settings_before BEFORE INSERT OR UPDATE OR DELETE ON ph_calibration_settings FOR EACH ROW EXECUTE FUNCTION master_before_write();
CREATE TRIGGER ph_calibration_settings_audit AFTER INSERT OR UPDATE ON ph_calibration_settings FOR EACH ROW EXECUTE FUNCTION master_audit('device_id');
