-- =============================================================================
-- NxGen Compliance Core — 004
-- Sign-in by username OR email. An email can then identify exactly one
-- account, so it must be unique (case-insensitive). Usernames never contain
-- "@", so the two identifiers can never collide.
-- =============================================================================

CREATE UNIQUE INDEX users_email_unique_idx ON users (lower(email)) WHERE email IS NOT NULL;
