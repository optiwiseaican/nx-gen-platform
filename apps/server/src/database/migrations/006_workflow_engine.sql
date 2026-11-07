-- =============================================================================
-- NxGen Compliance Core — 006
-- Workflow Engine (master spec §4, §7) and its first consumer, Method
-- management (§7 "Method Approval").
--
-- Lifecycle of one version of a controlled record:
--
--   DRAFT ──submit──▶ IN_REVIEW ──review──▶ REVIEWED ──approve──▶ APPROVED
--     ▲  ◀─withdraw──┘    │                     │                    │
--     └──────reject───────┴──────reject─────────┘ (or back to         ├─invalidate─▶ INVALIDATED
--                                                  IN_REVIEW)         └─(next version approved)─▶ SUPERSEDED
--
-- Every step except withdraw carries an electronic signature with a fixed
-- meaning. Content is hashed at submission; from then on the database itself
-- refuses changes to the record (workflow_lock trigger).
-- =============================================================================

CREATE TABLE workflow_definitions (
  code                         text PRIMARY KEY CHECK (code ~ '^[A-Z][A-Z_]{1,40}$'),
  name                         text NOT NULL,
  record_table                 text NOT NULL,
  edit_permission              text NOT NULL REFERENCES permissions (code),
  review_permission            text NOT NULL REFERENCES permissions (code),
  approve_permission           text NOT NULL REFERENCES permissions (code),
  require_review               boolean NOT NULL DEFAULT true,
  independent_reviewer         boolean NOT NULL DEFAULT true,
  independent_approver         boolean NOT NULL DEFAULT true,
  created_by    text NOT NULL, created_at timestamptz NOT NULL,
  modified_by   text, modified_at timestamptz,
  version_no    integer NOT NULL,
  record_status text NOT NULL DEFAULT 'ACTIVE',
  is_deleted    boolean NOT NULL DEFAULT false, deleted_by text, deleted_at timestamptz
);
CREATE TRIGGER workflow_definitions_before BEFORE INSERT OR UPDATE OR DELETE ON workflow_definitions FOR EACH ROW EXECUTE FUNCTION master_before_write();
CREATE TRIGGER workflow_definitions_audit AFTER INSERT OR UPDATE ON workflow_definitions FOR EACH ROW EXECUTE FUNCTION master_audit('code');

CREATE TABLE workflow_instances (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_code  text NOT NULL REFERENCES workflow_definitions (code),
  table_name       text NOT NULL,
  record_id        text NOT NULL,
  series_id        text NOT NULL,          -- e.g. the method; versions of one series supersede each other
  series_version   integer NOT NULL,       -- 1, 2, 3 … within the series
  state            text NOT NULL DEFAULT 'DRAFT'
                     CHECK (state IN ('DRAFT', 'IN_REVIEW', 'REVIEWED', 'APPROVED', 'INVALIDATED', 'SUPERSEDED')),
  content_hash     text,                   -- SHA-256 of the record content as submitted
  prepared_by      uuid REFERENCES users (id),
  reviewed_by      uuid REFERENCES users (id),
  approved_by      uuid REFERENCES users (id),
  submitted_at     timestamptz,
  approved_at      timestamptz,
  created_by    text NOT NULL, created_at timestamptz NOT NULL,
  modified_by   text, modified_at timestamptz,
  version_no    integer NOT NULL,
  record_status text NOT NULL DEFAULT 'ACTIVE',
  is_deleted    boolean NOT NULL DEFAULT false, deleted_by text, deleted_at timestamptz,
  UNIQUE (table_name, record_id),
  UNIQUE (definition_code, series_id, series_version)
);
CREATE INDEX workflow_instances_state_idx ON workflow_instances (state) WHERE state IN ('IN_REVIEW', 'REVIEWED');
-- At most one version of a series may be in progress, and one may be APPROVED (effective).
CREATE UNIQUE INDEX workflow_instances_one_open_idx ON workflow_instances (definition_code, series_id)
  WHERE state IN ('DRAFT', 'IN_REVIEW', 'REVIEWED');
CREATE UNIQUE INDEX workflow_instances_one_effective_idx ON workflow_instances (definition_code, series_id)
  WHERE state = 'APPROVED';
CREATE TRIGGER workflow_instances_before BEFORE INSERT OR UPDATE OR DELETE ON workflow_instances FOR EACH ROW EXECUTE FUNCTION master_before_write();
CREATE TRIGGER workflow_instances_audit AFTER INSERT OR UPDATE ON workflow_instances FOR EACH ROW EXECUTE FUNCTION master_audit('id');

-- Step history: append-only.
CREATE TABLE workflow_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id   uuid NOT NULL REFERENCES workflow_instances (id),
  step          text NOT NULL CHECK (step IN ('CREATE', 'SUBMIT', 'WITHDRAW', 'REVIEW', 'APPROVE', 'REJECT', 'INVALIDATE', 'SUPERSEDE')),
  from_state    text,
  to_state      text NOT NULL,
  actor_id      text NOT NULL,
  actor_name    text,
  comment       text,
  signature_id  uuid REFERENCES electronic_signatures (id),
  content_hash  text,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflow_events_instance_idx ON workflow_events (instance_id, occurred_at);

CREATE FUNCTION workflow_events_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'NXGEN-WF-002: workflow history is append-only'
    USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER workflow_events_no_update BEFORE UPDATE OR DELETE ON workflow_events
  FOR EACH ROW EXECUTE FUNCTION workflow_events_immutable();
