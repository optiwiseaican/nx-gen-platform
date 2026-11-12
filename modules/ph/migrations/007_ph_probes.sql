-- pH module — 007. Probe register and the probe fitted to each instrument
-- (NxGen Sense probe master and device mapping). Changes are audited with a
-- reason; a retired probe stays on record and cannot return to service.

CREATE TABLE ph_probes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  probe_code       text NOT NULL UNIQUE CHECK (length(probe_code) BETWEEN 1 AND 60),
  probe_type       text NOT NULL DEFAULT '' CHECK (length(probe_type) <= 80),
  display_name     text NOT NULL DEFAULT '' CHECK (length(display_name) <= 120),
  status           text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'BLOCKED', 'INACTIVE', 'RETIRED')),
  status_reason    text NOT NULL DEFAULT '',
  created_by    text NOT NULL, created_at timestamptz NOT NULL,
  modified_by   text, modified_at timestamptz,
  version_no    integer NOT NULL,
  record_status text NOT NULL DEFAULT 'ACTIVE',
  is_deleted    boolean NOT NULL DEFAULT false, deleted_by text, deleted_at timestamptz
);
CREATE TRIGGER ph_probes_before BEFORE INSERT OR UPDATE OR DELETE ON ph_probes FOR EACH ROW EXECUTE FUNCTION master_before_write();
CREATE TRIGGER ph_probes_audit AFTER INSERT OR UPDATE ON ph_probes FOR EACH ROW EXECUTE FUNCTION master_audit('id');

CREATE TABLE ph_instrument_probes (
  device_id              uuid PRIMARY KEY REFERENCES devices (id),
  probe_id               uuid NOT NULL UNIQUE REFERENCES ph_probes (id),
  temperature_sensor_id  text NOT NULL CHECK (length(temperature_sensor_id) BETWEEN 1 AND 60),
  interrupted_runs       integer NOT NULL DEFAULT 0 CHECK (interrupted_runs >= 0),
  created_by    text NOT NULL, created_at timestamptz NOT NULL,
  modified_by   text, modified_at timestamptz,
  version_no    integer NOT NULL,
  record_status text NOT NULL DEFAULT 'ACTIVE',
  is_deleted    boolean NOT NULL DEFAULT false, deleted_by text, deleted_at timestamptz
);
CREATE TRIGGER ph_instrument_probes_before BEFORE INSERT OR UPDATE OR DELETE ON ph_instrument_probes FOR EACH ROW EXECUTE FUNCTION master_before_write();
CREATE TRIGGER ph_instrument_probes_audit AFTER INSERT OR UPDATE ON ph_instrument_probes FOR EACH ROW EXECUTE FUNCTION master_audit('device_id');
