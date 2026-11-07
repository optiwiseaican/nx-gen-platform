-- =============================================================================
-- NxGen Device Layer — 008
-- Device Gateway (master spec §9 Device Communication).
--
-- Instruments (e.g. pH portable) talk to a USB dongle over ESP-NOW; the dongle
-- forwards the instruments' JSON packets to NxGen over USB serial (UART). The
-- packet format is the one used by the LabApp WebSocket application:
--   {"PH_VAL":"7.25","DEVICE_ID":"device_001"}
-- =============================================================================

-- The DEVICE_ID an instrument puts in its packets binds it to its register entry.
ALTER TABLE devices ADD COLUMN device_identifier text
  CHECK (device_identifier IS NULL OR device_identifier ~ '^[A-Za-z0-9_.:-]{1,64}$');
CREATE UNIQUE INDEX devices_identifier_idx ON devices (device_identifier) WHERE device_identifier IS NOT NULL;

-- Calibrations can now come from the instrument (or, in development only, the simulator).
ALTER TABLE calibration_records DROP CONSTRAINT calibration_records_data_source_check;
ALTER TABLE calibration_records ADD CONSTRAINT calibration_records_data_source_check
  CHECK (data_source IN ('MANUAL', 'INSTRUMENT', 'SIMULATED'));
-- Captured packets the readings were taken from (device_messages ids).
ALTER TABLE calibration_records ADD COLUMN source_messages jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Serial ports the gateway listens on (one per USB dongle).
CREATE TABLE gateway_ports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  port_path     text NOT NULL UNIQUE CHECK (length(port_path) BETWEEN 1 AND 200),
  label         text NOT NULL DEFAULT '',
  baud_rate     integer NOT NULL DEFAULT 115200 CHECK (baud_rate IN (9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600)),
  enabled       boolean NOT NULL DEFAULT true,
  created_by    text NOT NULL, created_at timestamptz NOT NULL,
  modified_by   text, modified_at timestamptz,
  version_no    integer NOT NULL,
  record_status text NOT NULL DEFAULT 'ACTIVE',
  is_deleted    boolean NOT NULL DEFAULT false, deleted_by text, deleted_at timestamptz
);
CREATE TRIGGER gateway_ports_before BEFORE INSERT OR UPDATE OR DELETE ON gateway_ports FOR EACH ROW EXECUTE FUNCTION master_before_write();
CREATE TRIGGER gateway_ports_audit AFTER INSERT OR UPDATE ON gateway_ports FOR EACH ROW EXECUTE FUNCTION master_audit('id');

-- Original packets as received (ALCOA+ "original"). Append-only.
-- Stored: calibration, log, status and rejected packets, and the measurement
-- packets a log or record was taken from. The continuous live stream is shown
-- on screen but not stored packet by packet.
CREATE TABLE device_messages (
  id                 bigserial PRIMARY KEY,
  received_at        timestamptz NOT NULL DEFAULT now(),
  transport          text NOT NULL CHECK (transport IN ('SERIAL', 'SIMULATOR')),
  port_path          text NOT NULL,
  raw                text NOT NULL,
  raw_sha256         text NOT NULL,
  device_identifier  text,
  device_id          uuid REFERENCES devices (id),
  kind               text NOT NULL CHECK (kind IN ('MEASUREMENT', 'CALIBRATION', 'STATUS', 'LOG', 'UNKNOWN')),
  payload            jsonb,
  accepted           boolean NOT NULL,
  rejection_reason   text,
  CHECK (raw_sha256 = encode(sha256(convert_to(raw, 'UTF8')), 'hex'))
);
CREATE INDEX device_messages_device_idx ON device_messages (device_id, received_at DESC);
CREATE INDEX device_messages_identifier_idx ON device_messages (device_identifier, received_at DESC);

CREATE FUNCTION device_messages_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'NXGEN-GW-001: captured device data is append-only'
    USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER device_messages_no_update BEFORE UPDATE OR DELETE ON device_messages
  FOR EACH ROW EXECUTE FUNCTION device_messages_immutable();
CREATE TRIGGER device_messages_no_truncate BEFORE TRUNCATE ON device_messages
  FOR EACH STATEMENT EXECUTE FUNCTION device_messages_immutable();
