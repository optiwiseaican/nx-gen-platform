-- TLC module — 004. The fields of the tablet's "Create New Project" dialog: a project name,
-- the owner's department and a project status, plus the plate-info fields of its Plate stage
-- (stationary phase, staining / derivatization). The sample / batch ID becomes optional, as
-- on the tablet for a routine analysis.

ALTER TABLE tlc_analyses
  ADD COLUMN name             text NOT NULL DEFAULT '' CHECK (length(name) <= 100),
  ADD COLUMN department       text NOT NULL DEFAULT '' CHECK (length(department) <= 80),
  ADD COLUMN project_status   text NOT NULL DEFAULT 'ACTIVE' CHECK (project_status IN ('ACTIVE', 'ON_HOLD', 'COMPLETED')),
  ADD COLUMN stationary_phase text NOT NULL DEFAULT '' CHECK (length(stationary_phase) <= 120),
  ADD COLUMN staining         text NOT NULL DEFAULT '' CHECK (length(staining) <= 120);

ALTER TABLE tlc_analyses DROP CONSTRAINT tlc_analyses_sample_id_check;
ALTER TABLE tlc_analyses ADD CONSTRAINT tlc_analyses_sample_id_check CHECK (length(sample_id) <= 80);
