-- =============================================================================
-- TLC — 007: camera settings (the module's "Advanced settings")
-- The starting exposure, gain and white balance for the lamp box camera and
-- its advanced parameters (digital gain, black level, frame rate limit, auto
-- brightness target), per camera serial; '*' is the row for any camera without
-- its own. An approved method still overrides exposure / gain / white balance,
-- and every capture records the values actually used.
-- =============================================================================

CREATE TABLE tlc_camera_settings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  camera_serial     text NOT NULL UNIQUE CHECK (camera_serial = '*' OR camera_serial ~ '^[A-Za-z0-9._-]{1,64}$'),
  exposure_us       numeric(10, 1) NOT NULL DEFAULT 20000 CHECK (exposure_us BETWEEN 31 AND 2000000),
  gain              numeric(6, 3) NOT NULL DEFAULT 1 CHECK (gain BETWEEN 1 AND 16),
  white_balance     jsonb NOT NULL DEFAULT '[1,1,1]'::jsonb CHECK (jsonb_typeof(white_balance) = 'array' AND jsonb_array_length(white_balance) = 3),
  digital_gain      numeric(6, 3) CHECK (digital_gain BETWEEN 1 AND 64),
  black_level_auto  boolean NOT NULL DEFAULT true,
  black_level       numeric(8, 2) CHECK (black_level BETWEEN 0 AND 4095),
  frame_rate        numeric(8, 2) CHECK (frame_rate BETWEEN 0.1 AND 1000),
  auto_target       numeric(4, 3) NOT NULL DEFAULT 0.45 CHECK (auto_target BETWEEN 0.1 AND 0.8),
  note              text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  created_by    text NOT NULL, created_at timestamptz NOT NULL,
  modified_by   text, modified_at timestamptz,
  version_no    integer NOT NULL,
  record_status text NOT NULL DEFAULT 'ACTIVE',
  is_deleted    boolean NOT NULL DEFAULT false, deleted_by text, deleted_at timestamptz
);
CREATE TRIGGER tlc_camera_settings_before BEFORE INSERT OR UPDATE OR DELETE ON tlc_camera_settings FOR EACH ROW EXECUTE FUNCTION master_before_write();
CREATE TRIGGER tlc_camera_settings_audit AFTER INSERT OR UPDATE ON tlc_camera_settings FOR EACH ROW EXECUTE FUNCTION master_audit('id');