CREATE TRIGGER workflow_events_no_truncate BEFORE TRUNCATE ON workflow_events
  FOR EACH STATEMENT EXECUTE FUNCTION workflow_events_immutable();

-- Record lock: once a version leaves DRAFT, its row can never change again.
-- Attach to any table whose rows are governed by a workflow (key column "id").
CREATE FUNCTION workflow_lock() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE st text;
BEGIN
  SELECT state INTO st FROM workflow_instances
   WHERE table_name = TG_TABLE_NAME AND record_id = OLD.id::text;
  IF st IS NOT NULL AND st <> 'DRAFT' THEN
    RAISE EXCEPTION 'NXGEN-WF-001: % % is % and locked; start a new version to change it', TG_TABLE_NAME, OLD.id, st
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Methods: one series per method, one immutable row per version.
-- ---------------------------------------------------------------------------
CREATE SEQUENCE method_code_seq;
CREATE TABLE methods (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text NOT NULL UNIQUE,
  instrument_type  text NOT NULL CHECK (instrument_type IN ('PH', 'EC', 'TLC', 'OTHER')),
  created_by    text NOT NULL, created_at timestamptz NOT NULL,
  modified_by   text, modified_at timestamptz,
  version_no    integer NOT NULL,
  record_status text NOT NULL DEFAULT 'ACTIVE',
  is_deleted    boolean NOT NULL DEFAULT false, deleted_by text, deleted_at timestamptz
);
CREATE TRIGGER methods_before BEFORE INSERT OR UPDATE OR DELETE ON methods FOR EACH ROW EXECUTE FUNCTION master_before_write();
CREATE TRIGGER methods_audit AFTER INSERT OR UPDATE ON methods FOR EACH ROW EXECUTE FUNCTION master_audit('id');

CREATE TABLE method_versions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  method_id        uuid NOT NULL REFERENCES methods (id),
  version_number   integer NOT NULL CHECK (version_number >= 1),
  name             text NOT NULL CHECK (length(name) BETWEEN 3 AND 200),
  purpose          text NOT NULL DEFAULT '',
  procedure_text   text NOT NULL DEFAULT '',
  parameters       jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(parameters) = 'array'),
  change_summary   text NOT NULL DEFAULT '',
  created_by    text NOT NULL, created_at timestamptz NOT NULL,
  modified_by   text, modified_at timestamptz,
  version_no    integer NOT NULL,
  record_status text NOT NULL DEFAULT 'ACTIVE',
  is_deleted    boolean NOT NULL DEFAULT false, deleted_by text, deleted_at timestamptz,
  UNIQUE (method_id, version_number)
);
CREATE TRIGGER method_versions_lock BEFORE UPDATE OR DELETE ON method_versions FOR EACH ROW EXECUTE FUNCTION workflow_lock();
CREATE TRIGGER method_versions_before BEFORE INSERT OR UPDATE OR DELETE ON method_versions FOR EACH ROW EXECUTE FUNCTION master_before_write();
CREATE TRIGGER method_versions_audit AFTER INSERT OR UPDATE ON method_versions FOR EACH ROW EXECUTE FUNCTION master_audit('id');

-- ---------------------------------------------------------------------------
-- Seeds
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, description) VALUES
  ('methods.view',    'View methods and their approval history'),
  ('methods.edit',    'Create and edit draft methods, submit them for review, start new versions'),
  ('methods.review',  'Review submitted methods (signed)'),
  ('methods.approve', 'Approve, reject and retire methods (signed)');

-- Segregation of duties: nobody gets edit + approve by default.
INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('SUPER_ADMINISTRATOR', 'methods.view'),
  ('QA_MANAGER',  'methods.view'), ('QA_MANAGER',  'methods.review'), ('QA_MANAGER', 'methods.approve'),
  ('QA_REVIEWER', 'methods.view'), ('QA_REVIEWER', 'methods.review'),
  ('ANALYST',     'methods.view'), ('ANALYST',     'methods.edit'),
  ('OPERATOR',    'methods.view'),
  ('AUDITOR',     'methods.view');

INSERT INTO workflow_definitions (code, name, record_table, edit_permission, review_permission, approve_permission,
                                  require_review, independent_reviewer, independent_approver)
VALUES ('METHOD_APPROVAL', 'Method approval', 'method_versions', 'methods.edit', 'methods.review', 'methods.approve',
        true, true, true);

INSERT INTO signature_meanings (code, label, statement) VALUES
  ('REJECTED',    'Rejected',    'I reject this record; it must be corrected before it can be used.'),
  ('INVALIDATED', 'Invalidated', 'I withdraw approval of this record; it must no longer be used.');

-- Workflow steps are always signed (21 CFR 11.50/11.70); meanings are fixed per step.
INSERT INTO signature_policies (action_code, description, required, default_meaning, locked) VALUES
  ('WORKFLOW_SUBMIT',     'Submit a record for review',        true, 'AUTHORED',    true),
  ('WORKFLOW_REVIEW',     'Review a record',                   true, 'REVIEWED',    true),
  ('WORKFLOW_APPROVE',    'Approve a record',                  true, 'APPROVED',    true),
  ('WORKFLOW_REJECT',     'Reject a record',                   true, 'REJECTED',    true),
  ('WORKFLOW_INVALIDATE', 'Withdraw approval of a record',     true, 'INVALIDATED', true);
