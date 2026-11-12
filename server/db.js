// SafeDuuka database layer. Creates all tables on first boot (zero manual setup).
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '')
    ? false
    : { rejectUnauthorized: false } // managed Postgres (e.g. Supabase) needs TLS
});

const SCHEMA = `
create table if not exists users(
  id serial primary key,
  role text not null check (role in ('owner','agent')),
  phone text not null unique,           -- digits only, e.g. 0772123456
  name text not null,
  pin_hash text not null,
  created_at timestamptz not null default now()
);
create table if not exists shops(
  id serial primary key,
  owner_phone text not null unique references users(phone) on delete cascade,
  agent_phone text,
  name text not null,
  owner_name text not null,
  phone text not null,
  email text,
  location text,
  photo_url text,
  pin_hash text not null,
  target_bad int not null default 100000,
  target_avg int not null default 200000,
  target_good int not null default 300000,
  paid_until timestamptz not null default now() + interval '7 days',  -- free trial
  created_at timestamptz not null default now(),
  check (target_bad < target_avg and target_avg < target_good)
);
create table if not exists shop_state(
  shop_id int primary key references shops(id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists reset_codes(
  phone text primary key,
  code_hash text not null,
  expires_at timestamptz not null,
  tries int not null default 0
);
create table if not exists support_requests(
  id serial primary key,
  phone text not null,
  note text,
  done boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists payments(
  id serial primary key,
  shop_id int not null references shops(id) on delete cascade,
  amount int not null,
  phone text,
  provider text not null default 'demo',
  tx_ref text unique,
  status text not null default 'pending' check (status in ('pending','paid','failed')),
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
`;

async function init() { await pool.query(SCHEMA); }
module.exports = { pool, init };
