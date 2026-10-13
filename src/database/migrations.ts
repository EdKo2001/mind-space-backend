/** Versioned additive schema for internal-profile session metadata; no conversation/audio columns. */
export const migrationVersion = 2;
export function migrationSql(schema: string) {
  return `
CREATE TABLE IF NOT EXISTS ${schema}.accounts (
  account_id text PRIMARY KEY, allowed boolean NOT NULL, available_credits bigint NOT NULL CHECK (available_credits >= 0),
  profile text NOT NULL DEFAULT 'internal-test-v1' CHECK (profile = 'internal-test-v1')
);
CREATE TABLE IF NOT EXISTS ${schema}.sessions (
  session_id text PRIMARY KEY, account_id text NOT NULL REFERENCES ${schema}.accounts(account_id),
  snapshot jsonb NOT NULL CHECK (snapshot->>'profile' = 'internal-test-v1'),
  duration_ms integer NOT NULL CHECK (duration_ms IN (600000,2700000)), next_segment_index integer NOT NULL CHECK (next_segment_index >= 0)
);
CREATE INDEX IF NOT EXISTS sessions_account ON ${schema}.sessions(account_id);
CREATE INDEX IF NOT EXISTS sessions_preparation_expiry ON ${schema}.sessions(((snapshot->>'reservationExpiresAt')::bigint)) WHERE snapshot->>'lifecycle'='preparing';
CREATE INDEX IF NOT EXISTS sessions_active_deadline ON ${schema}.sessions(((snapshot->>'endsAt')::bigint)) WHERE snapshot->>'lifecycle'='active';
CREATE TABLE IF NOT EXISTS ${schema}.commands (
  command_key text PRIMARY KEY, account_id text NOT NULL REFERENCES ${schema}.accounts(account_id),
  session_id text NOT NULL REFERENCES ${schema}.sessions(session_id), record jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS commands_account ON ${schema}.commands(account_id);
CREATE TABLE IF NOT EXISTS ${schema}.ledger (
  ledger_offset bigint GENERATED ALWAYS AS IDENTITY UNIQUE, entry_id text PRIMARY KEY, account_id text NOT NULL REFERENCES ${schema}.accounts(account_id),
  session_id text NOT NULL REFERENCES ${schema}.sessions(session_id), effect text NOT NULL CHECK (effect IN ('reserved','consumed','released')),
  available_delta integer NOT NULL, recorded_at bigint NOT NULL, UNIQUE(session_id,effect),
  CHECK ((effect='reserved' AND available_delta=-1) OR (effect='consumed' AND available_delta=0) OR (effect='released' AND available_delta=1))
);
CREATE INDEX IF NOT EXISTS ledger_account ON ${schema}.ledger(account_id);
CREATE TABLE IF NOT EXISTS ${schema}.utterances (
  session_id text NOT NULL REFERENCES ${schema}.sessions(session_id), utterance_id text NOT NULL,
  fingerprint text NOT NULL, response_authorization jsonb NOT NULL, PRIMARY KEY(session_id,utterance_id)
);
CREATE TABLE IF NOT EXISTS ${schema}.segments (
  session_id text NOT NULL REFERENCES ${schema}.sessions(session_id), segment_id text NOT NULL,
  metadata jsonb NOT NULL, PRIMARY KEY(session_id,segment_id)
);
CREATE TABLE IF NOT EXISTS ${schema}.events (
  event_id text PRIMARY KEY, session_id text NOT NULL REFERENCES ${schema}.sessions(session_id), sequence bigint NOT NULL,
  payload jsonb NOT NULL CHECK (NOT payload ? 'speech'), UNIQUE(session_id,sequence)
);
CREATE TABLE IF NOT EXISTS ${schema}.outbox (
  event_id text PRIMARY KEY, session_id text NOT NULL REFERENCES ${schema}.sessions(session_id), sequence bigint NOT NULL,
  payload jsonb NOT NULL CHECK (NOT payload ? 'speech'), created_at timestamptz NOT NULL DEFAULT NOW(),
  claim_token text, claim_until timestamptz, delivered_at timestamptz, completion text CHECK(completion IN ('published','superseded')), UNIQUE(session_id,sequence)
);
CREATE INDEX IF NOT EXISTS outbox_pending ON ${schema}.outbox(session_id,sequence) WHERE delivered_at IS NULL;
CREATE OR REPLACE FUNCTION ${schema}.immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Immutable accounting/command record' USING ERRCODE='55000'; END $$;
DROP TRIGGER IF EXISTS ledger_immutable ON ${schema}.ledger;
CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON ${schema}.ledger FOR EACH ROW EXECUTE FUNCTION ${schema}.immutable_record();
DROP TRIGGER IF EXISTS commands_immutable ON ${schema}.commands;
CREATE TRIGGER commands_immutable BEFORE UPDATE OR DELETE ON ${schema}.commands FOR EACH ROW EXECUTE FUNCTION ${schema}.immutable_record();
`;
}

/** Keep version-1 SQL byte-for-byte stable after application; later changes are additive. */
export function migrations(schema: string) {
  return [
    { version: 1, sql: migrationSql(schema) },
    { version: 2, sql: `CREATE INDEX IF NOT EXISTS outbox_terminal_observation ON ${schema}.outbox(session_id,created_at)
WHERE payload->'snapshot'->>'lifecycle'='ended' AND payload->'snapshot'->>'accounting'='consumed';` },
  ];
}
