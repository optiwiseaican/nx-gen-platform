-- pH module — 002. Saved pH measurements (NxGen Sense MeasurementRecordService).
-- A measurement is taken from the instrument's own packets, only when the
-- reading is stable; the stored packets are referenced by id (lineage). The
-- measured values can never be changed, even in a draft; sample details can be
-- corrected in a draft with a reason (audited). Review and approval run on the
-- core workflow engine, which locks the record once submitted.

CREATE SEQUENCE ph_measurement_code_seq;

CREATE TABLE ph_measurements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text NOT NULL UNIQUE,
  device_id        uuid NOT NULL REFERENCES devices (id),
  sample_id        text NOT NULL CHECK (length(sample_id) BETWEEN 1 AND 80),
  batch            text NOT NULL CHECK (length(batch) BETWEEN 1 AND 80),
  ar_number        text NOT NULL CHECK (length(ar_number) BETWEEN 1 AND 80),
  product          text NOT NULL CHECK (length(product) BETWEEN 1 AND 120),
  remarks          text NOT NULL DEFAULT '',
  ph               numeric(6, 3) NOT NULL CHECK (ph BETWEEN 0 AND 14),
  temperature_c    numeric(6, 2) NOT NULL CHECK (temperature_c BETWEEN -20 AND 150),
  atc              text NOT NULL CHECK (atc IN ('ON', 'OFF', 'UNKNOWN')),
  stability        jsonb NOT NULL CHECK (stability->>'state' = 'STABLE'),
  data_source      text NOT NULL CHECK (data_source IN ('INSTRUMENT', 'SIMULATED')),
  source_messages  bigint[] NOT NULL CHECK (cardinality(source_messages) >= 2),
  calibration      jsonb NOT NULL,
  measured_by      uuid NOT NULL REFERENCES users (id),
  measured_at      timestamptz NOT NULL,
  created_by    text NOT NULL, created_at timestamptz NOT NULL,
  modified_by   text, modified_at timestamptz,
  version_no    integer NOT NULL,
  record_status text NOT NULL DEFAULT 'ACTIVE',
  is_deleted    boolean NOT NULL DEFAULT false, deleted_by text, deleted_at timestamptz
);
CREATE INDEX ph_measurements_device_idx ON ph_measurements (device_id, measured_at DESC);

-- Measured values are original data: never changed, never removed.
CREATE FUNCTION ph_measurements_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'NXGEN-PH-002: pH measurements cannot be removed; invalidate them instead'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.is_deleted IS DISTINCT FROM OLD.is_deleted THEN
    RAISE EXCEPTION 'NXGEN-PH-002: pH measurements cannot be removed; invalidate them instead'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.code, NEW.device_id, NEW.ph, NEW.temperature_c, NEW.atc, NEW.stability, NEW.data_source,
      NEW.source_messages, NEW.calibration, NEW.measured_by, NEW.measured_at)
     IS DISTINCT FROM
     (OLD.code, OLD.device_id, OLD.ph, OLD.temperature_c, OLD.atc, OLD.stability, OLD.data_source,
      OLD.source_messages, OLD.calibration, OLD.measured_by, OLD.measured_at) THEN
    RAISE EXCEPTION 'NXGEN-PH-001: measured values are original data and cannot be changed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER ph_measurements_guard BEFORE UPDATE OR DELETE ON ph_measurements FOR EACH ROW EXECUTE FUNCTION ph_measurements_guard();
CREATE TRIGGER ph_measurements_no_truncate BEFORE TRUNCATE ON ph_measurements FOR EACH STATEMENT EXECUTE FUNCTION ph_measurements_guard();
CREATE TRIGGER ph_measurements_lock BEFORE UPDATE OR DELETE ON ph_measurements FOR EACH ROW EXECUTE FUNCTION workflow_lock();
CREATE TRIGGER ph_measurements_before BEFORE INSERT OR UPDATE OR DELETE ON ph_measurements FOR EACH ROW EXECUTE FUNCTION master_before_write();
CREATE TRIGGER ph_measurements_audit AFTER INSERT OR UPDATE ON ph_measurements FOR EACH ROW EXECUTE FUNCTION master_audit('id');
