create table if not exists runs (
    id               text primary key,
    -- Supplied by the caller or derived from the run id. Unique, so a retried
    -- curl cannot start a second run.
    idempotency_key  text        not null unique,
    prompt           text        not null,
    -- Namespace the generated app is filed under in the apps repository.
    user_name        text        not null,
    status           text        not null default 'running',
    -- Where the run is right now, for GET /v1/apps/:runId.
    stage            text,
    progress         text,
    -- The Workflows task run that owns the status: prompt-to-app while the
    -- run is running, and delete-app while its app is deleting.
    workflow_run_id  text,
    workflow_checked_at timestamptz,
    app_name         text,
    web_url          text,
    api_url          text,
    -- Path of the app's own Blueprint inside the apps repository.
    blueprint_path   text,
    summary          text,
    -- The sandbox of the run and its sandbox group, for the link to the
    -- sandbox in the Render Dashboard.
    sandbox_id       text,
    sandbox_group_id text,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    -- When the run stopped. The UI shows how long it took. A delete changes
    -- updated_at, so updated_at cannot tell.
    finished_at      timestamptz
);

-- Keep migrations safe for databases created before these columns existed.
alter table runs add column if not exists progress text;
alter table runs add column if not exists workflow_run_id text;
alter table runs add column if not exists workflow_checked_at timestamptz;
alter table runs add column if not exists sandbox_id text;
alter table runs add column if not exists sandbox_group_id text;
alter table runs add column if not exists finished_at timestamptz;

-- A run that stopped before finished_at existed stopped when it was last
-- updated. A run that a delete changed after that gets no time.
update runs set finished_at = updated_at
 where finished_at is null
   and status in ('deployed', 'awaiting_blueprint', 'build_failed', 'deploy_failed', 'failed');

-- Makes the concurrency count in claimRun cheap.
create index if not exists runs_running
    on runs (created_at)
    where status = 'running';

-- One app directory per user per name; a rerun of the same prompt updates it.
create index if not exists runs_user_app
    on runs (user_name, app_name);
