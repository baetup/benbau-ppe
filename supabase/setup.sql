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

-- Staff can read their own staff row only (staff are managed in the Supabase dashboard).
drop policy if exists "read own staff row" on public.staff;
create policy "read own staff row" on public.staff
  for select to authenticated
  using (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

-- Staff have full access to the PPE data; nobody else has any.
do $$
declare t text;
begin
  foreach t in array array['locations', 'products', 'stock', 'personnel', 'handouts', 'transfers'] loop
    execute format('drop policy if exists "staff full access" on public.%I', t);
    execute format('create policy "staff full access" on public.%I for all to authenticated using (public.is_staff()) with check (public.is_staff())', t);
  end loop;
end $$;

-- ---------- stock functions (each call is one all-or-nothing transaction) ----------

create or replace function public.adjust_stock(
  p_product_id bigint, p_size text, p_location_id bigint, p_delta integer, p_allow_negative boolean default false)
returns integer
language plpgsql set search_path = public
as $$
declare
  v_qty integer;
begin
  insert into stock (product_id, size, location_id, quantity)
  values (p_product_id, p_size, p_location_id, 0)
  on conflict (product_id, size, location_id) do nothing;

  select quantity into v_qty from stock
  where product_id = p_product_id and size = p_size and location_id = p_location_id
  for update;

  if not p_allow_negative and v_qty + p_delta < 0 then
    raise exception 'Not enough stock of % (%) at %. Available: %.',
      (select title from products where id = p_product_id), p_size,
      (select title from locations where id = p_location_id), v_qty;
  end if;

  update stock set quantity = v_qty + p_delta, updated_at = now()
  where product_id = p_product_id and size = p_size and location_id = p_location_id
  returning quantity into v_qty;
  return v_qty;
end $$;

create or replace function public.set_stock(
  p_product_id bigint, p_size text, p_location_id bigint, p_quantity integer)
returns void
language plpgsql set search_path = public
as $$
begin
  insert into stock (product_id, size, location_id, quantity)
  values (p_product_id, p_size, p_location_id, p_quantity)
  on conflict (product_id, size, location_id)
  do update set quantity = excluded.quantity, updated_at = now();
end $$;

-- p_items: [{ "productId": 1, "size": "L", "qty": 2 }, ...]
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
  v_email  text := auth.jwt() ->> 'email';
  v_by     text := coalesce((select name from staff where lower(email) = lower(auth.jwt() ->> 'email')), auth.jwt() ->> 'email');
begin
  select * into v_person from personnel where id = p_personnel_id;
  if not found then raise exception 'Person not found'; end if;
  select * into v_loc from locations where id = p_location_id;
  if not found then raise exception 'Location not found'; end if;

  for it in select * from jsonb_array_elements(p_items) loop
    select * into v_prod from products where id = (it ->> 'productId')::bigint;
    if not found then raise exception 'Product not found'; end if;
    perform adjust_stock(v_prod.id, it ->> 'size', v_loc.id, -((it ->> 'qty')::integer), false);
    insert into handouts (batch_id, personnel_id, personnel_name, product_id, title, size, quantity,
                          location_id, location_name, reason, notes, handout_date,
                          handed_out_by, handed_out_by_email, signature)
    values (v_batch, v_person.id, v_person.title, v_prod.id, v_prod.title, it ->> 'size', (it ->> 'qty')::integer,
            v_loc.id, v_loc.title, p_reason, p_notes, coalesce(p_date, now()),
            v_by, v_email, p_signature)
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

  for it in select * from jsonb_array_elements(p_items) loop
    select * into v_prod from products where id = (it ->> 'productId')::bigint;
    if not found then raise exception 'Product not found'; end if;
    perform adjust_stock(v_prod.id, it ->> 'size', v_from.id, -((it ->> 'qty')::integer), false);
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
  if p_return_to_stock and h.location_id is not null and h.product_id is not null then
    perform adjust_stock(h.product_id, h.size, h.location_id, h.quantity, true);
  end if;
  delete from handouts where id = p_id;
end $$;

-- Only signed-in users may call the functions (row level security still applies inside them).
revoke execute on function public.adjust_stock(bigint, text, bigint, integer, boolean) from public, anon;
revoke execute on function public.set_stock(bigint, text, bigint, integer) from public, anon;
revoke execute on function public.create_handout(bigint, bigint, jsonb, text, text, timestamptz, text) from public, anon;
revoke execute on function public.create_transfer(bigint, bigint, jsonb, text) from public, anon;
revoke execute on function public.delete_handout(bigint, boolean) from public, anon;
grant execute on function public.adjust_stock(bigint, text, bigint, integer, boolean) to authenticated;
grant execute on function public.set_stock(bigint, text, bigint, integer) to authenticated;
grant execute on function public.create_handout(bigint, bigint, jsonb, text, text, timestamptz, text) to authenticated;
grant execute on function public.create_transfer(bigint, bigint, jsonb, text) to authenticated;
grant execute on function public.delete_handout(bigint, boolean) to authenticated;

-- ---------- starter locations (only added when the table is empty) ----------
insert into public.locations (title, country)
select * from (values ('CPH', 'DK'), ('FRD2A', 'DK'), ('Ersbo', 'SE'), ('Kungsgarden', 'SE'), ('Stackbo', 'SE')) v(title, country)
where not exists (select 1 from public.locations);
