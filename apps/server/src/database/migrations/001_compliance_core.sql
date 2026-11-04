-- =============================================================================
-- NxGen Compliance Core — 001
-- Audit trail (master spec §6), master-table rules (§8), users & roles (§5).
--
-- Runs with search_path set to the NxGen schema; all names are unqualified.
-- Functions pin their search_path at creation (SET search_path FROM CURRENT).
-- Every write must run inside a transaction that has set nxgen.actor_id via
-- set_config(); anonymous changes are rejected by the triggers below.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Session context helpers
-- ---------------------------------------------------------------------------
CREATE FUNCTION ctx(name text) RETURNS text
LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT nullif(current_setting('nxgen.' || name, true), '')
$$;

CREATE FUNCTION require_actor() RETURNS text
LANGUAGE plpgsql STABLE SET search_path FROM CURRENT AS $$
DECLARE actor text := ctx('actor_id');
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'NXGEN-DB-001: no actor in transaction context; anonymous changes are not permitted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN actor;
END $$;

-- ---------------------------------------------------------------------------
-- Audit trail: append-only, hash-chained, timestamps from the database clock
-- ---------------------------------------------------------------------------
CREATE TABLE audit_trail (
  sequence             bigint       PRIMARY KEY,
  event_id             uuid         NOT NULL UNIQUE,
  occurred_at          timestamptz  NOT NULL,
  category             text         NOT NULL,
  action               text         NOT NULL,
  result               text         NOT NULL CHECK (result IN ('SUCCESS', 'FAILURE', 'INFO')),
  actor_id             text         NOT NULL,
  actor_name           text,
  table_name           text,
  record_id            text,
  old_value            jsonb,
  new_value            jsonb,
  reason               text,
  machine_name         text,
  ip_address           text,
  platform_instance_id text,
  error_code           text,
  details              jsonb,
  prev_hash            text         NOT NULL,
  hash                 text         NOT NULL UNIQUE
);
CREATE INDEX audit_trail_occurred_at_idx ON audit_trail (occurred_at);
CREATE INDEX audit_trail_record_idx ON audit_trail (table_name, record_id);
CREATE INDEX audit_trail_actor_idx ON audit_trail (actor_id);
CREATE INDEX audit_trail_action_idx ON audit_trail (action);

CREATE FUNCTION audit_row_hash(a audit_trail) RETURNS text
LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT encode(sha256(convert_to(concat_ws(E'\x1f',
    a.prev_hash,
    a.sequence::text,
    a.event_id::text,
    to_char(a.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    a.category, a.action, a.result, a.actor_id,
    coalesce(a.actor_name, ''), coalesce(a.table_name, ''), coalesce(a.record_id, ''),
    coalesce(a.old_value::text, ''), coalesce(a.new_value::text, ''),
    coalesce(a.reason, ''), coalesce(a.machine_name, ''), coalesce(a.ip_address, ''),
    coalesce(a.platform_instance_id, ''), coalesce(a.error_code, ''), coalesce(a.details::text, '')
  ), 'UTF8')), 'hex')
$$;

-- Assigns sequence, database timestamp and chain hash. Serialized with an
-- advisory lock so the chain has exactly one successor per record.
CREATE FUNCTION audit_trail_chain() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE last_seq bigint; last_hash text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(current_schema() || '.audit_trail'));
  SELECT sequence, hash INTO last_seq, last_hash FROM audit_trail ORDER BY sequence DESC LIMIT 1;
  NEW.sequence    := coalesce(last_seq, 0) + 1;
  NEW.prev_hash   := coalesce(last_hash, repeat('0', 64));
  NEW.event_id    := coalesce(NEW.event_id, gen_random_uuid());
  NEW.occurred_at := date_trunc('microseconds', clock_timestamp());
  NEW.machine_name := coalesce(NEW.machine_name, ctx('machine_name'));
  NEW.ip_address   := coalesce(NEW.ip_address, ctx('ip_address'));
  NEW.platform_instance_id := coalesce(NEW.platform_instance_id, ctx('platform_instance_id'));
  NEW.hash        := audit_row_hash(NEW);
  RETURN NEW;
END $$;

CREATE FUNCTION audit_trail_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'NXGEN-AUDIT-001: audit trail records cannot be modified or deleted'
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER audit_trail_chain BEFORE INSERT ON audit_trail
  FOR EACH ROW EXECUTE FUNCTION audit_trail_chain();
