-- pH module — 008. Saved product, batch and AR-number lists (NxGen Sense
-- "Add List" on the Logs tab). Entries are picked when a reading is logged so
-- the same names are typed the same way every time. Removing an entry is a
-- soft delete recorded with a reason; logged readings keep the text they used.

CREATE TABLE ph_sample_lists (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('PRODUCT', 'BATCH', 'AR')),
  value         text NOT NULL CHECK (length(value) BETWEEN 1 AND 120),
  created_by    text NOT NULL, created_at timestamptz NOT NULL,
  modified_by   text, modified_at timestamptz,
  version_no    integer NOT NULL,
  record_status text NOT NULL DEFAULT 'ACTIVE',
  is_deleted    boolean NOT NULL DEFAULT false, deleted_by text, deleted_at timestamptz
);
CREATE UNIQUE INDEX ph_sample_lists_value_idx ON ph_sample_lists (kind, lower(value)) WHERE NOT is_deleted;
CREATE TRIGGER ph_sample_lists_before BEFORE INSERT OR UPDATE OR DELETE ON ph_sample_lists FOR EACH ROW EXECUTE FUNCTION master_before_write();
CREATE TRIGGER ph_sample_lists_audit AFTER INSERT OR UPDATE ON ph_sample_lists FOR EACH ROW EXECUTE FUNCTION master_audit('id');
