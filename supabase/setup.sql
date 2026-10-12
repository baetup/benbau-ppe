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
-- role: 'admin' (all countries), 'lead' (all locations in `country`), 'officer' (hands out only at `location_id`).
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

-- ---------- security ----------

-- True when the signed-in user's email is in the staff table.
create or replace function public.is_staff()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.staff
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

alter table public.staff     enable row level security;
alter table public.locations enable row level security;
alter table public.products  enable row level security;
alter table public.stock     enable row level security;
alter table public.personnel enable row level security;
alter table public.handouts  enable row level security;
alter table public.transfers enable row level security;
alter table public.stock_log enable row level security;
alter table public.incidents enable row level security;
alter table public.returns enable row level security;

-- The stock log is read-only for staff (it is written by the trigger below).
drop policy if exists "staff read" on public.stock_log;
create policy "staff read" on public.stock_log for select to authenticated using (public.is_staff());

-- True when the signed-in user is an admin.
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.staff
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')) and role = 'admin'
  );
$$;

-- May the signed-in user hand out / edit stock at this location?
-- admin: anywhere · lead: locations in their country · officer: only their own location.
create or replace function public.can_operate(p_location_id bigint)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare
  s staff;
  v_country text;
begin
  select * into s from staff where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''));
  if not found then return false; end if;
  if s.role = 'admin' then return true; end if;
  select country into v_country from locations where id = p_location_id;
  if s.role = 'lead' then return v_country is not null and v_country = s.country; end if;
  return s.location_id = p_location_id;
end $$;

-- Is this location in the signed-in user's country (admins: every location)?
create or replace function public.in_my_country(p_location_id bigint)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare
  s staff;
begin
  select * into s from staff where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''));
  if not found then return false; end if;
  if s.role = 'admin' then return true; end if;
  return exists (select 1 from locations where id = p_location_id and country = s.country);
end $$;

-- The signed-in user's own staff row (name, role, country, location).
create or replace function public.my_staff()
returns table (email text, name text, role text, country text, location_id bigint)
language sql stable security definer set search_path = public
as $$
  select s.email, s.name, s.role, s.country, s.location_id from public.staff s
  where lower(s.email) = lower(coalesce(auth.jwt() ->> 'email', '')) limit 1;
$$;

