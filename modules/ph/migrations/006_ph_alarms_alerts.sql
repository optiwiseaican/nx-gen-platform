-- pH module — 006. pH range alarms and the alert register (NxGen Sense PH2 alarms
-- and PhAlertPolicy). The server watches the readings, so an alarm does not depend
-- on a screen being open. What an alert said can never change; only its status moves
-- forward (OPEN, ACKNOWLEDGED, RESOLVED). One unresolved alert per code and instrument.

CREATE TABLE ph_alarm_settings (
  device_id   uuid PRIMARY KEY REFERENCES devices (id),
  min_ph      numeric(5, 2) NOT NULL CHECK (min_ph BETWEEN 0 AND 14),
  max_ph      numeric(5, 2) NOT NULL CHECK (max_ph BETWEEN 0 AND 14),
  monitoring  boolean NOT NULL,
  created_by    text NOT NULL, created_at timestamptz NOT NULL,
  modified_by   text, modified_at timestamptz,
  version_no    integer NOT NULL,
  record_status text NOT NULL DEFAULT 'ACTIVE',
  is_deleted    boolean NOT NULL DEFAULT false, deleted_by text, deleted_at timestamptz,
  CHECK (min_ph < max_ph)
);
CREATE TRIGGER ph_alarm_settings_before BEFORE INSERT OR UPDATE OR DELETE ON ph_alarm_settings FOR EACH ROW EXECUTE FUNCTION master_before_write();
CREATE TRIGGER ph_alarm_settings_audit AFTER INSERT OR UPDATE ON ph_alarm_settings FOR EACH ROW EXECUTE FUNCTION master_audit('device_id');

CREATE TABLE ph_alerts (
  id               bigserial PRIMARY KEY,
  device_id        uuid NOT NULL REFERENCES devices (id),
  device_code      text NOT NULL,
  code             text NOT NULL CHECK (code ~ '^PH-[A-Z0-9-]{2,60}$'),
  severity         text NOT NULL CHECK (severity IN ('WARNING', 'CRITICAL')),
  message          text NOT NULL,
  details          jsonb,
  status           text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')),
  raised_at        timestamptz NOT NULL DEFAULT now(),
  acknowledged_by  text,
  acknowledged_at  timestamptz,
  resolved_by      text,
  resolved_at      timestamptz,
  resolution       text
);
CREATE UNIQUE INDEX ph_alerts_one_open_idx ON ph_alerts (device_id, code) WHERE status <> 'RESOLVED';
CREATE INDEX ph_alerts_recent_idx ON ph_alerts (id DESC);

CREATE FUNCTION ph_alerts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'NXGEN-PH-006: alerts cannot be removed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.id, NEW.device_id, NEW.device_code, NEW.code, NEW.severity, NEW.message, NEW.details, NEW.raised_at)
     IS DISTINCT FROM (OLD.id, OLD.device_id, OLD.device_code, OLD.code, OLD.severity, OLD.message, OLD.details, OLD.raised_at)
     OR OLD.status = 'RESOLVED'
     OR (OLD.status = 'ACKNOWLEDGED' AND NEW.status = 'OPEN') THEN
    RAISE EXCEPTION 'NXGEN-PH-007: what an alert recorded cannot change, and its status only moves forward'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ph_alerts_guard BEFORE UPDATE OR DELETE ON ph_alerts FOR EACH ROW EXECUTE FUNCTION ph_alerts_guard();
CREATE TRIGGER ph_alerts_no_truncate BEFORE TRUNCATE ON ph_alerts FOR EACH STATEMENT EXECUTE FUNCTION ph_alerts_guard();
