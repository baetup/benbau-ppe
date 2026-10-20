-- =====================================================================
-- Benbau PPE Tracker — Supabase database setup
-- Paste this whole file into Supabase > SQL Editor > New query > Run.
-- Safe to run again: it only creates what is missing and replaces functions.
-- =====================================================================

-- ---------- tables ----------

-- Who may use the app. Add one row per person after creating their login
-- (Authentication > Users > Add user). The name is shown as "Handed out by".
create table if not exists public.staff (
  email      text primary key,
  name       text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.locations (
  id         bigint generated always as identity primary key,
  title      text not null,
  country    text not null default 'DK',
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.products (
  id         bigint generated always as identity primary key,
  title      text not null,
  sizes      text not null default 'OneSize',   -- comma separated, e.g. "S, M, L, XL"
  image_url  text,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.stock (
  id          bigint generated always as identity primary key,
  product_id  bigint not null references public.products(id) on delete cascade,
  size        text   not null,
  location_id bigint not null references public.locations(id) on delete cascade,
  quantity    integer not null default 0,
  updated_at  timestamptz not null default now(),
  unique (product_id, size, location_id)
);
create index if not exists stock_location_idx on public.stock (location_id);

create table if not exists public.personnel (
  id            bigint generated always as identity primary key,
  title         text not null,                  -- full name
  email         text,
  phone         text,
  company       text,
  employee_no   text,
  location_id   bigint references public.locations(id) on delete set null,
  location_name text,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- Clothing sizes on the person's profile (added later, so also for existing databases).
alter table public.personnel
  add column if not exists boots_size   text,
  add column if not exists jacket_size  text,
  add column if not exists trouser_size text,
  add column if not exists vest_size    text,
  add column if not exists gloves_size  text;

-- All clothing sizes of a person in one field, e.g. {"Boots": "44", "Jacket": "M", "Helmet": "55-62"}.
-- The size types are set in config.js (sizeTypes). The first time, the old size columns are copied in.
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'personnel' and column_name = 'size_profile') then
    alter table public.personnel add column size_profile jsonb not null default '{}'::jsonb;
    update public.personnel set size_profile = jsonb_strip_nulls(jsonb_build_object(
      'Boots', nullif(trim(boots_size), ''), 'Jacket', nullif(trim(jacket_size), ''),
      'Trousers', nullif(trim(trouser_size), ''), 'Vest', nullif(trim(vest_size), ''),
      'Gloves', nullif(trim(gloves_size), '')));
  end if;
end $$;

create table if not exists public.handouts (
  id                  bigint generated always as identity primary key,
  batch_id            uuid not null,
  personnel_id        bigint references public.personnel(id) on delete set null,
  personnel_name      text,
  product_id          bigint references public.products(id) on delete set null,
  title               text not null,            -- product name at the time of handout
  size                text not null,
  quantity            integer not null check (quantity > 0),
  location_id         bigint references public.locations(id) on delete set null,
  location_name       text,
  reason              text,
  notes               text,
  handout_date        timestamptz not null default now(),
  handed_out_by       text,
  handed_out_by_email text,
  signature           text,                     -- PNG data URL
  created_at          timestamptz not null default now()
);
create index if not exists handouts_personnel_idx on public.handouts (personnel_id);
create index if not exists handouts_batch_idx on public.handouts (batch_id);
create index if not exists handouts_date_idx on public.handouts (handout_date desc);
create index if not exists handouts_location_idx on public.handouts (location_id);
create index if not exists handouts_product_idx on public.handouts (product_id);

create table if not exists public.transfers (
  id                 bigint generated always as identity primary key,
  product_id         bigint references public.products(id) on delete set null,
  title              text,
  size               text,
  quantity           integer not null check (quantity > 0),
  from_location_id   bigint references public.locations(id) on delete set null,
  from_location_name text,
  to_location_id     bigint references public.locations(id) on delete set null,
  to_location_name   text,
  reason             text,
  transfer_date      timestamptz not null default now(),
  transferred_by     text,
  created_at         timestamptz not null default now()
);

-- Incidents / NCRs / policy violations reported on site.
create table if not exists public.incidents (
  id               bigint generated always as identity primary key,
  incident_date    timestamptz not null default now(),
  personnel_id     bigint references public.personnel(id) on delete set null,
  personnel_name   text not null,
  branch           text,                        -- company / subcontractor, e.g. Benbau, HIROS
  location_id      bigint references public.locations(id) on delete set null,
  location_name    text,
  type             text not null,               -- Health and Safety, Quality, Other Policy
  description      text not null,
  action_taken     text,                        -- General NCR, Verbal Coaching, Yellow Card, Red Card
  breach_count     integer not null default 1,  -- times this person breached this type of policy
  reported_by      text,
  witnesses        text,
  status           text not null default 'Open',
  follow_up        text,
  closed_at        timestamptz,
  closed_by        text,
  evidence         jsonb not null default '[]'::jsonb,   -- [{ path, name, type }] in the "evidence" storage bucket
  signature        text,                        -- worker acknowledgement (PNG data URL), optional
  created_by       text,
  created_by_email text,
  created_at       timestamptz not null default now()
);
create index if not exists incidents_date_idx on public.incidents (incident_date desc);
create index if not exists incidents_personnel_idx on public.incidents (personnel_id);
create index if not exists incidents_location_idx on public.incidents (location_id);

-- ---------- returns, rotation and orders (added later, so written as "add if missing") ----------
alter table public.personnel
  add column if not exists in_rotation       boolean not null default false,  -- subcontractor worker away on rotation
  add column if not exists status_changed_at timestamptz;
alter table public.products
  add column if not exists size_type  text,                             -- Boots, Jacket, Trousers, Vest, Gloves (for Orders)
  add column if not exists returnable boolean not null default true;    -- false for consumables (not counted as lost)
alter table public.stock
  add column if not exists returned_quantity integer not null default 0;  -- part of quantity that is returned (used) PPE
-- Product category: 'regular' PPE (jackets, trousers, boots…) or 'consumable' (gloves, ear plugs…).
-- Consumables are not counted as lost / rotation PPE. Products that had "Track returns" off become consumables.
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name = 'category') then
    alter table public.products add column category text not null default 'regular';
    update public.products set category = 'consumable' where returnable = false;
  end if;
end $$;
alter table public.handouts
  add column if not exists returned_quantity integer not null default 0,  -- how many of this handout came back
  add column if not exists from_returned     integer not null default 0;  -- how many were handed out from returned stock

-- Products belong to one country (different products / standards per country).
-- The first time: a product used in one country gets that country; a product used in several countries
-- is split into one copy per country, and each country's stock, handouts, returns and log move to its copy.
-- Unused products get the country with the most locations.
do $$
declare
  r     record;
  i     integer;
  v_new bigint;
  v_loc bigint[];
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name = 'country') then
    alter table public.products add column country text;
    for r in
      select p.id, array_agg(distinct l.country order by l.country) as countries
      from public.products p
      join (select product_id, location_id from public.stock
            union select product_id, location_id from public.handouts where product_id is not null) u on u.product_id = p.id
      join public.locations l on l.id = u.location_id
      group by p.id
    loop
      update public.products set country = r.countries[1] where id = r.id;
      for i in 2 .. coalesce(array_length(r.countries, 1), 1) loop
        insert into public.products (title, sizes, image_url, active, size_type, returnable, category, country)
        select title, sizes, image_url, active, size_type, returnable, category, r.countries[i]
        from public.products where id = r.id
        returning id into v_new;
        v_loc := array(select id from public.locations where country = r.countries[i]);
        update public.stock     set product_id = v_new where product_id = r.id and location_id = any (v_loc);
        update public.handouts  set product_id = v_new where product_id = r.id and location_id = any (v_loc);
        update public.stock_log set product_id = v_new where product_id = r.id and location_id = any (v_loc);
        update public.returns   set product_id = v_new where product_id = r.id and location_id = any (v_loc);
        update public.transfers set product_id = v_new where product_id = r.id and from_location_id = any (v_loc);
      end loop;
    end loop;
    update public.products
    set country = coalesce((select country from public.locations group by country order by count(*) desc, country limit 1), 'DK')
    where country is null;
  end if;
end $$;

-- Inventory lists managed by admins and leads, per country:
--   list = 'type'   (Jackets, Vests…; kind = 'regular' or 'consumable') — the cards in the Inventory tab
--   list = 'season' (Summer, Winter, Rain, All season)
create table if not exists public.catalog_options (
  id         bigint generated always as identity primary key,
  list       text not null check (list in ('type', 'season')),
  title      text not null,
  kind       text,                       -- types only: 'regular' or 'consumable'
  country    text not null,
  image_url  text,                       -- optional picture for a type card
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
alter table public.products
  add column if not exists type_id   bigint references public.catalog_options(id) on delete set null,
  add column if not exists season_id bigint references public.catalog_options(id) on delete set null;

-- PPE given back by a worker (e.g. when leaving). to_stock = put back into stock as returned PPE.
create table if not exists public.returns (
  id                bigint generated always as identity primary key,
  return_date       timestamptz not null default now(),
  handout_id        bigint references public.handouts(id) on delete set null,
  personnel_id      bigint references public.personnel(id) on delete set null,
  personnel_name    text,
  company           text,
  product_id        bigint references public.products(id) on delete set null,
  title             text,
  size              text,
  quantity          integer not null check (quantity > 0),
  location_id       bigint references public.locations(id) on delete set null,
  location_name     text,
  to_stock          boolean not null default true,
  note              text,
  received_by       text,
  received_by_email text
);
create index if not exists returns_personnel_idx on public.returns (personnel_id);
create index if not exists returns_date_idx on public.returns (return_date desc);

-- Every change of a stock quantity, written automatically by a trigger on the stock table.
-- Staff can only read it; nobody can change or delete entries from the app.
create table if not exists public.stock_log (
  id               bigint generated always as identity primary key,
  changed_at       timestamptz not null default now(),
  product_id       bigint references public.products(id) on delete set null,
  product_title    text,
  size             text not null,
  location_id      bigint references public.locations(id) on delete set null,
  location_name    text,
  old_quantity     integer not null,
  new_quantity     integer not null,
  change           integer generated always as (new_quantity - old_quantity) stored,
  source           text not null,      -- Manual edit, Handout, Transfer, Handout deleted, Size exchange, Database edit
  note             text,
  changed_by       text,
  changed_by_email text
);
create index if not exists stock_log_date_idx on public.stock_log (changed_at desc);
create index if not exists stock_log_location_idx on public.stock_log (location_id);
create index if not exists stock_log_product_idx on public.stock_log (product_id);

-- ---------- user roles ----------
-- role: 'admin' (all countries), 'lead' (all locations in `country`), 'officer' (works only at `location_id`).
-- Users who existed before roles were added become admin; new users default to officer.
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'staff' and column_name = 'role') then
    alter table public.staff add column role text not null default 'admin';
    alter table public.staff alter column role set default 'officer';
  end if;
end $$;
alter table public.staff
  add column if not exists country     text,
  add column if not exists location_id bigint references public.locations(id) on delete set null;

-- Every staff row must be complete: a known role, a country for leads, a location for officers.
-- New and changed rows are always checked. If older rows break a rule, the script reports them
-- (NOTICE) instead of failing; fix them with the query in the notice and run the script again.
do $$
declare c record;
begin
  for c in select * from (values
      ('staff_role_check',            'check (role in (''admin'', ''lead'', ''officer''))'),
      ('staff_lead_country_check',    'check (role <> ''lead'' or country is not null)'),
      ('staff_officer_location_check','check (role <> ''officer'' or location_id is not null)')) v(name, def)
  loop
    if not exists (select 1 from pg_constraint where conname = c.name and conrelid = 'public.staff'::regclass) then
      execute format('alter table public.staff add constraint %I %s not valid', c.name, c.def);
    end if;
    begin
      execute format('alter table public.staff validate constraint %I', c.name);
    exception when check_violation then
      raise notice 'Staff rows break rule %: select * from public.staff where not (%);', c.name, substr(c.def, 7);
    end;
  end loop;
  -- A location cannot be deleted while a staff member is assigned to it (it used to leave the officer
  -- without a location). Deactivate locations instead of deleting them.
  if not exists (select 1 from pg_constraint where conname = 'staff_location_fk_restrict') then
    alter table public.staff drop constraint if exists staff_location_id_fkey;
    alter table public.staff add constraint staff_location_fk_restrict
      foreign key (location_id) references public.locations(id) on delete restrict;
  end if;
end $$;

-- ---------- products always have a country ----------
-- Products belong to one country. A product without a country would escape the country rules.
update public.products set country = 'DK' where country is null;
alter table public.products alter column country set not null;

-- ---------- history tables written only by the database ----------
-- Signatures that were replaced (size exchange) or whose handout was deleted. Nothing is ever lost.
create table if not exists public.signature_history (
  id                bigint generated always as identity primary key,
  archived_at       timestamptz not null default now(),
  event             text not null,           -- 'Replaced by size exchange', 'Handout deleted'
  handout_id        bigint,                  -- no foreign key: history must survive deletions
  batch_id          uuid,
  personnel_id      bigint,
  personnel_name    text,
  title             text,
  size              text,
  quantity          integer,
  location_id       bigint,
  location_name     text,
  signed_on         timestamptz,             -- handout date the signature belonged to
  signature         text not null,
  archived_by       text,
  archived_by_email text
);

-- Every change to the main records: who, when, what, before and after. Admins can read it; nobody can change it.
create table if not exists public.audit_log (
  id             bigint generated always as identity primary key,
  occurred_at    timestamptz not null default now(),
  txid           bigint not null default txid_current(),
  actor_email    text,
  actor_name     text,
  actor_role     text,
  action         text not null,            -- INSERT / UPDATE / DELETE
  table_name     text not null,
  record_id      bigint,
  changed_fields jsonb,                    -- array of changed column names (UPDATE)
  old_values     jsonb,
  new_values     jsonb,
  reason         text
);
create index if not exists audit_log_date_idx on public.audit_log (occurred_at desc);
create index if not exists audit_log_record_idx on public.audit_log (table_name, record_id);

-- The stock log keeps its history when a product or location is deleted (ids and names stay as they were).
-- This removes the database link to products / locations on purpose.
alter table public.stock_log drop constraint if exists stock_log_product_id_fkey;
alter table public.stock_log drop constraint if exists stock_log_location_id_fkey;

-- ---------- security helpers ----------
-- All helpers answer a clear true or false (never "unknown"), and deny anything that is not fully set up.
-- Internal helpers live in the schema app_internal, which the REST API does not expose.
create schema if not exists app_internal;
revoke all on schema app_internal from public, anon, authenticated;

-- True when the signed-in user's email is in the staff table.
create or replace function public.is_staff()
returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(exists (
    select 1 from public.staff
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  ), false);
$$;

-- True when the signed-in user is an admin.
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(exists (
    select 1 from public.staff
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')) and role = 'admin'
  ), false);
$$;

-- The signed-in user's country (leads and officers), or null.
create or replace function public.my_country()
returns text
language sql stable security definer set search_path = pg_catalog, public, pg_temp
as $$
  select s.country from public.staff s
  where lower(s.email) = lower(coalesce(auth.jwt() ->> 'email', '')) limit 1;
$$;

-- Locations the signed-in user may see: admins every location, leads and officers those of their country.
create or replace function public.my_location_ids()
returns setof bigint
language sql stable security definer set search_path = pg_catalog, public, pg_temp
as $$
  select l.id from public.locations l, public.staff s
  where lower(s.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    and (s.role = 'admin' or (s.role in ('lead', 'officer') and s.country is not null and l.country = s.country));
$$;

-- May the signed-in user work at this location (hand out, change stock, receive returns, exchange)?
-- admin: anywhere · lead: locations in their country · officer: only their own location · anyone else: no.
create or replace function public.can_operate(p_location_id bigint)
returns boolean
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp
as $$
declare
  s public.staff;
  v_country text;
begin
  if p_location_id is null then return false; end if;
  select * into s from public.staff where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''));
  if not found then return false; end if;
  select country into v_country from public.locations where id = p_location_id;
  if v_country is null then return false; end if;
  if s.role = 'admin' then return true;
  elsif s.role = 'lead' then return coalesce(s.country = v_country, false);
  elsif s.role = 'officer' then return coalesce(s.location_id = p_location_id, false);
  else return false;
  end if;
