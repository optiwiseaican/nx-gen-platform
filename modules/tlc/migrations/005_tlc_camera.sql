-- =============================================================================
-- TLC — 005: images captured by the lamp box camera
-- An image is either uploaded or captured. A capture keeps the camera it came
-- from (serial, model, simulated or not) and the settings used (exposure,
-- gain, white balance, pixel format, sensor bits, temperature, retakes), so the
-- picture can be traced to the instrument and repeated.
-- =============================================================================

ALTER TABLE tlc_images
  ADD COLUMN source text NOT NULL DEFAULT 'UPLOAD' CHECK (source IN ('UPLOAD', 'CAMERA')),
  ADD COLUMN camera jsonb,
  ADD CONSTRAINT tlc_images_camera_source CHECK ((source = 'CAMERA') = (camera IS NOT NULL));