CREATE TRIGGER audit_trail_no_update BEFORE UPDATE OR DELETE ON audit_trail
  FOR EACH ROW EXECUTE FUNCTION audit_trail_immutable();
CREATE TRIGGER audit_trail_no_truncate BEFORE TRUNCATE ON audit_trail
  FOR EACH STATEMENT EXECUTE FUNCTION audit_trail_immutable();

-- Returns the first sequence whose hash or link does not verify, or NULL if intact.
CREATE FUNCTION verify_audit_chain() RETURNS bigint
LANGUAGE plpgsql STABLE SET search_path FROM CURRENT AS $$
DECLARE r audit_trail; expected_prev text := repeat('0', 64); expected_seq bigint := 1;
BEGIN
  FOR r IN SELECT * FROM audit_trail ORDER BY sequence LOOP
    IF r.sequence <> expected_seq OR r.prev_hash <> expected_prev OR r.hash <> audit_row_hash(r) THEN
      RETURN r.sequence;
    END IF;
    expected_prev := r.hash;
    expected_seq := expected_seq + 1;
  END LOOP;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Master-table rules (§8): standard columns maintained by the database,
-- no physical deletes, every change written to the audit trail.
-- ---------------------------------------------------------------------------
CREATE FUNCTION master_before_write() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE actor text := require_actor();
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'NXGEN-DB-002: physical delete from % is not permitted; use soft delete', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.created_by := actor;
    NEW.created_at := now();
    NEW.modified_by := NULL;
    NEW.modified_at := NULL;
    NEW.version_no := 1;
    NEW.is_deleted := coalesce(NEW.is_deleted, false);
    IF NEW.is_deleted THEN
      RAISE EXCEPTION 'NXGEN-DB-003: records cannot be created in deleted state';
    END IF;
    NEW.deleted_by := NULL;
    NEW.deleted_at := NULL;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'NXGEN-DB-004: creation metadata cannot be changed';
  END IF;
  NEW.version_no := OLD.version_no + 1;
  NEW.modified_by := actor;
  NEW.modified_at := now();
  IF NEW.is_deleted AND NOT OLD.is_deleted THEN
    NEW.deleted_by := actor;
    NEW.deleted_at := now();
  ELSIF NOT NEW.is_deleted THEN
    NEW.deleted_by := NULL;
    NEW.deleted_at := NULL;
  ELSE
    NEW.deleted_by := OLD.deleted_by;
    NEW.deleted_at := OLD.deleted_at;
  END IF;
  RETURN NEW;
END $$;

-- TG_ARGV: key column(s) forming the record_id. Secrets are never copied into the trail.
CREATE FUNCTION master_audit() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  meta    text[] := ARRAY['version_no', 'modified_by', 'modified_at'];
  secrets text[] := ARRAY['password_hash'];
  old_v jsonb; new_v jsonb; rec jsonb; key_parts text[] := '{}'; i int; act text;
BEGIN
  new_v := to_jsonb(NEW) - secrets;
  IF TG_OP = 'UPDATE' THEN
    old_v := to_jsonb(OLD) - secrets;
    IF (old_v - meta) = (new_v - meta) AND (to_jsonb(OLD) ->> 'password_hash') IS NOT DISTINCT FROM (to_jsonb(NEW) ->> 'password_hash') THEN
      RETURN NULL; -- nothing but bookkeeping changed
    END IF;
    IF (to_jsonb(OLD) ->> 'password_hash') IS DISTINCT FROM (to_jsonb(NEW) ->> 'password_hash') THEN
      new_v := new_v || '{"password_changed": true}';
    END IF;
  END IF;

  rec := to_jsonb(NEW);
  FOR i IN 0 .. TG_NARGS - 1 LOOP
    key_parts := key_parts || (rec ->> TG_ARGV[i]);
  END LOOP;

  act := CASE
    WHEN TG_OP = 'INSERT' THEN 'CREATE'
    WHEN NEW.is_deleted AND NOT OLD.is_deleted THEN 'DELETE'
    WHEN OLD.is_deleted AND NOT NEW.is_deleted THEN 'RESTORE'
    ELSE 'UPDATE' END;

  INSERT INTO audit_trail (category, action, result, actor_id, actor_name, table_name, record_id,
                           old_value, new_value, reason)
  VALUES ('DATA', act, 'SUCCESS', require_actor(), ctx('actor_name'), TG_TABLE_NAME,
          array_to_string(key_parts, ':'), old_v, new_v, ctx('reason'));
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Roles & permissions (§5) — RBAC configurable through data, not code
-- ---------------------------------------------------------------------------
CREATE TABLE roles (
  code          text PRIMARY KEY CHECK (code ~ '^[A-Z][A-Z_]{1,40}$'),
  name          text NOT NULL,
  description   text NOT NULL,
  is_system     boolean NOT NULL DEFAULT false,
  created_by    text NOT NULL, created_at timestamptz NOT NULL,
  modified_by   text, modified_at timestamptz,
  version_no    integer NOT NULL,
  record_status text NOT NULL DEFAULT 'ACTIVE',
  is_deleted    boolean NOT NULL DEFAULT false, deleted_by text, deleted_at timestamptz
);