end $$;

-- Is this location in the signed-in user's country (admins: every location)?
create or replace function public.in_my_country(p_location_id bigint)
returns boolean
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp
as $$
declare
  s public.staff;
begin
  if p_location_id is null then return false; end if;
  select * into s from public.staff where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''));
  if not found then return false; end if;
  if s.role = 'admin' then return exists (select 1 from public.locations where id = p_location_id);
  elsif s.role in ('lead', 'officer') then
    return coalesce(exists (select 1 from public.locations where id = p_location_id and country = s.country), false);
  else return false;
  end if;
end $$;

-- The signed-in user's own staff row (name, role, country, location).
create or replace function public.my_staff()
returns table (email text, name text, role text, country text, location_id bigint)
language sql stable security definer set search_path = pg_catalog, public, pg_temp
as $$
  select s.email, s.name, s.role, s.country, s.location_id from public.staff s
  where lower(s.email) = lower(coalesce(auth.jwt() ->> 'email', '')) limit 1;
$$;

-- May the signed-in user create / change / delete products, types and seasons of this country?
-- admin: any country · lead: only their own country · anyone else: no.
create or replace function public.can_manage_product(p_country text)
returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(exists (
    select 1 from public.staff
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
      and (role = 'admin' or (role = 'lead' and country is not null and p_country = country))
  ), false);
