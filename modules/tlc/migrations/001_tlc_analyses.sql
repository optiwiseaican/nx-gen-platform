-- TLC module — 001. Owned by the module (prefix tlc_). Audited by the core
-- triggers; analyses are governed by the core workflow engine and locked by
-- workflow_lock() once submitted.

CREATE SEQUENCE tlc_analysis_code_seq;

CREATE TABLE tlc_analyses (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code               text NOT NULL UNIQUE,
  device_id          uuid NOT NULL REFERENCES devices (id),
  method_id          uuid NOT NULL REFERENCES methods (id),
  method_version_id  uuid NOT NULL REFERENCES method_versions (id),
  method_code        text NOT NULL,
  method_version     integer NOT NULL,
  method_name        text NOT NULL,
  rf_windows         jsonb NOT NULL DEFAULT '[]'::jsonb,
  sample_id          text NOT NULL CHECK (length(sample_id) BETWEEN 1 AND 80),
  batch              text NOT NULL DEFAULT '',
  plate_type         text NOT NULL CHECK (length(plate_type) BETWEEN 2 AND 120),
  plate_lot          text NOT NULL DEFAULT '',
  mobile_phase       text NOT NULL DEFAULT '',
  solvent_front_mm   numeric(6, 2),
  tracks             jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tracks) = 'array'),
  results            jsonb NOT NULL DEFAULT '{}'::jsonb,
  conclusion         text NOT NULL DEFAULT 'INCOMPLETE'
                       CHECK (conclusion IN ('INCOMPLETE', 'CONFORMS', 'DOES_NOT_CONFORM', 'SST_FAILED')),
  remarks            text NOT NULL DEFAULT '',
  analyzed_by        uuid NOT NULL REFERENCES users (id),
  created_by    text NOT NULL, created_at timestamptz NOT NULL,
  modified_by   text, modified_at timestamptz,
  version_no    integer NOT NULL,
  record_status text NOT NULL DEFAULT 'ACTIVE',
  is_deleted    boolean NOT NULL DEFAULT false, deleted_by text, deleted_at timestamptz
);
CREATE INDEX tlc_analyses_device_idx ON tlc_analyses (device_id, created_at DESC);
CREATE TRIGGER tlc_analyses_lock BEFORE UPDATE OR DELETE ON tlc_analyses FOR EACH ROW EXECUTE FUNCTION workflow_lock();
CREATE TRIGGER tlc_analyses_before BEFORE INSERT OR UPDATE OR DELETE ON tlc_analyses FOR EACH ROW EXECUTE FUNCTION master_before_write();
CREATE TRIGGER tlc_analyses_audit AFTER INSERT OR UPDATE ON tlc_analyses FOR EACH ROW EXECUTE FUNCTION master_audit('id');

-- Original plate images: stored once with their SHA-256, never changed or removed,
-- and only added while the analysis is still a draft.
CREATE TABLE tlc_images (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id    uuid NOT NULL REFERENCES tlc_analyses (id),
  illumination   text NOT NULL CHECK (illumination IN ('WHITE', 'UV254', 'UV366')),
  file_name      text NOT NULL,
  content_type   text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg')),
  size_bytes     integer NOT NULL CHECK (size_bytes > 0),
  sha256         text NOT NULL,
  data           bytea NOT NULL,
  uploaded_by    uuid NOT NULL REFERENCES users (id),
  uploaded_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (sha256 = encode(sha256(data), 'hex')),
  CHECK (size_bytes = length(data))
);
CREATE INDEX tlc_images_analysis_idx ON tlc_images (analysis_id, uploaded_at);

CREATE FUNCTION tlc_images_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE st text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'NXGEN-TLC-001: plate images are original records and cannot be changed or removed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT state INTO st FROM workflow_instances
   WHERE table_name = 'tlc_analyses' AND record_id = NEW.analysis_id::text;
  IF st IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'NXGEN-TLC-002: images can only be added while the analysis is a draft'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tlc_images_guard BEFORE INSERT OR UPDATE OR DELETE ON tlc_images FOR EACH ROW EXECUTE FUNCTION tlc_images_guard();
CREATE TRIGGER tlc_images_no_truncate BEFORE TRUNCATE ON tlc_images FOR EACH STATEMENT EXECUTE FUNCTION tlc_images_guard();
