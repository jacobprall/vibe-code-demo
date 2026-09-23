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
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now()
);

-- Keep migrations safe for databases created before these columns existed.
alter table runs add column if not exists progress text;
alter table runs add column if not exists workflow_run_id text;
alter table runs add column if not exists workflow_checked_at timestamptz;

-- Makes the concurrency count in claimRun cheap.
create index if not exists runs_running
    on runs (created_at)
    where status = 'running';

-- One app directory per user per name; a rerun of the same prompt updates it.
create index if not exists runs_user_app
    on runs (user_name, app_name);