$$;

-- ---------- row level security ----------
-- Read: admins everything; leads and officers only rows of their own country.
-- Write: stock, handouts, transfers, returns and the logs are written ONLY by the database functions below.
-- (select …) around the helpers makes the database evaluate them once per query instead of once per row.
alter table public.staff             enable row level security;
alter table public.locations         enable row level security;
alter table public.products          enable row level security;
alter table public.catalog_options   enable row level security;
alter table public.stock             enable row level security;
alter table public.personnel         enable row level security;
alter table public.handouts          enable row level security;
alter table public.transfers         enable row level security;
alter table public.stock_log         enable row level security;
alter table public.incidents         enable row level security;
alter table public.returns           enable row level security;
alter table public.signature_history enable row level security;
alter table public.audit_log         enable row level security;

-- Remove the old broad policies (also from earlier versions of this script).
do $$
declare t text;
begin
  foreach t in array array['locations', 'products', 'stock', 'personnel', 'handouts', 'transfers', 'incidents', 'returns'] loop
    execute format('drop policy if exists "staff full access" on public.%I', t);
  end loop;
end $$;
drop policy if exists "staff read" on public.stock_log;
drop policy if exists "staff read products" on public.products;
drop policy if exists "leads add products" on public.products;
drop policy if exists "leads change products" on public.products;
drop policy if exists "leads delete products" on public.products;
drop policy if exists "staff read options" on public.catalog_options;
drop policy if exists "leads manage options" on public.catalog_options;

