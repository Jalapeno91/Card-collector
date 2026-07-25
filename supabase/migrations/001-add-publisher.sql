-- Adds the publisher of a collection (Panini, Topps, Bandai …).
--
-- Only needed on a project created before this column existed. A project set
-- up from schema.sql already has it, and running this there changes nothing.
-- Paste into the Supabase SQL Editor and run.

alter table public.collections
  add column if not exists publisher text not null default '';
