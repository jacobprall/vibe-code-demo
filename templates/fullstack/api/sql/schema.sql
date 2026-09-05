-- Idempotent: this runs before every deploy, not just the first.
create table if not exists items (
    id           serial primary key,
    slug         text        not null unique,
    name         text        not null,
    description  text        not null,
    price_cents  integer     not null,
    image_path   text,
    created_at   timestamptz not null default now()
);