CREATE TABLE permissions (
  code          text PRIMARY KEY CHECK (code ~ '^[a-z][a-z_]*\.[a-z][a-z_]*$'),
  description   text NOT NULL,
  created_by    text NOT NULL, created_at timestamptz NOT NULL,
  modified_by   text, modified_at timestamptz,
  version_no    integer NOT NULL,
  record_status text NOT NULL DEFAULT 'ACTIVE',
  is_deleted    boolean NOT NULL DEFAULT false, deleted_by text, deleted_at timestamptz
);

CREATE TABLE role_permissions (
  role_code       text NOT NULL REFERENCES roles (code),
  permission_code text NOT NULL REFERENCES permissions (code),
  created_by    text NOT NULL, created_at timestamptz NOT NULL,
  modified_by   text, modified_at timestamptz,
  version_no    integer NOT NULL,
  record_status text NOT NULL DEFAULT 'ACTIVE',
  is_deleted    boolean NOT NULL DEFAULT false, deleted_by text, deleted_at timestamptz,
  PRIMARY KEY (role_code, permission_code)
);

-- ---------------------------------------------------------------------------
-- Users (§5). Usernames are unique forever, including deleted users, so an
-- identity is never reused (21 CFR 11.300(a)).
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username             text NOT NULL CHECK (username ~ '^[a-z0-9][a-z0-9._-]{2,31}$'),
  full_name            text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 2 AND 200),
  email                text CHECK (email IS NULL OR email ~ '^[^@\s]+@[^@\s]+$'),
  auth_source          text NOT NULL DEFAULT 'LOCAL' CHECK (auth_source IN ('LOCAL', 'ACTIVE_DIRECTORY', 'LDAP')),
  password_hash        text,
  password_changed_at  timestamptz,
  must_change_password boolean NOT NULL DEFAULT false,
  status               text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_by    text NOT NULL, created_at timestamptz NOT NULL,
  modified_by   text, modified_at timestamptz,
  version_no    integer NOT NULL,
  record_status text NOT NULL DEFAULT 'ACTIVE',
  is_deleted    boolean NOT NULL DEFAULT false, deleted_by text, deleted_at timestamptz
);
CREATE UNIQUE INDEX users_username_uq ON users (username);

CREATE TABLE user_roles (
  user_id   uuid NOT NULL REFERENCES users (id),
  role_code text NOT NULL REFERENCES roles (code),
  created_by    text NOT NULL, created_at timestamptz NOT NULL,
  modified_by   text, modified_at timestamptz,
  version_no    integer NOT NULL,
  record_status text NOT NULL DEFAULT 'ACTIVE',
  is_deleted    boolean NOT NULL DEFAULT false, deleted_by text, deleted_at timestamptz,
  PRIMARY KEY (user_id, role_code)
);

-- Operational security state, kept out of the master record so routine login
-- bookkeeping does not create version churn. Lockouts are audited explicitly.
CREATE TABLE user_security_state (
  user_id              uuid PRIMARY KEY REFERENCES users (id),
  failed_login_count   integer NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  last_login_at        timestamptz,
  last_failed_login_at timestamptz
);

