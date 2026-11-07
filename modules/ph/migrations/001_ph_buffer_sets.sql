-- pH module — 001. Owned by the module (prefix ph_); audited by the core triggers.
-- Buffer sets map the instrument's buffer slots (MV_1 … MV_5) to buffer pH values.
CREATE TABLE ph_buffer_sets (
  code          text PRIMARY KEY CHECK (code ~ '^[A-Z0-9_]{2,30}$'),
  name          text NOT NULL,
  buffers       jsonb NOT NULL CHECK (jsonb_typeof(buffers) = 'object'),
  is_default    boolean NOT NULL DEFAULT false,
  created_by    text NOT NULL, created_at timestamptz NOT NULL,
  modified_by   text, modified_at timestamptz,
  version_no    integer NOT NULL,
  record_status text NOT NULL DEFAULT 'ACTIVE',
  is_deleted    boolean NOT NULL DEFAULT false, deleted_by text, deleted_at timestamptz
);
CREATE UNIQUE INDEX ph_buffer_sets_default_idx ON ph_buffer_sets (is_default) WHERE is_default;
CREATE TRIGGER ph_buffer_sets_before BEFORE INSERT OR UPDATE OR DELETE ON ph_buffer_sets FOR EACH ROW EXECUTE FUNCTION master_before_write();
CREATE TRIGGER ph_buffer_sets_audit AFTER INSERT OR UPDATE ON ph_buffer_sets FOR EACH ROW EXECUTE FUNCTION master_audit('code');

-- The instrument's buffer list (LabApp protocol: buffer 1–5).
INSERT INTO ph_buffer_sets (code, name, buffers, is_default) VALUES
  ('AICAN_STANDARD', 'AICAN standard buffers', '{"1": 4.01, "2": 7.00, "3": 9.21, "4": 10.01, "5": 1.68}', true);
