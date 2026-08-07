-- Adds the outline of a non-rectangular card (a list of points), for cards
-- scanned in "Unusual shape" mode. Null for an ordinary rectangular card.
--
-- Only needed on a project created before this column existed. A project set
-- up from schema.sql already has it, and running this there changes nothing.
-- Paste into the Supabase SQL Editor and run.

alter table public.cards
  add column if not exists shape jsonb;