-- Previous password hashes, to prevent reuse. Append-only.
CREATE TABLE password_history (
  id            bigserial PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users (id),
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER password_history_no_update BEFORE UPDATE OR DELETE ON password_history
  FOR EACH ROW EXECUTE FUNCTION audit_trail_immutable();

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id),
  token_hash   text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  ip_address   text,
  machine_name text,
  user_agent   text,
  ended_at     timestamptz,
  end_reason   text
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE ended_at IS NULL;

-- Attach master-table triggers
CREATE TRIGGER roles_before BEFORE INSERT OR UPDATE OR DELETE ON roles FOR EACH ROW EXECUTE FUNCTION master_before_write();
CREATE TRIGGER roles_audit AFTER INSERT OR UPDATE ON roles FOR EACH ROW EXECUTE FUNCTION master_audit('code');
CREATE TRIGGER permissions_before BEFORE INSERT OR UPDATE OR DELETE ON permissions FOR EACH ROW EXECUTE FUNCTION master_before_write();
CREATE TRIGGER permissions_audit AFTER INSERT OR UPDATE ON permissions FOR EACH ROW EXECUTE FUNCTION master_audit('code');
CREATE TRIGGER role_permissions_before BEFORE INSERT OR UPDATE OR DELETE ON role_permissions FOR EACH ROW EXECUTE FUNCTION master_before_write();
CREATE TRIGGER role_permissions_audit AFTER INSERT OR UPDATE ON role_permissions FOR EACH ROW EXECUTE FUNCTION master_audit('role_code', 'permission_code');
CREATE TRIGGER users_before BEFORE INSERT OR UPDATE OR DELETE ON users FOR EACH ROW EXECUTE FUNCTION master_before_write();
CREATE TRIGGER users_audit AFTER INSERT OR UPDATE ON users FOR EACH ROW EXECUTE FUNCTION master_audit('id');
CREATE TRIGGER user_roles_before BEFORE INSERT OR UPDATE OR DELETE ON user_roles FOR EACH ROW EXECUTE FUNCTION master_before_write();
CREATE TRIGGER user_roles_audit AFTER INSERT OR UPDATE ON user_roles FOR EACH ROW EXECUTE FUNCTION master_audit('user_id', 'role_code');

-- ---------------------------------------------------------------------------
-- Seed data (runs as SYSTEM_MIGRATION, so it is itself audited)
-- ---------------------------------------------------------------------------
INSERT INTO roles (code, name, description, is_system) VALUES
  ('SUPER_ADMINISTRATOR', 'Super Administrator', 'Full platform administration, including user and role management.', true),
  ('IT_ADMINISTRATOR',    'IT Administrator',    'Infrastructure, licensing, backup and user account administration.', true),
  ('QA_MANAGER',          'QA Manager',          'Quality oversight, approvals and release decisions.', true),
  ('QA_REVIEWER',         'QA Reviewer',         'Reviews results and audit trails.', true),
  ('ANALYST',             'Analyst',             'Performs analyses and records results.', true),
  ('OPERATOR',            'Operator',            'Operates instruments and acquires data.', true),
  ('AUDITOR',             'Auditor',             'Read-only access to records and audit trails.', true);

INSERT INTO permissions (code, description) VALUES
  ('system.view',      'View System Information'),
  ('licensing.manage', 'Generate activation requests and re-activate the platform'),
  ('users.view',       'View user accounts and role assignments'),
  ('users.manage',     'Create, disable, unlock users and assign roles'),
  ('audit.view',       'View and export the audit trail');

INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('SUPER_ADMINISTRATOR', 'system.view'), ('SUPER_ADMINISTRATOR', 'licensing.manage'),
  ('SUPER_ADMINISTRATOR', 'users.view'),  ('SUPER_ADMINISTRATOR', 'users.manage'),
  ('SUPER_ADMINISTRATOR', 'audit.view'),
  ('IT_ADMINISTRATOR', 'system.view'), ('IT_ADMINISTRATOR', 'licensing.manage'),
  ('IT_ADMINISTRATOR', 'users.view'),  ('IT_ADMINISTRATOR', 'users.manage'),
  ('QA_MANAGER', 'system.view'), ('QA_MANAGER', 'users.view'), ('QA_MANAGER', 'audit.view'),
  ('QA_REVIEWER', 'audit.view'),
  ('AUDITOR', 'system.view'), ('AUDITOR', 'users.view'), ('AUDITOR', 'audit.view');
