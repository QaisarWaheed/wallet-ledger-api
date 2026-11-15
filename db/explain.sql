-- Query plans for credit, debit and get_balance, with real timings.
-- Run: docker compose exec -T db psql -U ledger -d ledger -f /db/explain.sql
--
-- Writes run inside apply_movements, so auto_explain is used to print the
-- plan of every statement executed inside the function. Everything runs in a
-- transaction that is rolled back: no data is changed.
-- user_000001 is the seeded user with the longest history (120,000 rows),
-- to show that history length does not affect any plan.

\pset pager off

BEGIN;

LOAD 'auto_explain';
SET LOCAL auto_explain.log_min_duration = 0;
SET LOCAL auto_explain.log_analyze = on;
SET LOCAL auto_explain.log_buffers = on;
SET LOCAL auto_explain.log_nested_statements = on;
SET LOCAL auto_explain.log_level = notice;   -- send plans to this client, not the server log
SET LOCAL client_min_messages = notice;

\echo '=== credit (existing user): upsert balance + insert ledger row ==='
SELECT * FROM apply_movements('user_000001', ARRAY['credit']::ledger_entry_type[], ARRAY[500]::bigint[]);

\echo '=== debit (enough balance): conditional update + insert ledger row ==='
SELECT * FROM apply_movements('user_000001', ARRAY['debit']::ledger_entry_type[], ARRAY[200]::bigint[]);

\echo '=== debit (insufficient funds): update matches nothing, existence check, nothing written ==='
SELECT * FROM apply_movements('user_000001', ARRAY['debit']::ledger_entry_type[], ARRAY[1000000000]::bigint[]);

ROLLBACK;

\echo '=== get_balance ==='
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT balance FROM balances WHERE user_id = 'user_000001';
