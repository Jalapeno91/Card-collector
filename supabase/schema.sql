-- The Ledger — Supabase schema.
--
-- Paste this whole file into the SQL Editor of a new Supabase project and run
-- it once. It is idempotent, so re-running it is safe.
--
-- Design notes:
--   * Row ids are generated on the device, so the primary key is
--     (user_id, id): two accounts can never collide, and PostgREST can upsert
--     on that key directly.
--   * Deletes are soft (deleted_at). A hard delete would be invisible to a
--     device that was offline when it happened.
--   * There are deliberately no foreign keys between the three tables. Rows
--     sync independently and can legitimately arrive out of order; an FK would
--     turn that into a failed sync instead of a moment of inconsistency that
--     resolves itself on the next pull.
--   * updated_at is written by the client, because it is the value the
--     last-write-wins merge compares. Devices with automatic clocks agree
--     closely enough; a device with a badly wrong clock would win or lose
--     conflicts unfairly.

/* ── tables ─────────────────────────────────────────────────────────────── */

create table if not exists public.collections (
  id              text        not null,
  user_id         uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  name            text        not null default '',
  color           text        not null default '#c9a227',
  has_logo        boolean     not null default false,
  logo_updated_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  primary key (user_id, id)
);

create table if not exists public.subcollections (
  id                   text        not null,
  user_id              uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  collection_id        text,
  name                 text        not null default '',
  total_in_set         integer,
  rarities             jsonb       not null default '[]'::jsonb,
  has_box_photo        boolean     not null default false,
  box_photo_updated_at timestamptz,
  position             integer     not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz,
  primary key (user_id, id)
);

create table if not exists public.cards (
  id                     text        not null,
  user_id                uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  subcollection_id       text,
  name                   text        not null default '',
  rarity                 text        not null default '',
  number                 integer,
  qty                    integer     not null default 0,
  effect                 text        not null default 'matte',
  condition              text        not null default '',
  notes                  text        not null default '',
  linked_slots           jsonb       not null default '[]'::jsonb,
  has_photo              boolean     not null default false,
  photo_updated_at       timestamptz,
  has_back_photo         boolean     not null default false,
  back_photo_updated_at  timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  deleted_at             timestamptz,
  primary key (user_id, id)
);

-- The pull query is always "my rows changed since X".
create index if not exists collections_sync_idx    on public.collections    (user_id, updated_at);
create index if not exists subcollections_sync_idx on public.subcollections (user_id, updated_at);
create index if not exists cards_sync_idx          on public.cards          (user_id, updated_at);
create index if not exists subcollections_parent_idx on public.subcollections (user_id, collection_id);
create index if not exists cards_parent_idx          on public.cards          (user_id, subcollection_id);

/* ── privileges ─────────────────────────────────────────────────────────── */

-- Granted explicitly rather than relying on the project's "automatically
-- expose new tables" setting, so this schema works with that turned off (which
-- is what Supabase recommends).
--
-- Only `authenticated` is granted anything. The app signs in before it makes a
-- single REST call, so the anonymous role has no reason to reach these tables;
-- revoking is belt-and-braces alongside the policies below.
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.collections    to authenticated;
grant select, insert, update, delete on public.subcollections to authenticated;
grant select, insert, update, delete on public.cards          to authenticated;

revoke all on public.collections    from anon;
revoke all on public.subcollections from anon;
revoke all on public.cards          from anon;

/* ── row level security ─────────────────────────────────────────────────── */

alter table public.collections    enable row level security;
alter table public.subcollections enable row level security;
alter table public.cards          enable row level security;

do $$
declare t text;
begin
  foreach t in array array['collections', 'subcollections', 'cards'] loop
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format($f$
      create policy "own rows" on public.%I
        for all
        to authenticated
        using (user_id = auth.uid())
        with check (user_id = auth.uid())
    $f$, t);
  end loop;
end $$;

/* ── photo storage ──────────────────────────────────────────────────────── */

-- Private bucket; every object lives under a folder named for its owner's id.
insert into storage.buckets (id, name, public)
values ('card-photos', 'card-photos', false)
on conflict (id) do nothing;

drop policy if exists "own photos" on storage.objects;
create policy "own photos" on storage.objects
  for all
  to authenticated
  using (bucket_id = 'card-photos' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'card-photos' and (storage.foldername(name))[1] = auth.uid()::text);
