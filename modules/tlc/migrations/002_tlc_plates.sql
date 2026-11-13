-- TLC module — 002. Plates straightened from an original image, and evaluation
-- snapshots computed from them. Both are append-only: a re-crop adds a plate
-- and retires the previous one, a re-evaluation adds the next snapshot (E01,
-- E02, …). The database refuses changes and removals, so what a reviewer
-- signed can always be recomputed from the original image.

-- ---------------------------------------------------------------------------
-- Plates: the outline chosen on an original image, the straightened image it
-- produced and the settings that turn it into the analytical image.
-- ---------------------------------------------------------------------------
CREATE TABLE tlc_plates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id      uuid NOT NULL REFERENCES tlc_analyses (id),
  image_id         uuid NOT NULL REFERENCES tlc_images (id),
  illumination     text NOT NULL CHECK (illumination IN ('WHITE', 'UV254', 'UV366')),
  -- Four corners in original-image pixels, clockwise from the top left.
  corners          jsonb NOT NULL CHECK (jsonb_typeof(corners) = 'array' AND jsonb_array_length(corners) = 4),
  outline_source   text NOT NULL CHECK (outline_source IN ('AUTO', 'MANUAL')),
  width_mm         numeric(6, 2) NOT NULL CHECK (width_mm BETWEEN 10 AND 300),
  height_mm        numeric(6, 2) NOT NULL CHECK (height_mm BETWEEN 10 AND 300),
  width_px         integer NOT NULL CHECK (width_px > 0),
  height_px        integer NOT NULL CHECK (height_px > 0),
  channel          text NOT NULL CHECK (channel IN ('INTENSITY', 'RED', 'GREEN', 'BLUE')),
  post_processing  jsonb NOT NULL DEFAULT '{"blackPoint":0,"whitePoint":255,"denoise":false}'::jsonb,
  -- The straightened plate as PNG, and the SHA-256 of its RGB pixels (what the
  -- engine works on; the same whatever the PNG encoder does).
  rectified        bytea NOT NULL,
  rectified_sha256 text NOT NULL,
  pixels_sha256    text NOT NULL,
  is_current       boolean NOT NULL DEFAULT true,
  created_by       uuid NOT NULL REFERENCES users (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (rectified_sha256 = encode(sha256(rectified), 'hex'))
);
CREATE INDEX tlc_plates_analysis_idx ON tlc_plates (analysis_id, created_at DESC);
CREATE UNIQUE INDEX tlc_plates_current_idx ON tlc_plates (analysis_id) WHERE is_current;

CREATE FUNCTION tlc_plates_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE st text;
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'NXGEN-TLC-003: plates are original records and cannot be removed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- The only change allowed: retiring the plate when a new one replaces it.
    IF NEW.is_current OR NOT OLD.is_current OR
       row_to_json(NEW)::jsonb - 'is_current' IS DISTINCT FROM row_to_json(OLD)::jsonb - 'is_current' THEN
      RAISE EXCEPTION 'NXGEN-TLC-003: plates are original records and cannot be changed'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  SELECT state INTO st FROM workflow_instances
   WHERE table_name = 'tlc_analyses' AND record_id = NEW.analysis_id::text;
  IF st IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'NXGEN-TLC-002: plates can only be added while the analysis is a draft'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tlc_plates_guard BEFORE INSERT OR UPDATE OR DELETE ON tlc_plates FOR EACH ROW EXECUTE FUNCTION tlc_plates_guard();
CREATE TRIGGER tlc_plates_no_truncate BEFORE TRUNCATE ON tlc_plates FOR EACH STATEMENT EXECUTE FUNCTION tlc_plates_guard();

-- ---------------------------------------------------------------------------
-- Evaluation snapshots: everything the engine was given (layout, tracks,
-- settings, manual spot windows) and everything it produced (profiles, spots,
-- Rf evaluation, conclusion), with a hash over the lot. Never changed.
-- ---------------------------------------------------------------------------
CREATE TABLE tlc_evaluations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id     uuid NOT NULL REFERENCES tlc_analyses (id),
  plate_id        uuid NOT NULL REFERENCES tlc_plates (id),
  number          integer NOT NULL CHECK (number >= 1),
  code            text NOT NULL,
  input           jsonb NOT NULL,
  results         jsonb NOT NULL,
  conclusion      text NOT NULL CHECK (conclusion IN ('INCOMPLETE', 'CONFORMS', 'DOES_NOT_CONFORM', 'SST_FAILED')),
  engine_version  text NOT NULL,
  content_sha256  text NOT NULL,
  created_by      uuid NOT NULL REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (analysis_id, number)
);
CREATE INDEX tlc_evaluations_analysis_idx ON tlc_evaluations (analysis_id, number DESC);

CREATE FUNCTION tlc_evaluations_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE st text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'NXGEN-TLC-004: evaluation snapshots cannot be changed or removed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT state INTO st FROM workflow_instances
   WHERE table_name = 'tlc_analyses' AND record_id = NEW.analysis_id::text;
  IF st IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'NXGEN-TLC-002: evaluations can only be added while the analysis is a draft'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tlc_evaluations_guard BEFORE INSERT OR UPDATE OR DELETE ON tlc_evaluations FOR EACH ROW EXECUTE FUNCTION tlc_evaluations_guard();
CREATE TRIGGER tlc_evaluations_no_truncate BEFORE TRUNCATE ON tlc_evaluations FOR EACH STATEMENT EXECUTE FUNCTION tlc_evaluations_guard();

-- The analysis points at its current plate and its latest evaluation. Both
-- columns are cleared by nobody: a new evaluation replaces the pointer, the
-- old snapshot stays.
ALTER TABLE tlc_analyses
  ADD COLUMN current_plate_id uuid REFERENCES tlc_plates (id),
  ADD COLUMN current_evaluation_id uuid REFERENCES tlc_evaluations (id);