-- staff: own row readable; admins read and manage all rows (Users & roles screen).
drop policy if exists "read own staff row" on public.staff;
create policy "read own staff row" on public.staff
  for select to authenticated
  using (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')) or (select public.is_admin()));
drop policy if exists "admins manage staff" on public.staff;
create policy "admins manage staff" on public.staff
  for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

-- locations: read in scope; only admins add, change or delete.
drop policy if exists "read locations in scope" on public.locations;
create policy "read locations in scope" on public.locations for select to authenticated
  using ((select public.is_admin()) or country = (select public.my_country()));
drop policy if exists "admins manage locations" on public.locations;
create policy "admins manage locations" on public.locations for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- products, types & seasons: read in scope; admins (any country) and leads (own country) manage.
drop policy if exists "read products in scope" on public.products;
create policy "read products in scope" on public.products for select to authenticated
  using ((select public.is_admin()) or country = (select public.my_country()));
drop policy if exists "leads add products in country" on public.products;
create policy "leads add products in country" on public.products for insert to authenticated
  with check (public.can_manage_product(country));
drop policy if exists "leads change products in country" on public.products;
create policy "leads change products in country" on public.products for update to authenticated
  using (public.can_manage_product(country)) with check (public.can_manage_product(country));
drop policy if exists "leads delete products in country" on public.products;
create policy "leads delete products in country" on public.products for delete to authenticated
  using (public.can_manage_product(country));

drop policy if exists "read options in scope" on public.catalog_options;
create policy "read options in scope" on public.catalog_options for select to authenticated
  using ((select public.is_admin()) or country = (select public.my_country()));
drop policy if exists "leads manage options in country" on public.catalog_options;
create policy "leads manage options in country" on public.catalog_options for all to authenticated
  using (public.can_manage_product(country)) with check (public.can_manage_product(country));

-- stock, handouts, returns, stock log: read in scope; no write policies (database functions only).
drop policy if exists "read stock in scope" on public.stock;
create policy "read stock in scope" on public.stock for select to authenticated
  using (location_id in (select public.my_location_ids()));
drop policy if exists "read handouts in scope" on public.handouts;
create policy "read handouts in scope" on public.handouts for select to authenticated
  using ((select public.is_admin()) or location_id in (select public.my_location_ids()));
drop policy if exists "read returns in scope" on public.returns;
create policy "read returns in scope" on public.returns for select to authenticated
  using ((select public.is_admin()) or location_id in (select public.my_location_ids()));
drop policy if exists "read transfers in scope" on public.transfers;
create policy "read transfers in scope" on public.transfers for select to authenticated
  using ((select public.is_admin()) or from_location_id in (select public.my_location_ids())
         or to_location_id in (select public.my_location_ids()));
drop policy if exists "read stock log in scope" on public.stock_log;
create policy "read stock log in scope" on public.stock_log for select to authenticated
  using ((select public.is_admin()) or location_id in (select public.my_location_ids()));

-- workers: read and manage only workers at a site of your own country (admins: all).
-- Every worker needs a site, so the country is always known.
drop policy if exists "read workers in scope" on public.personnel;
create policy "read workers in scope" on public.personnel for select to authenticated
  using ((select public.is_admin()) or location_id in (select public.my_location_ids()));
drop policy if exists "add workers in scope" on public.personnel;
create policy "add workers in scope" on public.personnel for insert to authenticated
  with check (public.in_my_country(location_id));
drop policy if exists "change workers in scope" on public.personnel;
create policy "change workers in scope" on public.personnel for update to authenticated
  using ((select public.is_admin()) or public.in_my_country(location_id))
  with check (public.in_my_country(location_id));
drop policy if exists "delete workers in scope" on public.personnel;
create policy "delete workers in scope" on public.personnel for delete to authenticated
  using ((select public.is_admin()) or public.in_my_country(location_id));

-- incidents: read in scope; write only at a location you work at.
drop policy if exists "read incidents in scope" on public.incidents;
create policy "read incidents in scope" on public.incidents for select to authenticated
  using ((select public.is_admin()) or location_id in (select public.my_location_ids()));
drop policy if exists "manage incidents at own location" on public.incidents;
create policy "manage incidents at own location" on public.incidents for all to authenticated
  using (public.can_operate(location_id)) with check (public.can_operate(location_id));

-- signature history and audit log: admins read; nobody writes (database functions / triggers only).
drop policy if exists "admins read signature history" on public.signature_history;
create policy "admins read signature history" on public.signature_history for select to authenticated
  using ((select public.is_admin()));
drop policy if exists "admins read audit log" on public.audit_log;
create policy "admins read audit log" on public.audit_log for select to authenticated
  using ((select public.is_admin()));
revoke insert, update, delete, truncate on public.stock_log, public.audit_log, public.signature_history from anon, authenticated;

-- ---------- evidence files (private storage bucket) ----------
-- Files are stored as "<incident id>/<file>". Access only to files of incidents you may see / work on.
insert into storage.buckets (id, name, public, file_size_limit)
values ('evidence', 'evidence', false, 20971520)   -- 20 MB per file
on conflict (id) do nothing;

drop policy if exists "staff read evidence" on storage.objects;
drop policy if exists "staff upload evidence" on storage.objects;
drop policy if exists "staff delete evidence" on storage.objects;
drop policy if exists "read evidence in scope" on storage.objects;
create policy "read evidence in scope" on storage.objects for select to authenticated
  using (bucket_id = 'evidence' and exists (
    select 1 from public.incidents i where i.id::text = split_part(name, '/', 1)));   -- incident RLS applies
drop policy if exists "upload evidence in scope" on storage.objects;
create policy "upload evidence in scope" on storage.objects for insert to authenticated
  with check (bucket_id = 'evidence' and exists (
    select 1 from public.incidents i where i.id::text = split_part(name, '/', 1) and public.can_operate(i.location_id)));
drop policy if exists "delete evidence in scope" on storage.objects;
create policy "delete evidence in scope" on storage.objects for delete to authenticated
  using (bucket_id = 'evidence' and exists (
    select 1 from public.incidents i where i.id::text = split_part(name, '/', 1) and public.can_operate(i.location_id)));

-- ---------- stock change log ----------

-- The functions below tell the triggers what caused a change with ppe_context(source, note).
-- The setting only lasts for the current transaction.
create or replace function public.ppe_context(p_source text, p_note text)
returns void
language sql set search_path = pg_catalog, public, pg_temp
as $$
  select set_config('ppe.source', coalesce(p_source, ''), true), set_config('ppe.note', coalesce(p_note, ''), true);
$$;

-- Writes one stock_log row per change of a stock quantity, of its returned (used) part, or a deleted stock row.
create or replace function public.log_stock_change()
returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_email text := auth.jwt() ->> 'email';
  r       public.stock := case when tg_op = 'DELETE' then old else new end;
  v_old   integer := case when tg_op = 'INSERT' then 0 else old.quantity end;
  v_new   integer := case when tg_op = 'DELETE' then 0 else new.quantity end;
  v_rold  integer := case when tg_op = 'INSERT' then 0 else old.returned_quantity end;
  v_rnew  integer := case when tg_op = 'DELETE' then 0 else new.returned_quantity end;
  v_note  text := nullif(current_setting('ppe.note', true), '');
begin
  if v_new is not distinct from v_old and v_rnew is not distinct from v_rold then return r; end if;
  if v_new is not distinct from v_old then
    v_note := concat_ws(' · ', v_note, format('returned (used) part %s → %s', v_rold, v_rnew));
  end if;
  insert into public.stock_log (product_id, product_title, size, location_id, location_name,
                                old_quantity, new_quantity, source, note, changed_by, changed_by_email)
  values (r.product_id,
          coalesce((select title from public.products where id = r.product_id), nullif(current_setting('ppe.deleted_product', true), '')),
          r.size, r.location_id,
          coalesce((select title from public.locations where id = r.location_id), nullif(current_setting('ppe.deleted_location', true), '')),
          v_old, v_new,
          coalesce(nullif(current_setting('ppe.source', true), ''),
                   case when tg_op = 'DELETE' then 'Deleted' when v_email is null then 'Database edit' else 'Other' end),
          v_note,
          coalesce((select name from public.staff where lower(email) = lower(v_email)), v_email, 'Supabase dashboard'),
          v_email);
  return r;
end $$;

drop trigger if exists stock_log_trigger on public.stock;
create trigger stock_log_trigger
  after insert or update of quantity, returned_quantity or delete on public.stock
  for each row execute function public.log_stock_change();

-- When a product or location is deleted, its stock rows go with it: label those log entries.
create or replace function public.before_delete_context()
returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_table_name = 'products' then
    perform set_config('ppe.deleted_product', old.title, true);
    perform set_config('ppe.source', 'Product deleted', true);
    perform set_config('ppe.note', old.title || ' deleted', true);
  else
    perform set_config('ppe.deleted_location', old.title, true);
    perform set_config('ppe.source', 'Location deleted', true);
    perform set_config('ppe.note', old.title || ' deleted', true);
  end if;
  return old;
end $$;
drop trigger if exists products_before_delete on public.products;
create trigger products_before_delete before delete on public.products
  for each row execute function public.before_delete_context();
drop trigger if exists locations_before_delete on public.locations;
create trigger locations_before_delete before delete on public.locations
  for each row execute function public.before_delete_context();

-- ---------- audit log trigger ----------
-- Signatures are never copied into the audit log: only their SHA-256 digest and size are stored.
create or replace function public.audit_row()
returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_email text := auth.jwt() ->> 'email';
  s       public.staff;
  v_old   jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new   jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_fields jsonb;
  v_id    bigint;
begin
  if v_email is not null then
    select * into s from public.staff where lower(email) = lower(v_email);
  end if;
  -- Redact signatures.
  if v_old ? 'signature' and v_old ->> 'signature' is not null and v_old ->> 'signature' <> '' then
    v_old := jsonb_set(v_old, '{signature}', jsonb_build_object(
      'digest', encode(sha256(convert_to(v_old ->> 'signature', 'UTF8')), 'hex'),
      'bytes', octet_length(v_old ->> 'signature')));
  end if;
  if v_new ? 'signature' and v_new ->> 'signature' is not null and v_new ->> 'signature' <> '' then
    v_new := jsonb_set(v_new, '{signature}', jsonb_build_object(
      'digest', encode(sha256(convert_to(v_new ->> 'signature', 'UTF8')), 'hex'),
      'bytes', octet_length(v_new ->> 'signature')));
  end if;
  if tg_op = 'UPDATE' then
    select coalesce(jsonb_agg(k order by k), '[]'::jsonb) into v_fields
    from jsonb_object_keys(v_new) k
    where v_new -> k is distinct from v_old -> k;
    if v_fields = '[]'::jsonb then return null; end if;   -- nothing really changed
  end if;
  v_id := case when coalesce(v_new, v_old) ? 'id' then (coalesce(v_new, v_old) ->> 'id')::bigint end;
  insert into public.audit_log (actor_email, actor_name, actor_role, action, table_name, record_id,
                                changed_fields, old_values, new_values, reason)
  values (v_email, coalesce(s.name, v_email, 'Supabase dashboard'), s.role, tg_op, tg_table_name, v_id,
          v_fields, v_old, v_new,
          coalesce(nullif(current_setting('ppe.reason', true), ''), nullif(current_setting('ppe.note', true), '')));
  return null;   -- AFTER trigger: if writing the audit row fails, the whole change is cancelled
end $$;

do $$
declare t text;
begin
  foreach t in array array['personnel', 'staff', 'handouts', 'incidents', 'returns', 'transfers',
                           'locations', 'products', 'catalog_options'] loop
    execute format('drop trigger if exists audit_trigger on public.%I', t);
    execute format('create trigger audit_trigger after insert or update or delete on public.%I
                    for each row execute function public.audit_row()', t);
  end loop;
end $$;

-- ---------- product rules ----------

-- A product can only be stocked / handed out in its own country.
create or replace function public.check_product_country(p_product_id bigint, p_location_id bigint)
returns void
language plpgsql stable set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_pc text := (select country from public.products where id = p_product_id);
  v_lc text := (select country from public.locations where id = p_location_id);
begin
  if v_pc is null or v_lc is null then
    raise exception 'The product or location has no country, so it cannot be used.';
  end if;
  if v_pc <> v_lc then
    raise exception '% is a product for % and cannot be used at %.',
      (select title from public.products where id = p_product_id), v_pc, (select title from public.locations where id = p_location_id);
  end if;
end $$;

-- The country of a product that is already in use cannot be changed (create a new product instead).
create or replace function public.prevent_country_change()
returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.country is distinct from old.country and (
       exists (select 1 from public.stock where product_id = old.id)
    or exists (select 1 from public.handouts where product_id = old.id)
    or exists (select 1 from public.returns where product_id = old.id)) then
    raise exception 'Reassigning the country of a product in use is not allowed. Create a new product instead.';
  end if;
  return new;
end $$;
drop trigger if exists prevent_country_change on public.products;
create trigger prevent_country_change before update of country on public.products
  for each row execute function public.prevent_country_change();

-- ---------- stock functions (each call is one all-or-nothing transaction) ----------
-- The functions run with the database's own rights (SECURITY DEFINER), because nobody may write the
-- stock, handouts, transfers and returns tables directly. Each function checks who may do what.

-- Changes a stock quantity by p_delta. p_returned_delta changes the returned (used) part of it:
-- negative when handing out returned PPE, positive when a worker returns PPE into stock.
-- Internal: only callable from the functions below (schema app_internal is not exposed by the API).
drop function if exists public.adjust_stock(bigint, text, bigint, integer, boolean);
drop function if exists public.adjust_stock(bigint, text, bigint, integer, boolean, integer);
create or replace function app_internal.adjust_stock(
  p_product_id bigint, p_size text, p_location_id bigint, p_delta integer,
  p_allow_negative boolean default false, p_returned_delta integer default 0)
returns integer
language plpgsql set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_qty integer;
  v_ret integer;
begin
  perform public.check_product_country(p_product_id, p_location_id);
  insert into public.stock (product_id, size, location_id, quantity)
  values (p_product_id, p_size, p_location_id, 0)
  on conflict (product_id, size, location_id) do nothing;

  select quantity, returned_quantity into v_qty, v_ret from public.stock
  where product_id = p_product_id and size = p_size and location_id = p_location_id
  for update;

  if not p_allow_negative and v_qty + p_delta < 0 then
    raise exception 'Not enough stock of % (%) at %. Available: %.',
      (select title from public.products where id = p_product_id), p_size,
      (select title from public.locations where id = p_location_id), v_qty;
  end if;
  if p_returned_delta < 0 and v_ret + p_returned_delta < 0 then
    raise exception 'Not enough returned stock of % (%) at %. Returned available: %.',
      (select title from public.products where id = p_product_id), p_size,
      (select title from public.locations where id = p_location_id), v_ret;
  end if;

  update public.stock
  set quantity = v_qty + p_delta,
      returned_quantity = greatest(0, least(v_ret + coalesce(p_returned_delta, 0), v_qty + p_delta)),
      updated_at = now()
  where product_id = p_product_id and size = p_size and location_id = p_location_id
  returning quantity into v_qty;
  return v_qty;
end $$;
revoke all on function app_internal.adjust_stock(bigint, text, bigint, integer, boolean, integer) from public, anon, authenticated;

-- Manual stock edit (product Edit form). p_note: why it changed, e.g. "Delivery received".
-- p_returned: optional new returned (used) quantity; it is capped at the total.
drop function if exists public.set_stock(bigint, text, bigint, integer);
drop function if exists public.set_stock(bigint, text, bigint, integer, text);
create or replace function public.set_stock(
  p_product_id bigint, p_size text, p_location_id bigint, p_quantity integer,
  p_note text default null, p_returned integer default null)
returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
begin
  if public.can_operate(p_location_id) is not true then raise exception 'You can only change stock at your own location'; end if;
  if p_quantity is null or p_quantity < 0 then raise exception 'Stock cannot be negative'; end if;
  perform public.check_product_country(p_product_id, p_location_id);
  perform public.ppe_context('Manual edit', p_note);
  insert into public.stock (product_id, size, location_id, quantity, returned_quantity)
  values (p_product_id, p_size, p_location_id, p_quantity, greatest(0, least(coalesce(p_returned, 0), p_quantity)))
  on conflict (product_id, size, location_id)
  do update set quantity = excluded.quantity,
                returned_quantity = greatest(0, least(coalesce(p_returned, public.stock.returned_quantity), excluded.quantity)),
                updated_at = now();
end $$;

-- p_items: [{ "productId": 1, "size": "L", "qty": 2, "returned": 1 }, ...]
-- "returned" = how many of qty are taken from returned (used) stock (optional, default 0).
-- The worker must belong to a site in the user's country, in the same country as the issuing location.
create or replace function public.create_handout(
  p_personnel_id bigint, p_location_id bigint, p_items jsonb,
  p_reason text, p_notes text, p_date timestamptz, p_signature text)
returns setof public.handouts
language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
declare
  it       jsonb;
  v_batch  uuid := gen_random_uuid();
  v_person public.personnel;
  v_loc    public.locations;
  v_prod   public.products;
  v_row    public.handouts;
  v_qty    integer;
  v_ret    integer;
  v_email  text := auth.jwt() ->> 'email';
  v_by     text := coalesce((select name from public.staff where lower(email) = lower(auth.jwt() ->> 'email')), auth.jwt() ->> 'email');
begin
  select * into v_person from public.personnel where id = p_personnel_id;
  if not found then raise exception 'Person not found'; end if;
  select * into v_loc from public.locations where id = p_location_id;
  if not found then raise exception 'Location not found'; end if;
  if public.can_operate(v_loc.id) is not true then raise exception 'You can only hand out PPE at your own location'; end if;
  if v_person.location_id is null then raise exception '% has no site. Set the worker''s site first (Personnel → Edit).', v_person.title; end if;
  if public.in_my_country(v_person.location_id) is not true then raise exception 'You can only hand out PPE to workers in your own country'; end if;
  if (select country from public.locations where id = v_person.location_id) is distinct from v_loc.country then
    raise exception '% belongs to a site in another country.', v_person.title;
  end if;
  if coalesce(p_signature, '') = '' then raise exception 'The receiver needs to sign'; end if;

  for it in select * from jsonb_array_elements(p_items) loop
    select * into v_prod from public.products where id = (it ->> 'productId')::bigint;
    if not found then raise exception 'Product not found'; end if;
    v_qty := (it ->> 'qty')::integer;
    if v_qty is null or v_qty < 1 then raise exception 'Quantity must be at least 1'; end if;
    v_ret := greatest(0, least(coalesce((it ->> 'returned')::integer, 0), v_qty));
    perform public.ppe_context('Handout', 'To ' || v_person.title || case when v_ret > 0 then format(' (%s from returned stock)', v_ret) else '' end);
    perform app_internal.adjust_stock(v_prod.id, it ->> 'size', v_loc.id, -v_qty, false, -v_ret);
    insert into public.handouts (batch_id, personnel_id, personnel_name, product_id, title, size, quantity,
                                 location_id, location_name, reason, notes, handout_date,
                                 handed_out_by, handed_out_by_email, signature, from_returned)
    values (v_batch, v_person.id, v_person.title, v_prod.id, v_prod.title, it ->> 'size', v_qty,
            v_loc.id, v_loc.title, p_reason, p_notes, coalesce(p_date, now()),
            v_by, v_email, p_signature, v_ret)
    returning * into v_row;
    return next v_row;
  end loop;
end $$;

create or replace function public.create_transfer(
  p_from_location_id bigint, p_to_location_id bigint, p_items jsonb, p_reason text)
returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
declare
  it     jsonb;
  v_from public.locations;
  v_to   public.locations;
  v_prod public.products;
  v_qty  integer;
  v_by   text := coalesce((select name from public.staff where lower(email) = lower(auth.jwt() ->> 'email')), auth.jwt() ->> 'email');
begin
  select * into v_from from public.locations where id = p_from_location_id;
  select * into v_to from public.locations where id = p_to_location_id;
  if v_from.id is null or v_to.id is null then raise exception 'Location not found'; end if;
  if v_from.id = v_to.id then raise exception 'Choose a different destination'; end if;
  -- Transfers stay within one country, and leave from a location the user may operate
  -- (officers: their own location; leads: any location in their country; admins: anywhere).
  if v_from.country is distinct from v_to.country then raise exception 'Transfers between countries are not allowed'; end if;
  if public.can_operate(v_from.id) is not true then raise exception 'You can only transfer from your own location'; end if;

  for it in select * from jsonb_array_elements(p_items) loop
    select * into v_prod from public.products where id = (it ->> 'productId')::bigint;
    if not found then raise exception 'Product not found'; end if;
    v_qty := (it ->> 'qty')::integer;
    if v_qty is null or v_qty < 1 then raise exception 'Quantity must be at least 1'; end if;
    perform public.ppe_context('Transfer', 'To ' || v_to.title || coalesce(': ' || nullif(p_reason, ''), ''));
    perform app_internal.adjust_stock(v_prod.id, it ->> 'size', v_from.id, -v_qty, false);
    perform public.ppe_context('Transfer', 'From ' || v_from.title || coalesce(': ' || nullif(p_reason, ''), ''));
    perform app_internal.adjust_stock(v_prod.id, it ->> 'size', v_to.id, v_qty, true);
    insert into public.transfers (product_id, title, size, quantity, from_location_id, from_location_name,
                                  to_location_id, to_location_name, reason, transferred_by)
    values (v_prod.id, v_prod.title, it ->> 'size', v_qty, v_from.id, v_from.title,
            v_to.id, v_to.title, p_reason, v_by);
  end loop;
end $$;

-- Deletes a handout line (e.g. made by mistake). p_reason is required in the app and stored in the logs.
-- The signature is kept in signature_history.
drop function if exists public.delete_handout(bigint, boolean);
create or replace function public.delete_handout(p_id bigint, p_return_to_stock boolean, p_reason text default null)
returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
declare
  h        public.handouts;
  v_reason text := coalesce(nullif(trim(p_reason), ''), 'No reason provided by client');
begin
  select * into h from public.handouts where id = p_id for update;
  if not found then return; end if;
  if h.location_id is null then
    if public.is_admin() is not true then raise exception 'Only an admin can delete handouts of a deleted location'; end if;
  elsif public.can_operate(h.location_id) is not true then
    raise exception 'You can only change handouts made at your own location';
  end if;
  perform set_config('ppe.reason', 'Handout deleted: ' || v_reason, true);
  perform public.ppe_context('Handout deleted', 'Returned from ' || coalesce(h.personnel_name, 'unknown') || ' — reason: ' || v_reason);
  -- Only the part the worker still has goes back (items already returned are in stock already).
  if p_return_to_stock and h.location_id is not null and h.product_id is not null and h.quantity > h.returned_quantity then
    perform app_internal.adjust_stock(h.product_id, h.size, h.location_id, h.quantity - h.returned_quantity, true,
                                      least(h.from_returned, h.quantity - h.returned_quantity));
  end if;
  if coalesce(h.signature, '') <> '' then
    insert into public.signature_history (event, handout_id, batch_id, personnel_id, personnel_name, title, size, quantity,
                                          location_id, location_name, signed_on, signature, archived_by, archived_by_email)
    values ('Handout deleted', h.id, h.batch_id, h.personnel_id, h.personnel_name, h.title, h.size, h.quantity,
            h.location_id, h.location_name, h.handout_date, h.signature,
            coalesce((select name from public.staff where lower(email) = lower(auth.jwt() ->> 'email')), auth.jwt() ->> 'email'),
            auth.jwt() ->> 'email');
  end if;
  delete from public.handouts where id = p_id;
end $$;

-- Exchange the size of (part of) a handout: the old size goes back into stock and the new size is
-- taken from stock, both at p_location_id. The worker signs again (p_signature) for the new size.
-- Whole handout: the row gets the new size and the new signature; the old signature goes to signature_history.
-- Part of it: the original row keeps its signature for what is left; a new row holds the exchanged items.
drop function if exists public.exchange_handout(bigint, text, integer, bigint);
create or replace function public.exchange_handout(
  p_id bigint, p_new_size text, p_quantity integer, p_location_id bigint, p_signature text)
returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
declare
  h       public.handouts;
  v_loc   public.locations;
  v_email text := auth.jwt() ->> 'email';
  v_by    text := coalesce((select name from public.staff where lower(email) = lower(auth.jwt() ->> 'email')), auth.jwt() ->> 'email');
  v_note  text;
begin
  select * into h from public.handouts where id = p_id for update;
  if not found then raise exception 'Handout not found'; end if;
  if h.product_id is null then raise exception 'The product of this handout no longer exists'; end if;
  if h.location_id is null or public.in_my_country(h.location_id) is not true then
    raise exception 'You can only exchange handouts made in your own country';
  end if;
  if p_new_size is null or p_new_size = h.size then raise exception 'Choose a different size'; end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > h.quantity - h.returned_quantity then
    raise exception 'Quantity must be between 1 and % (items already returned cannot be exchanged)', h.quantity - h.returned_quantity;
  end if;
  if coalesce(p_signature, '') = '' then raise exception 'The worker needs to sign for the new size'; end if;
  select * into v_loc from public.locations where id = p_location_id;
  if not found then raise exception 'Location not found'; end if;
  if public.can_operate(v_loc.id) is not true then raise exception 'You can only exchange sizes at your own location'; end if;

  perform public.ppe_context('Size exchange', format('%s: %s → %s', coalesce(h.personnel_name, 'unknown'), h.size, p_new_size));
  perform app_internal.adjust_stock(h.product_id, p_new_size, v_loc.id, -p_quantity, false);
  perform app_internal.adjust_stock(h.product_id, h.size, v_loc.id, p_quantity, true);

  v_note := format('Size exchanged %s → %s (%s pcs) at %s on %s by %s, signed by the worker',
                   h.size, p_new_size, p_quantity, v_loc.title, to_char(now(), 'YYYY-MM-DD'), v_by);
  if p_quantity = h.quantity then
    if coalesce(h.signature, '') <> '' then
      insert into public.signature_history (event, handout_id, batch_id, personnel_id, personnel_name, title, size, quantity,
                                            location_id, location_name, signed_on, signature, archived_by, archived_by_email)
      values ('Replaced by size exchange', h.id, h.batch_id, h.personnel_id, h.personnel_name, h.title, h.size, h.quantity,
              h.location_id, h.location_name, h.handout_date, h.signature, v_by, v_email);
    end if;
    update public.handouts set size = p_new_size, signature = p_signature,
           notes = concat_ws(E'\n', nullif(notes, ''), v_note) where id = h.id;
  else
    update public.handouts set quantity = quantity - p_quantity, from_returned = least(from_returned, quantity - p_quantity) where id = h.id;
    insert into public.handouts (batch_id, personnel_id, personnel_name, product_id, title, size, quantity,
                                 location_id, location_name, reason, notes, handout_date,
                                 handed_out_by, handed_out_by_email, signature)
    values (gen_random_uuid(), h.personnel_id, h.personnel_name, h.product_id, h.title, p_new_size, p_quantity,
            v_loc.id, v_loc.title, 'Size Change', v_note, now(),
            v_by, v_email, p_signature);
  end if;
end $$;

-- A worker gives PPE back. p_items: [{ "handoutId": 12, "qty": 1, "toStock": true }, ...]
-- toStock = true: back into stock at p_location_id as returned PPE; false: recorded as returned but discarded.
-- The handouts must be from your own country, and are received at a location you work at in that country.
create or replace function public.record_return(
  p_personnel_id bigint, p_location_id bigint, p_items jsonb, p_note text default null)
returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
declare
  it      jsonb;
  h       public.handouts;
  v_qty   integer;
  v_stock boolean;
  v_loc   public.locations;
  v_comp  text := (select company from public.personnel where id = p_personnel_id);
  v_email text := auth.jwt() ->> 'email';
  v_by    text := coalesce((select name from public.staff where lower(email) = lower(auth.jwt() ->> 'email')), auth.jwt() ->> 'email');
begin
  select * into v_loc from public.locations where id = p_location_id;
  if not found then raise exception 'Location not found'; end if;
  if public.can_operate(v_loc.id) is not true then raise exception 'You can only receive returned PPE at your own location'; end if;
  for it in select * from jsonb_array_elements(p_items) loop
    v_qty := (it ->> 'qty')::integer;
    continue when v_qty is null or v_qty <= 0;
    v_stock := coalesce((it ->> 'toStock')::boolean, true);
    select * into h from public.handouts where id = (it ->> 'handoutId')::bigint for update;
    if not found or h.personnel_id is distinct from p_personnel_id then raise exception 'Handout not found for this worker'; end if;
    if h.location_id is null or public.in_my_country(h.location_id) is not true then
      raise exception 'You can only record returns for PPE handed out in your own country';
    end if;
    if (select country from public.locations where id = h.location_id) is distinct from v_loc.country then
      raise exception '% (%) was handed out in another country and cannot be returned at %', h.title, h.size, v_loc.title;
    end if;
    if v_qty > h.quantity - h.returned_quantity then
      raise exception '% (%): only % not yet returned', h.title, h.size, h.quantity - h.returned_quantity;
    end if;
    update public.handouts set returned_quantity = returned_quantity + v_qty where id = h.id;
    if v_stock and h.product_id is not null then
      perform public.ppe_context('Return', 'From ' || coalesce(h.personnel_name, 'unknown') || coalesce(': ' || nullif(p_note, ''), ''));
      perform app_internal.adjust_stock(h.product_id, h.size, v_loc.id, v_qty, true, v_qty);
    end if;
    insert into public.returns (handout_id, personnel_id, personnel_name, company, product_id, title, size, quantity,
                                location_id, location_name, to_stock, note, received_by, received_by_email)
    values (h.id, h.personnel_id, h.personnel_name, v_comp, h.product_id, h.title, h.size, v_qty,
            v_loc.id, v_loc.title, v_stock, p_note, v_by, v_email);
  end loop;
end $$;

-- ---------- reports (run with the user's own rights, so they only see rows in their scope) ----------

-- PPE still held by subcontractor workers (not yet returned), per worker, product and size.
-- p_status: 'lost' = workers who left, 'rotation' = workers in rotation.
-- Workers of p_exclude_company (the main company) and products that are not returnable are left out.
create or replace function public.outstanding_ppe(p_country text, p_status text, p_exclude_company text default null)
returns table (personnel_id bigint, personnel_name text, company text, location_name text,
               product_id bigint, title text, size text, quantity bigint, last_handout timestamptz)
language sql stable set search_path = pg_catalog, public, pg_temp
as $$
  select p.id, p.title, coalesce(nullif(trim(p.company), ''), '(no company)'), l.title,
         h.product_id, max(h.title), h.size, sum(h.quantity - h.returned_quantity)::bigint, max(h.handout_date)
  from public.personnel p
  join public.locations l on l.id = p.location_id
  join public.handouts h on h.personnel_id = p.id
  left join public.products pr on pr.id = h.product_id
  where (p_country is null or l.country = p_country)
    and (p_exclude_company is null or lower(coalesce(trim(p.company), '')) <> lower(p_exclude_company))
    and coalesce(pr.returnable, true)
    and h.quantity > h.returned_quantity
    and case p_status when 'lost' then not p.active
                      when 'rotation' then p.active and p.in_rotation
                      else p.active and not p.in_rotation end
  group by p.id, p.title, p.company, l.title, h.product_id, h.size
  order by 3, 2;
$$;

-- Orders tab: how much of each product/size was used at a location since p_from, from the stock change log
-- (handouts + stock decreases from manual counts, which is how consumables are counted).
-- first_log = date of the oldest log entry at the location, to know how many months of history exist.
create or replace function public.stock_usage(p_location_id bigint, p_from timestamptz)
returns jsonb
language sql stable set search_path = pg_catalog, public, pg_temp
as $$
  select jsonb_build_object(
    'first_log', (select min(changed_at) from public.stock_log where location_id = p_location_id),
    'rows', coalesce((select jsonb_agg(x) from (
        select product_id, size, sum(-change)::integer as used
        from public.stock_log
        where location_id = p_location_id and changed_at >= p_from and change < 0
          and source in ('Handout', 'Manual edit')
        group by product_id, size) x), '[]'::jsonb));
$$;

-- Totals per product and size for the History screen (same filters as the history list).
create or replace function public.handout_summary(
  p_location_ids bigint[] default null, p_product_id bigint default null, p_reason text default null,
  p_search text default null, p_from timestamptz default null, p_to timestamptz default null)
returns table (title text, size text, quantity bigint, records bigint)
language sql stable set search_path = pg_catalog, public, pg_temp
as $$
  select h.title, h.size, sum(h.quantity)::bigint, count(*)::bigint
  from public.handouts h
  where (p_location_ids is null or h.location_id = any (p_location_ids))
    and (p_product_id is null or h.product_id = p_product_id)
    and (p_reason is null or h.reason = p_reason)
    and (p_search is null or h.personnel_name ilike '%' || p_search || '%')
    and (p_from is null or h.handout_date >= p_from)
    and (p_to is null or h.handout_date < p_to)
  group by h.title, h.size
  order by h.title, h.size;
$$;

-- Consumption statistics for the Dashboard, calculated in the database (one call, small result).
-- p_bucket: 'week' or 'month' for the over-time chart (weeks start on Monday, Danish/Swedish time).
create or replace function public.dashboard_stats(
  p_location_ids bigint[] default null, p_from timestamptz default null, p_to timestamptz default null,
  p_bucket text default 'month')
returns jsonb
language sql stable set search_path = pg_catalog, public, pg_temp
as $$
  with h as (
    select personnel_id, product_id, title, quantity, location_id, location_name, reason, handout_date
    from public.handouts
    where (p_location_ids is null or location_id = any (p_location_ids))
      and (p_from is null or handout_date >= p_from)
      and (p_to is null or handout_date < p_to)
  )
  select jsonb_build_object(
    'items',   coalesce((select sum(quantity) from h), 0),
    'records', (select count(*) from h),
    'people',  (select count(distinct personnel_id) from h),
    'by_period', coalesce((select jsonb_agg(x order by x.bucket) from (
        select to_char(date_trunc(case when p_bucket = 'week' then 'week' else 'month' end,
                                  handout_date at time zone 'Europe/Copenhagen'), 'YYYY-MM-DD') as bucket,
               sum(quantity) as qty
        from h group by 1) x), '[]'::jsonb),
    'by_product', coalesce((select jsonb_agg(x order by x.qty desc) from (
        select product_id, max(title) as title, sum(quantity) as qty from h group by product_id) x), '[]'::jsonb),
    'by_location', coalesce((select jsonb_agg(x order by x.qty desc) from (
        select location_id, max(location_name) as location_name, sum(quantity) as qty from h group by location_id) x), '[]'::jsonb),
    'by_reason', coalesce((select jsonb_agg(x order by x.qty desc) from (
        select coalesce(reason, '—') as reason, sum(quantity) as qty from h group by 1) x), '[]'::jsonb)
  );
$$;

-- ---------- who may call which function ----------
-- Nothing is callable without signing in. Helpers used inside the access rules must be callable by
-- signed-in users; internal helpers are not.
revoke execute on function public.is_staff() from public, anon;
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.my_country() from public, anon;
revoke execute on function public.my_location_ids() from public, anon;
revoke execute on function public.can_operate(bigint) from public, anon;
revoke execute on function public.in_my_country(bigint) from public, anon;
revoke execute on function public.my_staff() from public, anon;
revoke execute on function public.can_manage_product(text) from public, anon;
grant execute on function public.is_staff() to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.my_country() to authenticated;
grant execute on function public.my_location_ids() to authenticated;
grant execute on function public.can_operate(bigint) to authenticated;
grant execute on function public.in_my_country(bigint) to authenticated;
grant execute on function public.my_staff() to authenticated;
grant execute on function public.can_manage_product(text) to authenticated;

revoke execute on function public.ppe_context(text, text) from public, anon, authenticated;
revoke execute on function public.check_product_country(bigint, bigint) from public, anon, authenticated;
revoke execute on function public.log_stock_change() from public, anon, authenticated;
revoke execute on function public.before_delete_context() from public, anon, authenticated;
revoke execute on function public.audit_row() from public, anon, authenticated;
revoke execute on function public.prevent_country_change() from public, anon, authenticated;

revoke execute on function public.set_stock(bigint, text, bigint, integer, text, integer) from public, anon;
revoke execute on function public.create_handout(bigint, bigint, jsonb, text, text, timestamptz, text) from public, anon;
revoke execute on function public.create_transfer(bigint, bigint, jsonb, text) from public, anon;
revoke execute on function public.delete_handout(bigint, boolean, text) from public, anon;
revoke execute on function public.exchange_handout(bigint, text, integer, bigint, text) from public, anon;
revoke execute on function public.record_return(bigint, bigint, jsonb, text) from public, anon;
revoke execute on function public.outstanding_ppe(text, text, text) from public, anon;
revoke execute on function public.stock_usage(bigint, timestamptz) from public, anon;
revoke execute on function public.handout_summary(bigint[], bigint, text, text, timestamptz, timestamptz) from public, anon;
revoke execute on function public.dashboard_stats(bigint[], timestamptz, timestamptz, text) from public, anon;
grant execute on function public.set_stock(bigint, text, bigint, integer, text, integer) to authenticated;
grant execute on function public.create_handout(bigint, bigint, jsonb, text, text, timestamptz, text) to authenticated;
grant execute on function public.create_transfer(bigint, bigint, jsonb, text) to authenticated;
grant execute on function public.delete_handout(bigint, boolean, text) to authenticated;
grant execute on function public.exchange_handout(bigint, text, integer, bigint, text) to authenticated;
grant execute on function public.record_return(bigint, bigint, jsonb, text) to authenticated;
grant execute on function public.outstanding_ppe(text, text, text) to authenticated;
grant execute on function public.stock_usage(bigint, timestamptz) to authenticated;
grant execute on function public.handout_summary(bigint[], bigint, text, text, timestamptz, timestamptz) to authenticated;
grant execute on function public.dashboard_stats(bigint[], timestamptz, timestamptz, text) to authenticated;

-- ---------- starter locations (only added when the table is empty) ----------
insert into public.locations (title, country)
select * from (values ('CPH', 'DK'), ('FRD2A', 'DK'), ('Ersbo', 'SE'), ('Kungsgarden', 'SE'), ('Stackbo', 'SE')) v(title, country)
where not exists (select 1 from public.locations);

-- ---------- checks after running (results appear below in the SQL editor) ----------
-- Staff who cannot work until fixed (officer without location, lead without country, unknown role):
--   select * from public.staff where role not in ('admin','lead','officer')
--     or (role = 'lead' and country is null) or (role = 'officer' and location_id is null);
-- Workers without a site (they are only visible to admins and cannot receive PPE until a site is set):
--   select id, title, company from public.personnel where location_id is null;

-- Make the API pick up new/changed functions immediately.
notify pgrst, 'reload schema';
