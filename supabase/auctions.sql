-- ====================================================================
-- Credits auction system for Supabase
-- Paste into: Supabase Dashboard > SQL Editor > New query > Run
-- Safe to re-run. Creates public.profiles if it does not exist yet.
-- NOTE: the table must be named lowercase "profiles". If the Table Editor
-- shows "Profiles", rename it first:
--   alter table public."Profiles" rename to profiles;
-- ====================================================================


-- 1. PROFILES ---------------------------------------------------------

create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  credits     bigint not null default 1000,
  username    varchar
);

update public.profiles set credits = 1000 where credits is null;
alter table public.profiles alter column credits set default 1000;   -- starting credits for new users
alter table public.profiles alter column credits set not null;

do $$ begin
  alter table public.profiles
    add constraint profiles_credits_nonneg check (credits >= 0);
exception when duplicate_object then null; end $$;

-- usernames are unique, case-insensitive
create unique index if not exists profiles_username_lower_key
  on public.profiles (lower(username));

-- Users may only READ their own profile. All credit changes go through the
-- functions below, never directly from the browser.
alter table public.profiles enable row level security;

drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;


-- 2. CREATE THE PROFILE AT SIGN UP -------------------------------------
-- The frontend sends the username in the sign-up metadata.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_username text := trim(coalesce(new.raw_user_meta_data->>'username', ''));
begin
  if v_username !~ '^[A-Za-z0-9_]{3,20}$' then
    raise exception 'Username must be 3-20 letters, numbers or underscores';
  end if;

  insert into public.profiles (id, username) values (new.id, v_username);
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- If you created another trigger on auth.users that inserts into profiles,
-- drop it first, or every sign up will try to create two profiles.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- 3. AUCTION TABLES -----------------------------------------------------

create table if not exists public.auctions (
  id                       uuid primary key default gen_random_uuid(),
  created_at               timestamptz not null default now(),
  seller_id                uuid not null references public.profiles(id) on delete cascade,
  seller_username          text not null,
  title                    text not null check (char_length(title) between 1 and 100),
  description              text not null default '' check (char_length(description) <= 500),
  starting_bid             bigint not null check (starting_bid > 0),
  current_bid              bigint check (current_bid > 0),
  current_bidder_id        uuid references public.profiles(id) on delete set null,
  current_bidder_username  text,
  bid_count                int not null default 0,
  ends_at                  timestamptz not null,
  status                   text not null default 'active'
                             check (status in ('active', 'ended', 'cancelled'))
);
create index if not exists auctions_status_ends_idx on public.auctions (status, ends_at);

create table if not exists public.bids (
  id               bigint generated always as identity primary key,
  auction_id       uuid not null references public.auctions(id) on delete cascade,
  bidder_id        uuid not null references public.profiles(id) on delete cascade,
  bidder_username  text not null,
  amount           bigint not null check (amount > 0),
  created_at       timestamptz not null default now()
);
create index if not exists bids_auction_idx on public.bids (auction_id, amount desc);

-- Read-only for logged-in users; every write goes through the functions below.
alter table public.auctions enable row level security;
alter table public.bids     enable row level security;

drop policy if exists "auctions readable" on public.auctions;
create policy "auctions readable" on public.auctions
  for select to authenticated using (true);

drop policy if exists "bids readable" on public.bids;
create policy "bids readable" on public.bids
  for select to authenticated using (true);

revoke all on public.auctions, public.bids from anon, authenticated;
grant select on public.auctions, public.bids to authenticated;

-- live updates in the browser
do $$ begin
  alter publication supabase_realtime add table public.auctions;
exception when duplicate_object then null; end $$;


-- 4. FUNCTIONS (RPC) ----------------------------------------------------

