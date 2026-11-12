-- =============================================================================
-- NxGen Device Layer — 011
-- Commands sent to instruments (calibration steps, ATC, log modes). They are
-- kept in the same append-only table as the packets received, so the exchange
-- with an instrument can be read in order. For a command, "accepted" records
-- whether it was written to the USB dongle, not whether the instrument acted.
-- =============================================================================

ALTER TABLE device_messages
  ADD COLUMN direction text NOT NULL DEFAULT 'IN' CHECK (direction IN ('IN', 'OUT'));

ALTER TABLE device_messages DROP CONSTRAINT device_messages_kind_check;
ALTER TABLE device_messages ADD CONSTRAINT device_messages_kind_check
  CHECK (kind IN ('MEASUREMENT', 'CALIBRATION', 'STATUS', 'LOG', 'UNKNOWN', 'COMMAND'));
