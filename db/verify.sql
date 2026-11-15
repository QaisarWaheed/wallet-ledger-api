-- Full consistency check (the same kind of SQL reviewers run after a load test).
-- Run: docker compose exec -T db psql -U ledger -d ledger -f /db/verify.sql
-- Every count below must be 0.

\timing on

-- 1. Every balance equals SUM(credits) - SUM(debits), and every ledger user
--    has a balance row (FULL JOIN also catches rows missing on either side).
SELECT count(*) AS balance_ledger_mismatches
FROM balances AS b
FULL JOIN (
    SELECT user_id, sum(CASE WHEN type = 'credit' THEN amount ELSE -amount END) AS ledger_balance
    FROM ledger
    GROUP BY user_id
) AS l USING (user_id)
WHERE b.balance IS DISTINCT FROM l.ledger_balance;

-- 2. No stored balance is negative.
SELECT count(*) AS negative_balances
FROM balances
WHERE balance < 0;

-- 3. No user's running balance ever dipped below 0, in ledger (id) order.
SELECT count(*) AS users_ever_negative
FROM (
    SELECT user_id,
           sum(CASE WHEN type = 'credit' THEN amount ELSE -amount END)
               OVER (PARTITION BY user_id ORDER BY id) AS running_balance
    FROM ledger
) AS history
WHERE running_balance < 0;

-- 4. Ledger rows obey the amount rule.
SELECT count(*) AS invalid_amounts
FROM ledger
WHERE amount < 1 OR amount > 1000000000;
