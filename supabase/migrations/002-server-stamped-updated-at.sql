-- Makes the server, not the device, decide when a row changed.
--
-- Only needed on a project created before this trigger existed. A project set
-- up from schema.sql already has it, and running this there changes nothing.
-- Paste into the Supabase SQL Editor and run.
--
-- Why: a device only downloads rows stamped later than the newest stamp it has
-- already seen. While that stamp came from whichever device made the edit, two
-- devices whose clocks disagreed could leave one of them permanently blind to
-- the other's older edits — silently, because nothing had actually failed.
-- One clock, the server's, removes the possibility.

create or replace function public.stamp_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['collections', 'subcollections', 'cards'] loop
    execute format('drop trigger if exists stamp_updated_at on public.%I', t);
    execute format(
      'create trigger stamp_updated_at before insert or update on public.%I
         for each row execute function public.stamp_updated_at()', t);
  end loop;
end $$;

-- Rows written before the trigger existed keep the stamp their device gave
-- them, and a device running fast may have left some dated in the future. Left
-- alone, those keep every genuine later edit looking older than what a device
-- has already seen. Pulling them back to now costs nothing — the stamp only
-- ever orders changes — and the trigger above supplies the new value.
do $$
declare t text;
begin
  foreach t in array array['collections', 'subcollections', 'cards'] loop
    execute format('update public.%I set updated_at = updated_at where updated_at > now()', t);
  end loop;
end $$;
