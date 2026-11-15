-- Wallet ledger schema.
--
-- ledger   : append-only source of truth, one immutable row per credit/debit.
-- balances : one row per user holding the running total. It is changed in the
--            SAME statement (and therefore the same transaction) as each ledger
--            insert, so it always equals SUM(credits) - SUM(debits).

CREATE TYPE ledger_entry_type AS ENUM ('credit', 'debit');

-- user_id uses COLLATE "C": byte-wise comparison is faster than locale-aware
-- comparison and is all an identifier needs.
CREATE TABLE ledger (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     text COLLATE "C" NOT NULL,
    type        ledger_entry_type NOT NULL,
    amount      bigint NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ledger_amount_range CHECK (amount BETWEEN 1 AND 1000000000)
);

-- The only secondary index on the ledger: serves per-user history and
-- per-user reconciliation. Every extra index would slow down every insert.
CREATE INDEX ledger_user_id_id_idx ON ledger (user_id, id);

CREATE TABLE balances (
    user_id     text COLLATE "C" PRIMARY KEY,
    balance     bigint NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    -- Last line of defence: a negative balance can never be stored.
    CONSTRAINT balances_non_negative CHECK (balance >= 0),
    CONSTRAINT balances_user_id_format CHECK (user_id ~ '^[A-Za-z0-9_-]{1,64}$')
)
WITH (
    -- Leave free space on each page so balance updates can be HOT
    -- (heap-only tuple) updates that do not touch the primary-key index.
    fillfactor = 80,
    -- Rows here are updated constantly; vacuum them early and often.
    autovacuum_vacuum_scale_factor = 0.01,
    autovacuum_analyze_scale_factor = 0.02
);

-- apply_movements: the ONLY write path. Applies a user's credits/debits in
-- order and returns one outcome per movement ('ok', 'insufficient_funds' or
-- 'user_not_found'). Called as a single statement, it is one transaction and
-- one round trip whether it carries 1 movement or a batch of many (per-user
-- group commit: one durable commit covers the whole batch).
--
-- Concurrency (READ COMMITTED): every statement below locks the user's
-- balances row. A concurrent writer waits on that lock, and PostgreSQL then
-- re-evaluates its WHERE clause against the newly committed row, so the
-- conditional debit can never take the balance below zero.
CREATE FUNCTION apply_movements(
    p_user_id text,
    p_types   ledger_entry_type[],
    p_amounts bigint[]
)
RETURNS TABLE (item integer, outcome text, new_balance bigint)
LANGUAGE plpgsql
AS $$
DECLARE
    v_balance bigint;
BEGIN
    IF coalesce(array_length(p_types, 1), 0) <> coalesce(array_length(p_amounts, 1), 0) THEN
        RAISE EXCEPTION 'p_types and p_amounts must have the same length';
    END IF;

    FOR i IN 1 .. coalesce(array_length(p_types, 1), 0) LOOP
        item := i;

        IF p_types[i] = 'credit' THEN
            -- Create the balance row on first credit, otherwise add to it.
            -- ON CONFLICT is race-free for concurrent first credits.
            INSERT INTO balances AS b (user_id, balance)
            VALUES (p_user_id, p_amounts[i])
            ON CONFLICT (user_id) DO UPDATE
                SET balance = b.balance + EXCLUDED.balance,
                    updated_at = now()
            RETURNING b.balance INTO v_balance;

            INSERT INTO ledger (user_id, type, amount) VALUES (p_user_id, 'credit', p_amounts[i]);
            outcome := 'ok';
            new_balance := v_balance;
        ELSE
            -- Check and subtract in ONE atomic UPDATE: no read-then-write gap.
            UPDATE balances AS b
            SET balance = b.balance - p_amounts[i],
                updated_at = now()
            WHERE b.user_id = p_user_id
              AND b.balance >= p_amounts[i]
            RETURNING b.balance INTO v_balance;

            IF FOUND THEN
                INSERT INTO ledger (user_id, type, amount) VALUES (p_user_id, 'debit', p_amounts[i]);
                outcome := 'ok';
                new_balance := v_balance;
            ELSE
                -- Nothing was written. Report why: unknown user or not enough money.
                outcome := CASE
                    WHEN EXISTS (SELECT 1 FROM balances AS b WHERE b.user_id = p_user_id) THEN 'insufficient_funds'
                    ELSE 'user_not_found'
                END;
                new_balance := NULL;
            END IF;
        END IF;

        RETURN NEXT;
    END LOOP;
END;
$$;

-- Immutability: ledger rows can be inserted, never updated, deleted or truncated.
CREATE FUNCTION ledger_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'ledger is append-only: % is not allowed', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER ledger_no_update_delete
    BEFORE UPDATE OR DELETE ON ledger
    FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();

CREATE TRIGGER ledger_no_truncate
    BEFORE TRUNCATE ON ledger
    FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_mutation();
