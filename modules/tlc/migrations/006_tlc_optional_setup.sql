-- TLC module — 006. Instrument and method are optional when a project is created (the analyst may
-- not know them yet); they are chosen later on the draft and are required before it is submitted
-- for review (enforced by the module's beforeSubmit check, so a signed analysis always names both).

ALTER TABLE tlc_analyses
  ALTER COLUMN device_id         DROP NOT NULL,
  ALTER COLUMN method_id         DROP NOT NULL,
  ALTER COLUMN method_version_id DROP NOT NULL,
  ALTER COLUMN method_code       DROP NOT NULL,
  ALTER COLUMN method_version    DROP NOT NULL,
  ALTER COLUMN method_name       DROP NOT NULL;

-- Method fields come and go together.
ALTER TABLE tlc_analyses ADD CONSTRAINT tlc_analyses_method_complete CHECK (
  (method_id IS NULL) = (method_version_id IS NULL)
  AND (method_id IS NULL) = (method_code IS NULL)
  AND (method_id IS NULL) = (method_version IS NULL)
  AND (method_id IS NULL) = (method_name IS NULL)
);