-- Is this username free? Callable before sign up, so it is open to anon.
create or replace function public.is_username_available(p_username text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not exists (
    select 1 from public.profiles where lower(username) = lower(trim(p_username))
  );
$$;


-- List an item. Returns the new auction id.
create or replace function public.create_auction(
  p_title            text,
  p_description      text,
  p_starting_bid     bigint,
  p_duration_minutes int
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  v_username text;
  v_id       uuid;
begin
  if v_uid is null then raise exception 'You must be logged in'; end if;

  p_title       := trim(coalesce(p_title, ''));
  p_description := trim(coalesce(p_description, ''));

  if char_length(p_title) not between 1 and 100 then
    raise exception 'Title must be 1-100 characters';
  end if;
  if char_length(p_description) > 500 then
    raise exception 'Description must be 500 characters or fewer';
  end if;
  if p_starting_bid is null or p_starting_bid not between 1 and 1000000000 then
    raise exception 'Starting bid must be between 1 and 1,000,000,000 credits';
  end if;
  if p_duration_minutes is null or p_duration_minutes not between 1 and 10080 then
    raise exception 'Duration must be between 1 minute and 7 days';
  end if;

  select username into v_username from public.profiles where id = v_uid;
  if v_username is null then raise exception 'Profile not found'; end if;

  insert into public.auctions (seller_id, seller_username, title, description, starting_bid, ends_at)
  values (v_uid, v_username, p_title, p_description, p_starting_bid,
          now() + make_interval(mins => p_duration_minutes))
  returning id into v_id;

  return v_id;
end;
$$;


-- Place a bid. Credits are held in escrow: your bid is deducted immediately,
-- and the previous highest bidder is refunded the moment they are outbid.
create or replace function public.place_bid(p_auction_id uuid, p_amount bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  a          public.auctions%rowtype;
  v_username text;
  v_credits  bigint;
  v_min      bigint;
  v_release  bigint;
begin
  if v_uid is null then raise exception 'You must be logged in'; end if;
  if p_amount is null or p_amount not between 1 and 1000000000 then
    raise exception 'Invalid bid amount';
  end if;

  -- Lock the auction row so simultaneous bids are handled one at a time
  select * into a from public.auctions where id = p_auction_id for update;
  if not found then raise exception 'Auction not found'; end if;
  if a.status <> 'active' or a.ends_at <= now() then
    raise exception 'This auction has ended';
  end if;
  if a.seller_id = v_uid then
    raise exception 'You cannot bid on your own auction';
  end if;

  v_min := case when a.current_bid is null then a.starting_bid else a.current_bid + 1 end;
  if p_amount < v_min then
    raise exception 'Your bid must be at least % credits', v_min;
  end if;

  -- Lock both profiles in a fixed order so two bids can never deadlock
  perform 1 from public.profiles
   where id in (v_uid, a.current_bidder_id)
   order by id for update;

  select username, credits into v_username, v_credits
    from public.profiles where id = v_uid;
  if v_username is null then raise exception 'Profile not found'; end if;

  -- Raising your own bid: your previous bid is released first
  v_release := case when a.current_bidder_id = v_uid then a.current_bid else 0 end;
  if v_credits + v_release < p_amount then
    raise exception 'Not enough credits';
  end if;

  -- Refund the bidder being outbid
  if a.current_bidder_id is not null and a.current_bidder_id <> v_uid then
    update public.profiles set credits = credits + a.current_bid
     where id = a.current_bidder_id;
  end if;

  -- Charge the new bidder
  update public.profiles set credits = credits + v_release - p_amount
   where id = v_uid;

  insert into public.bids (auction_id, bidder_id, bidder_username, amount)
  values (a.id, v_uid, v_username, p_amount);

  update public.auctions
     set current_bid             = p_amount,
         current_bidder_id       = v_uid,
         current_bidder_username = v_username,
         bid_count               = bid_count + 1
   where id = a.id;
end;
$$;


-- Close every auction whose time is up and pay the seller the winning bid.
-- The app calls this on load and when a countdown reaches zero.
-- Returns how many auctions were closed.
create or replace function public.settle_expired_auctions()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.auctions%rowtype;
  n int := 0;
begin
  if auth.uid() is null then raise exception 'You must be logged in'; end if;

  for r in
    select * from public.auctions
     where status = 'active' and ends_at <= now()
     order by ends_at
     limit 50
     for update skip locked
  loop
    if r.current_bidder_id is not null then
      update public.profiles set credits = credits + r.current_bid
       where id = r.seller_id;
    end if;

    update public.auctions set status = 'ended' where id = r.id;
    n := n + 1;
  end loop;

  return n;
end;
$$;


-- Seller cancels their own auction, only while it has no bids.
create or replace function public.cancel_auction(p_auction_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  a     public.auctions%rowtype;
begin
  if v_uid is null then raise exception 'You must be logged in'; end if;

  select * into a from public.auctions where id = p_auction_id for update;
  if not found then raise exception 'Auction not found'; end if;
  if a.seller_id <> v_uid then raise exception 'Only the seller can cancel this auction'; end if;
  if a.status <> 'active' then raise exception 'This auction is no longer active'; end if;
  if a.bid_count > 0 then raise exception 'An auction with bids cannot be cancelled'; end if;

  update public.auctions set status = 'cancelled' where id = a.id;
end;
$$;


-- 5. WHO MAY CALL WHAT --------------------------------------------------

revoke all on function public.create_auction(text, text, bigint, int)  from public, anon, authenticated;
revoke all on function public.place_bid(uuid, bigint)                  from public, anon, authenticated;
revoke all on function public.settle_expired_auctions()                from public, anon, authenticated;
revoke all on function public.cancel_auction(uuid)                     from public, anon, authenticated;
revoke all on function public.is_username_available(text)              from public, anon, authenticated;

grant execute on function public.create_auction(text, text, bigint, int) to authenticated;
grant execute on function public.place_bid(uuid, bigint)                 to authenticated;
grant execute on function public.settle_expired_auctions()               to authenticated;
grant execute on function public.cancel_auction(uuid)                    to authenticated;
grant execute on function public.is_username_available(text)            to anon, authenticated;
