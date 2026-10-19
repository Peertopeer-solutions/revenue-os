-- 023 — the worker's database login cuts off long queries, lock waits and idle transactions (ROADMAP.md, Slice 1:
-- "A slow or stuck AI model, dialer or WhatsApp service can't freeze the worker"). app_service is the login the worker
-- and its job runner connect as (migration 010), so a query that runs away, a wait on a row another transaction holds,
-- or a transaction left open while nothing happens ends with an error on its own, instead of holding a connection and
-- its locks for ever: the job fails and pg-boss runs it again. The worker opens no transaction across a call to an
-- outside service (services/worker/src/sends.ts, packages/harness/src/loop.ts), so its own transactions finish in
-- well under a second, and the longest query the API runs (a company's metrics) takes a fraction of the 30 seconds.
-- A role's settings apply to each connection opened after this; a connection already open keeps what it had.
alter role app_service set statement_timeout = '30s';
alter role app_service set lock_timeout = '10s';
alter role app_service set idle_in_transaction_session_timeout = '60s';