-- Staff read their own row; admins read and manage all rows (Users & roles screen).
drop policy if exists "read own staff row" on public.staff;
create policy "read own staff row" on public.staff
  for select to authenticated
  using (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')) or public.is_admin());
drop policy if exists "admins manage staff" on public.staff;
create policy "admins manage staff" on public.staff
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Staff have full access to the PPE data; nobody else has any.
do $$
declare t text;
begin
  foreach t in array array['locations', 'products', 'stock', 'personnel', 'handouts', 'transfers', 'incidents', 'returns'] loop
    execute format('drop policy if exists "staff full access" on public.%I', t);
    execute format('create policy "staff full access" on public.%I for all to authenticated using (public.is_staff()) with check (public.is_staff())', t);
  end loop;
end $$;

-- ---------- evidence files (private storage bucket, staff only) ----------
insert into storage.buckets (id, name, public, file_size_limit)
values ('evidence', 'evidence', false, 20971520)   -- 20 MB per file
on conflict (id) do nothing;

drop policy if exists "staff read evidence" on storage.objects;
create policy "staff read evidence" on storage.objects
  for select to authenticated using (bucket_id = 'evidence' and public.is_staff());
drop policy if exists "staff upload evidence" on storage.objects;
create policy "staff upload evidence" on storage.objects
  for insert to authenticated with check (bucket_id = 'evidence' and public.is_staff());
drop policy if exists "staff delete evidence" on storage.objects;
create policy "staff delete evidence" on storage.objects
  for delete to authenticated using (bucket_id = 'evidence' and public.is_staff());

-- ---------- stock change log ----------

-- The functions below tell the trigger what caused a change with ppe_context(source, note).
-- The setting only lasts for the current transaction.
create or replace function public.ppe_context(p_source text, p_note text)
returns void
language sql set search_path = public
as $$
  select set_config('ppe.source', coalesce(p_source, ''), true), set_config('ppe.note', coalesce(p_note, ''), true);
$$;

create or replace function public.log_stock_change()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_old   integer := case when tg_op = 'INSERT' then 0 else old.quantity end;
  v_email text := auth.jwt() ->> 'email';
begin
  if new.quantity is not distinct from v_old then return new; end if;
  insert into stock_log (product_id, product_title, size, location_id, location_name,
                         old_quantity, new_quantity, source, note, changed_by, changed_by_email)
  values (new.product_id, (select title from products where id = new.product_id), new.size,
          new.location_id, (select title from locations where id = new.location_id),
          v_old, new.quantity,
          coalesce(nullif(current_setting('ppe.source', true), ''), case when v_email is null then 'Database edit' else 'Other' end),
          nullif(current_setting('ppe.note', true), ''),
          coalesce((select name from staff where lower(email) = lower(v_email)), v_email, 'Supabase dashboard'),
          v_email);
  return new;
end $$;

drop trigger if exists stock_log_trigger on public.stock;
create trigger stock_log_trigger
  after insert or update of quantity on public.stock
  for each row execute function public.log_stock_change();

-- ---------- stock functions (each call is one all-or-nothing transaction) ----------

-- Changes a stock quantity by p_delta. p_returned_delta changes the returned (used) part of it:
-- negative when handing out returned PPE, positive when a worker returns PPE into stock.
-- The returned part can never be more than the total.
drop function if exists public.adjust_stock(bigint, text, bigint, integer, boolean);
create or replace function public.adjust_stock(
  p_product_id bigint, p_size text, p_location_id bigint, p_delta integer,
  p_allow_negative boolean default false, p_returned_delta integer default 0)
returns integer
language plpgsql set search_path = public
as $$
declare
  v_qty integer;
  v_ret integer;
begin
  insert into stock (product_id, size, location_id, quantity)
  values (p_product_id, p_size, p_location_id, 0)
  on conflict (product_id, size, location_id) do nothing;

  select quantity, returned_quantity into v_qty, v_ret from stock
  where product_id = p_product_id and size = p_size and location_id = p_location_id
  for update;

  if not p_allow_negative and v_qty + p_delta < 0 then
    raise exception 'Not enough stock of % (%) at %. Available: %.',
      (select title from products where id = p_product_id), p_size,
      (select title from locations where id = p_location_id), v_qty;
  end if;
  if p_returned_delta < 0 and v_ret + p_returned_delta < 0 then
    raise exception 'Not enough returned stock of % (%) at %. Returned available: %.',
      (select title from products where id = p_product_id), p_size,
      (select title from locations where id = p_location_id), v_ret;
  end if;

  update stock
  set quantity = v_qty + p_delta,
      returned_quantity = greatest(0, least(v_ret + coalesce(p_returned_delta, 0), v_qty + p_delta)),
      updated_at = now()
  where product_id = p_product_id and size = p_size and location_id = p_location_id
  returning quantity into v_qty;
  return v_qty;
end $$;

-- Manual stock edit (product Edit form). p_note: why it changed, e.g. "Delivery received".
-- p_returned: optional new returned (used) quantity; it is capped at the total.
drop function if exists public.set_stock(bigint, text, bigint, integer);
drop function if exists public.set_stock(bigint, text, bigint, integer, text);
create or replace function public.set_stock(
  p_product_id bigint, p_size text, p_location_id bigint, p_quantity integer,
  p_note text default null, p_returned integer default null)
returns void
language plpgsql set search_path = public
as $$
begin
  if not can_operate(p_location_id) then raise exception 'You can only change stock at your own location'; end if;
  perform ppe_context('Manual edit', p_note);
  insert into stock (product_id, size, location_id, quantity, returned_quantity)
  values (p_product_id, p_size, p_location_id, p_quantity, greatest(0, least(coalesce(p_returned, 0), p_quantity)))
  on conflict (product_id, size, location_id)
  do update set quantity = excluded.quantity,
                returned_quantity = greatest(0, least(coalesce(p_returned, stock.returned_quantity), excluded.quantity)),
                updated_at = now();
end $$;

-- p_items: [{ "productId": 1, "size": "L", "qty": 2, "returned": 1 }, ...]
-- "returned" = how many of qty are taken from returned (used) stock (optional, default 0).
create or replace function public.create_handout(
  p_personnel_id bigint, p_location_id bigint, p_items jsonb,
  p_reason text, p_notes text, p_date timestamptz, p_signature text)
returns setof public.handouts
language plpgsql set search_path = public
as $$
declare
  it       jsonb;
  v_batch  uuid := gen_random_uuid();
  v_person personnel;
  v_loc    locations;
  v_prod   products;
  v_row    handouts;
  v_qty    integer;
  v_ret    integer;
  v_email  text := auth.jwt() ->> 'email';
  v_by     text := coalesce((select name from staff where lower(email) = lower(auth.jwt() ->> 'email')), auth.jwt() ->> 'email');
begin
  select * into v_person from personnel where id = p_personnel_id;
  if not found then raise exception 'Person not found'; end if;
  select * into v_loc from locations where id = p_location_id;
  if not found then raise exception 'Location not found'; end if;
  if not can_operate(v_loc.id) then raise exception 'You can only hand out PPE at your own location'; end if;

  for it in select * from jsonb_array_elements(p_items) loop
    select * into v_prod from products where id = (it ->> 'productId')::bigint;
    if not found then raise exception 'Product not found'; end if;
    v_qty := (it ->> 'qty')::integer;
    v_ret := greatest(0, least(coalesce((it ->> 'returned')::integer, 0), v_qty));
    perform ppe_context('Handout', 'To ' || v_person.title || case when v_ret > 0 then format(' (%s from returned stock)', v_ret) else '' end);
    perform adjust_stock(v_prod.id, it ->> 'size', v_loc.id, -v_qty, false, -v_ret);
    insert into handouts (batch_id, personnel_id, personnel_name, product_id, title, size, quantity,
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
language plpgsql set search_path = public
as $$
declare
  it     jsonb;
  v_from locations;
  v_to   locations;
  v_prod products;
  v_by   text := coalesce((select name from staff where lower(email) = lower(auth.jwt() ->> 'email')), auth.jwt() ->> 'email');
begin
  select * into v_from from locations where id = p_from_location_id;
  select * into v_to from locations where id = p_to_location_id;
  if v_from.id is null or v_to.id is null then raise exception 'Location not found'; end if;
  if v_from.id = v_to.id then raise exception 'Choose a different destination'; end if;
  -- Transfers stay within one country, and leave from a location the user may operate
  -- (officers: their own location; leads: any location in their country; admins: anywhere).
  if v_from.country is distinct from v_to.country then raise exception 'Transfers between countries are not allowed'; end if;
  if not can_operate(v_from.id) then raise exception 'You can only transfer from your own location'; end if;

  for it in select * from jsonb_array_elements(p_items) loop
    select * into v_prod from products where id = (it ->> 'productId')::bigint;
    if not found then raise exception 'Product not found'; end if;
    perform ppe_context('Transfer', 'To ' || v_to.title || coalesce(': ' || nullif(p_reason, ''), ''));
    perform adjust_stock(v_prod.id, it ->> 'size', v_from.id, -((it ->> 'qty')::integer), false);
    perform ppe_context('Transfer', 'From ' || v_from.title || coalesce(': ' || nullif(p_reason, ''), ''));
    perform adjust_stock(v_prod.id, it ->> 'size', v_to.id, (it ->> 'qty')::integer, true);
    insert into transfers (product_id, title, size, quantity, from_location_id, from_location_name,
                           to_location_id, to_location_name, reason, transferred_by)
    values (v_prod.id, v_prod.title, it ->> 'size', (it ->> 'qty')::integer, v_from.id, v_from.title,
            v_to.id, v_to.title, p_reason, v_by);
  end loop;
end $$;

create or replace function public.delete_handout(p_id bigint, p_return_to_stock boolean)
returns void
language plpgsql set search_path = public
as $$
declare
  h handouts;
begin
  select * into h from handouts where id = p_id;
  if not found then return; end if;
  if h.location_id is not null and not can_operate(h.location_id) then raise exception 'You can only change handouts made at your own location'; end if;
  -- Only the part the worker still has goes back (items already returned are in stock already).
  if p_return_to_stock and h.location_id is not null and h.product_id is not null and h.quantity > h.returned_quantity then
    perform ppe_context('Handout deleted', 'Returned from ' || coalesce(h.personnel_name, 'unknown'));
    perform adjust_stock(h.product_id, h.size, h.location_id, h.quantity - h.returned_quantity, true,
                         least(h.from_returned, h.quantity - h.returned_quantity));
  end if;
  delete from handouts where id = p_id;
end $$;

-- Exchange the size of (part of) a handout: the old size goes back into stock and the new size is
-- taken from stock, both at p_location_id. A partial exchange splits the handout into two rows.
create or replace function public.exchange_handout(
  p_id bigint, p_new_size text, p_quantity integer, p_location_id bigint)
returns void
language plpgsql set search_path = public
as $$
declare
  h      handouts;
  v_loc  locations;
  v_by   text := coalesce((select name from staff where lower(email) = lower(auth.jwt() ->> 'email')), auth.jwt() ->> 'email');
  v_note text;
begin
  select * into h from handouts where id = p_id for update;
  if not found then raise exception 'Handout not found'; end if;
  if h.product_id is null then raise exception 'The product of this handout no longer exists'; end if;
  if p_new_size is null or p_new_size = h.size then raise exception 'Choose a different size'; end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > h.quantity - h.returned_quantity then
    raise exception 'Quantity must be between 1 and % (items already returned cannot be exchanged)', h.quantity - h.returned_quantity;
  end if;
  select * into v_loc from locations where id = p_location_id;
  if not found then raise exception 'Location not found'; end if;
  if not can_operate(v_loc.id) then raise exception 'You can only exchange sizes at your own location'; end if;

  perform ppe_context('Size exchange', format('%s: %s → %s', coalesce(h.personnel_name, 'unknown'), h.size, p_new_size));
  perform adjust_stock(h.product_id, p_new_size, v_loc.id, -p_quantity, false);
  perform adjust_stock(h.product_id, h.size, v_loc.id, p_quantity, true);

  v_note := format('Size exchanged %s → %s (%s pcs) at %s on %s by %s',
                   h.size, p_new_size, p_quantity, v_loc.title, to_char(now(), 'YYYY-MM-DD'), v_by);
  if p_quantity = h.quantity then
    update handouts set size = p_new_size, notes = concat_ws(E'\n', nullif(notes, ''), v_note) where id = h.id;
  else
    update handouts set quantity = quantity - p_quantity, from_returned = least(from_returned, quantity - p_quantity) where id = h.id;
    insert into handouts (batch_id, personnel_id, personnel_name, product_id, title, size, quantity,
                          location_id, location_name, reason, notes, handout_date,
                          handed_out_by, handed_out_by_email, signature)
    values (h.batch_id, h.personnel_id, h.personnel_name, h.product_id, h.title, p_new_size, p_quantity,
            h.location_id, h.location_name, h.reason, concat_ws(E'\n', nullif(h.notes, ''), v_note), h.handout_date,
            h.handed_out_by, h.handed_out_by_email, h.signature);
  end if;
end $$;

-- A worker gives PPE back. p_items: [{ "handoutId": 12, "qty": 1, "toStock": true }, ...]
-- toStock = true: back into stock at p_location_id as returned PPE; false: recorded as returned but discarded.
create or replace function public.record_return(
  p_personnel_id bigint, p_location_id bigint, p_items jsonb, p_note text default null)
returns void
language plpgsql set search_path = public
as $$
declare
  it      jsonb;
  h       handouts;
  v_qty   integer;
  v_stock boolean;
  v_loc   locations;
  v_comp  text := (select company from personnel where id = p_personnel_id);
  v_email text := auth.jwt() ->> 'email';
  v_by    text := coalesce((select name from staff where lower(email) = lower(auth.jwt() ->> 'email')), auth.jwt() ->> 'email');
begin
  select * into v_loc from locations where id = p_location_id;
  if not found then raise exception 'Location not found'; end if;
  if not can_operate(v_loc.id) then raise exception 'You can only receive returned PPE at your own location'; end if;
  for it in select * from jsonb_array_elements(p_items) loop
    v_qty := (it ->> 'qty')::integer;
    continue when v_qty is null or v_qty <= 0;
    v_stock := coalesce((it ->> 'toStock')::boolean, true);
    select * into h from handouts where id = (it ->> 'handoutId')::bigint for update;
    if not found or h.personnel_id is distinct from p_personnel_id then raise exception 'Handout not found for this worker'; end if;
    if v_qty > h.quantity - h.returned_quantity then
      raise exception '% (%): only % not yet returned', h.title, h.size, h.quantity - h.returned_quantity;
    end if;
    update handouts set returned_quantity = returned_quantity + v_qty where id = h.id;
    if v_stock and h.product_id is not null then
      perform ppe_context('Return', 'From ' || coalesce(h.personnel_name, 'unknown') || coalesce(': ' || nullif(p_note, ''), ''));
      perform adjust_stock(h.product_id, h.size, v_loc.id, v_qty, true, v_qty);
    end if;
    insert into returns (handout_id, personnel_id, personnel_name, company, product_id, title, size, quantity,
                         location_id, location_name, to_stock, note, received_by, received_by_email)
    values (h.id, h.personnel_id, h.personnel_name, v_comp, h.product_id, h.title, h.size, v_qty,
            v_loc.id, v_loc.title, v_stock, p_note, v_by, v_email);
  end loop;
end $$;

-- PPE still held by subcontractor workers (not yet returned), per worker, product and size.
-- p_status: 'lost' = workers who left, 'rotation' = workers in rotation.
-- Workers of p_exclude_company (the main company) and products that are not returnable are left out.
create or replace function public.outstanding_ppe(p_country text, p_status text, p_exclude_company text default null)
returns table (personnel_id bigint, personnel_name text, company text, location_name text,
               product_id bigint, title text, size text, quantity bigint, last_handout timestamptz)
language sql stable set search_path = public
as $$
  select p.id, p.title, coalesce(nullif(trim(p.company), ''), '(no company)'), l.title,
         h.product_id, max(h.title), h.size, sum(h.quantity - h.returned_quantity)::bigint, max(h.handout_date)
  from personnel p
  join locations l on l.id = p.location_id
  join handouts h on h.personnel_id = p.id
  left join products pr on pr.id = h.product_id
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
language sql stable set search_path = public
as $$
  select jsonb_build_object(
    'first_log', (select min(changed_at) from stock_log where location_id = p_location_id),
    'rows', coalesce((select jsonb_agg(x) from (
        select product_id, size, sum(-change)::integer as used
        from stock_log
        where location_id = p_location_id and changed_at >= p_from and change < 0
          and source in ('Handout', 'Manual edit')
        group by product_id, size) x), '[]'::jsonb));
$$;

-- Totals per product and size for the History screen (same filters as the history list).
create or replace function public.handout_summary(
  p_location_ids bigint[] default null, p_product_id bigint default null, p_reason text default null,
  p_search text default null, p_from timestamptz default null, p_to timestamptz default null)
returns table (title text, size text, quantity bigint, records bigint)
language sql stable set search_path = public
as $$
  select h.title, h.size, sum(h.quantity)::bigint, count(*)::bigint
  from handouts h
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
language sql stable set search_path = public
as $$
  with h as (
    select personnel_id, product_id, title, quantity, location_id, location_name, reason, handout_date
    from handouts
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

-- Only signed-in users may call the functions (row level security still applies inside them).
revoke execute on function public.ppe_context(text, text) from public, anon;
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.can_operate(bigint) from public, anon;
revoke execute on function public.in_my_country(bigint) from public, anon;
grant execute on function public.is_admin() to authenticated;
revoke execute on function public.my_staff() from public, anon;
grant execute on function public.my_staff() to authenticated;
grant execute on function public.can_operate(bigint) to authenticated;
grant execute on function public.in_my_country(bigint) to authenticated;
revoke execute on function public.adjust_stock(bigint, text, bigint, integer, boolean, integer) from public, anon;
revoke execute on function public.set_stock(bigint, text, bigint, integer, text, integer) from public, anon;
revoke execute on function public.record_return(bigint, bigint, jsonb, text) from public, anon;
revoke execute on function public.outstanding_ppe(text, text, text) from public, anon;
grant execute on function public.record_return(bigint, bigint, jsonb, text) to authenticated;
grant execute on function public.outstanding_ppe(text, text, text) to authenticated;
revoke execute on function public.stock_usage(bigint, timestamptz) from public, anon;
grant execute on function public.stock_usage(bigint, timestamptz) to authenticated;
revoke execute on function public.create_handout(bigint, bigint, jsonb, text, text, timestamptz, text) from public, anon;
revoke execute on function public.create_transfer(bigint, bigint, jsonb, text) from public, anon;
revoke execute on function public.delete_handout(bigint, boolean) from public, anon;
revoke execute on function public.exchange_handout(bigint, text, integer, bigint) from public, anon;
grant execute on function public.exchange_handout(bigint, text, integer, bigint) to authenticated;
revoke execute on function public.handout_summary(bigint[], bigint, text, text, timestamptz, timestamptz) from public, anon;
grant execute on function public.handout_summary(bigint[], bigint, text, text, timestamptz, timestamptz) to authenticated;
revoke execute on function public.dashboard_stats(bigint[], timestamptz, timestamptz, text) from public, anon;
grant execute on function public.dashboard_stats(bigint[], timestamptz, timestamptz, text) to authenticated;
grant execute on function public.adjust_stock(bigint, text, bigint, integer, boolean, integer) to authenticated;
grant execute on function public.set_stock(bigint, text, bigint, integer, text, integer) to authenticated;
grant execute on function public.ppe_context(text, text) to authenticated;
grant execute on function public.create_handout(bigint, bigint, jsonb, text, text, timestamptz, text) to authenticated;
grant execute on function public.create_transfer(bigint, bigint, jsonb, text) to authenticated;
grant execute on function public.delete_handout(bigint, boolean) to authenticated;

-- ---------- starter locations (only added when the table is empty) ----------
insert into public.locations (title, country)
select * from (values ('CPH', 'DK'), ('FRD2A', 'DK'), ('Ersbo', 'SE'), ('Kungsgarden', 'SE'), ('Stackbo', 'SE')) v(title, country)
where not exists (select 1 from public.locations);

-- Make the API pick up new/changed functions immediately.
notify pgrst, 'reload schema';
