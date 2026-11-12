-- pH module — 003. Editable calibration acceptance limits (NxGen Sense acceptance
-- profiles). Each change is a new numbered version with a reason, reviewed and
-- approved on the core workflow engine. The approved version is the one in force;
-- calibrations keep a copy of the limits they were judged by.

CREATE TABLE ph_acceptance_profiles (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_version     integer NOT NULL UNIQUE CHECK (profile_version >= 1),
  slope_pass_min      numeric(5, 2) NOT NULL,
  slope_pass_max      numeric(5, 2) NOT NULL,
  slope_warn_min      numeric(5, 2) NOT NULL CHECK (slope_warn_min >= 50),
  slope_warn_max      numeric(5, 2) NOT NULL CHECK (slope_warn_max <= 150),
  offset_pass_max_abs numeric(5, 2) NOT NULL CHECK (offset_pass_max_abs >= 0),
  offset_warn_max_abs numeric(5, 2) NOT NULL CHECK (offset_warn_max_abs <= 200),
  change_reason       text NOT NULL CHECK (length(change_reason) BETWEEN 10 AND 1000),
  prepared_by         uuid NOT NULL REFERENCES users (id),
  created_by    text NOT NULL, created_at timestamptz NOT NULL,
  modified_by   text, modified_at timestamptz,
  version_no    integer NOT NULL,
  record_status text NOT NULL DEFAULT 'ACTIVE',
  is_deleted    boolean NOT NULL DEFAULT false, deleted_by text, deleted_at timestamptz,
  CHECK (slope_warn_min <= slope_pass_min AND slope_pass_min < slope_pass_max AND slope_pass_max <= slope_warn_max),
  CHECK (offset_pass_max_abs <= offset_warn_max_abs)
);

-- A version may be corrected while it is a draft (the workflow lock covers the
-- rest), but it keeps its number and its author and is never removed.
CREATE FUNCTION ph_acceptance_profiles_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') OR NEW.is_deleted IS DISTINCT FROM OLD.is_deleted THEN
    RAISE EXCEPTION 'NXGEN-PH-003: acceptance limit versions cannot be removed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.profile_version, NEW.prepared_by) IS DISTINCT FROM (OLD.profile_version, OLD.prepared_by) THEN
    RAISE EXCEPTION 'NXGEN-PH-004: an acceptance limit version keeps its number and author'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER ph_acceptance_profiles_guard BEFORE UPDATE OR DELETE ON ph_acceptance_profiles FOR EACH ROW EXECUTE FUNCTION ph_acceptance_profiles_guard();
CREATE TRIGGER ph_acceptance_profiles_no_truncate BEFORE TRUNCATE ON ph_acceptance_profiles FOR EACH STATEMENT EXECUTE FUNCTION ph_acceptance_profiles_guard();
CREATE TRIGGER ph_acceptance_profiles_lock BEFORE UPDATE OR DELETE ON ph_acceptance_profiles FOR EACH ROW EXECUTE FUNCTION workflow_lock();
CREATE TRIGGER ph_acceptance_profiles_before BEFORE INSERT OR UPDATE OR DELETE ON ph_acceptance_profiles FOR EACH ROW EXECUTE FUNCTION master_before_write();
CREATE TRIGGER ph_acceptance_profiles_audit AFTER INSERT OR UPDATE ON ph_acceptance_profiles FOR EACH ROW EXECUTE FUNCTION master_audit('id');
