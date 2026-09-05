-- Idempotent, and never empty: verification calls the data endpoint and fails
-- the run when it comes back with no rows, because an app that deploys against
-- an unseeded database renders a blank page.
--
-- Replace these rows with the real catalog from the brief. Keep the conflict
-- clause: this runs on every deploy.
insert into items (slug, name, description, price_cents, image_path)
values
    ('example-one', 'Example One', 'Replace this row with real content.', 4900, null),
    ('example-two', 'Example Two', 'Replace this row with real content.', 12900, null)
on conflict (slug) do nothing;
