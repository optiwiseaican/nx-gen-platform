-- TLC module — 003. The capture quality gate (as on the TLC tablet) runs on every
-- plate image when it is stored, and its verdict is kept with the image. A plate
-- may only be straightened from an image that failed the gate when the analyst
-- gives a reason, which is kept with the plate and audited.

ALTER TABLE tlc_images ADD COLUMN qc jsonb;
ALTER TABLE tlc_plates ADD COLUMN qc_override_reason text NOT NULL DEFAULT '';
