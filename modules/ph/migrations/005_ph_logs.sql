-- pH module — 005. Logged readings (NxGen Sense PH2 logs): by hand, when the
-- meter holds a stable reading, from the meter's button, or at an interval.
-- Each entry points to the original instrument packet. Entries are original
-- data, so unlike the app there is no way to clear them.

CREATE TABLE ph_log_entries (
  id              bigserial PRIMARY KEY,
  device_id       uuid NOT NULL REFERENCES devices (id),
  device_code     text NOT NULL,
  method          text NOT NULL CHECK (method IN ('MANUAL', 'STABLE', 'BUTTON', 'INTERVAL')),
  ph              numeric(6, 3) NOT NULL CHECK (ph BETWEEN 0 AND 14),
  mv              numeric(8, 2) NOT NULL,
  temperature_c   numeric(6, 2) NOT NULL,
  stable          boolean NOT NULL,
  batch           text NOT NULL DEFAULT '' CHECK (length(batch) <= 80),
  ar_number       text NOT NULL DEFAULT '' CHECK (length(ar_number) <= 80),
  product         text NOT NULL DEFAULT '' CHECK (length(product) <= 120),
  data_source     text NOT NULL CHECK (data_source IN ('INSTRUMENT', 'SIMULATED')),
  source_message  bigint NOT NULL REFERENCES device_messages (id),
  logged_by       uuid NOT NULL REFERENCES users (id),
  logged_by_name  text NOT NULL,
  logged_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ph_log_entries_device_idx ON ph_log_entries (device_id, id DESC);

CREATE FUNCTION ph_log_entries_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'NXGEN-PH-005: logged readings are original data and cannot be changed or removed'
    USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER ph_log_entries_no_change BEFORE UPDATE OR DELETE ON ph_log_entries FOR EACH ROW EXECUTE FUNCTION ph_log_entries_immutable();
CREATE TRIGGER ph_log_entries_no_truncate BEFORE TRUNCATE ON ph_log_entries FOR EACH STATEMENT EXECUTE FUNCTION ph_log_entries_immutable();
