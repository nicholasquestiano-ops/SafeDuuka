/* SafeDuuka backend.
 * One server does everything: REST API + serves the frontend.
 * Env vars: see .env.example
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const { pool, init } = require('./db');

const app = express();
app.use(express.json({ limit: '4mb' })); // snapshots include small photos
app.use(cors());

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) { console.error('JWT_SECRET missing. Copy .env.example to .env and set it.'); process.exit(1); }
const TRIAL_DAYS = 7, PLAN_MONTHS = 1;

/* ---------- helpers ---------- */
const norm = p => String(p || '').replace(/\D/g, '');
const goodPin = p => /^\d{4,14}$/.test(String(p || ''));
const goodPhone = p => /^0\d{9}$/.test(norm(p));

const sign = u => jwt.sign({ uid: u.id, role: u.role, phone: u.phone }, JWT_SECRET, { expiresIn: '180d' });
const auth = (role) => (req, res, next) => {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  try {
    const d = jwt.verify(t, JWT_SECRET);
    if (role && d.role !== role) return res.status(403).json({ error: 'forbidden' });
    req.user = d; next();
  } catch (e) { res.status(401).json({ error: 'Please sign in again.' }); }
};

const sha = s => require('crypto').createHash('sha256').update(s).digest('hex');

async function sendMail(to, subject, text) {
  const key = process.env.BREVO_API_KEY, from = process.env.SENDER_EMAIL;
  if (!key || !from) return false;
  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ sender: { name: 'SafeDuuka', email: from }, to: [{ email: to }], subject, textContent: text })
    });
    return r.ok;
  } catch (e) { return false; }
}

// everything the app needs right after login/signup: state + subscription
async function fullState(shopId) {
  const s = await pool.query('select paid_until, name, owner_name, phone, email, location, photo_url, target_bad, target_avg, target_good, agent_phone from sd_shops where id=$1', [shopId]);
  if (!s.rows.length) return null;
  const st = await pool.query('select data, updated_at from sd_shop_state where shop_id=$1', [shopId]);
  return {
    paid_until: s.rows[0].paid_until,
    profile: { shop: s.rows[0].name, owner: s.rows[0].owner_name, phone: s.rows[0].phone, email: s.rows[0].email, loc: s.rows[0].location, photo: s.rows[0].photo_url, bad: s.rows[0].target_bad, avg: s.rows[0].target_avg, good: s.rows[0].target_good },
    agent: s.rows[0].agent_phone,
    data: st.rows.length ? st.rows[0].data : null,
    updated_at: st.rows.length ? st.rows[0].updated_at : null
  };
}

const wrap = fn => (req, res) => fn(req, res).catch(e => {
  console.error(e);
  res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
});

/* ---------- onboarding (fast + frictionless: one call creates everything) ---------- */
app.post('/api/signup', wrap(async (req, res) => {
  const { name, shop, email, photo, agent } = req.body;
  const phone = norm(req.body.phone), pin = String(req.body.pin || '');
  const bad = +req.body.bad, avg = +req.body.avg, good = +req.body.good;
  if (!name || !shop) return res.status(400).json({ error: 'Your name and the shop name are needed.' });
  if (!goodPhone(phone)) return res.status(400).json({ error: 'Enter a phone number like 0772123456.' });
  if (!goodPin(pin)) return res.status(400).json({ error: 'The PIN must be 4 to 14 digits.' });
  if (!(bad > 0 && avg > bad && good > avg)) return res.status(400).json({ error: 'Targets must go up: bad, average, good.' });

  const exists = await pool.query('select 1 from sd_users where phone=$1', [phone]);
  if (exists.rows.length) return res.status(409).json({ error: 'That phone number already has an account. Sign in instead.' });

  const hash = await bcrypt.hash(pin, 10);
  const c = await pool.query(
    'insert into sd_users(role,phone,name,pin_hash) values ($1,$2,$3,$4) returning id',
    ['owner', phone, name, hash]);
  const s = await pool.query(
    `insert into sd_shops(owner_phone,agent_phone,name,owner_name,phone,email,photo_url,pin_hash,target_bad,target_avg,target_good,paid_until)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now() + interval '${TRIAL_DAYS} days') returning id, paid_until`,
    [phone, agent ? norm(agent) : null, shop, name, phone, email || null, photo || null, hash, bad, avg, good]);
  res.json({ token: sign({ id: c.rows[0].id, role: 'owner', phone }), state: await fullState(s.rows[0].id) });
}));

app.post('/api/login', wrap(async (req, res) => {
  const phone = norm(req.body.phone), pin = String(req.body.pin || '');
  if (!phone || !pin) return res.status(400).json({ error: 'Enter your phone number and PIN.' });
  const u = await pool.query('select * from sd_users where phone=$1', [phone]);
  if (!u.rows.length || !(await bcrypt.compare(pin, u.rows[0].pin_hash)))
    return res.status(401).json({ error: 'Wrong phone number or PIN.' });
  const user = u.rows[0];
  if (user.role === 'agent') {
    const sd_shops = await pool.query('select phone, name, owner_name, agent_phone from sd_shops where agent_phone=$1', [phone]);
    return res.json({
      token: sign(user),
      agent: { name: user.name, phone },
      sd_shops: sd_shops.rows.map(r => ({ phone: r.phone, shop: r.name, owner: r.owner_name, mine: r.agent_phone === phone }))
    });
  }
  const sh = await pool.query('select id from sd_shops where owner_phone=$1', [phone]);
  if (!sh.rows.length) return res.status(409).json({ error: 'This account has no shop yet. Create a shop account.' });
  res.json({ token: sign(user), state: await fullState(sh.rows[0].id) });
}));

/* ---------- data sync ---------- */
app.get('/api/me/state', auth('owner'), wrap(async (req, res) => {
  const sh = await pool.query('select id from sd_shops where owner_phone=$1', [req.user.phone]);
  if (!sh.rows.length) return res.status(404).json({ error: 'no shop' });
  res.json(await fullState(sh.rows[0].id));
}));

app.put('/api/me/state', auth('owner'), wrap(async (req, res) => {
  if (!req.body || typeof req.body.data !== 'object') return res.status(400).json({ error: 'bad data' });
  const sh = await pool.query('select id from sd_shops where owner_phone=$1', [req.user.phone]);
  if (!sh.rows.length) return res.status(404).json({ error: 'no shop' });
  const r = await pool.query(
    `insert into sd_shop_state(shop_id,data,updated_at) values ($1,$2,now())
     on conflict (shop_id) do update set data=$2, updated_at=now() returning updated_at`,
    [sh.rows[0].id, req.body.data]);
  res.json({ updated_at: r.rows[0].updated_at });
}));

/* ---------- PIN ---------- */
app.post('/api/me/pin', auth(), wrap(async (req, res) => {
  const pin = String(req.body.pin || '');
  if (!goodPin(pin)) return res.status(400).json({ error: 'The PIN must be 4 to 14 digits.' });
  const hash = await bcrypt.hash(pin, 10);
  await pool.query('update sd_users set pin_hash=$2 where phone=$1', [req.user.phone, hash]);
  await pool.query('update sd_shops set pin_hash=$2 where owner_phone=$1', [req.user.phone, hash]);
  res.json({ ok: true });
}));

// Step 1: email a 6-digit code to the address saved on the shop
app.post('/api/pin/forgot', wrap(async (req, res) => {
  const phone = norm(req.body.phone);
  const sh = await pool.query('select email from sd_shops where phone=$1', [phone]);
  if (!sh.rows.length) return res.status(404).json({ error: 'no_account' });
  if (!sh.rows[0].email) return res.status(400).json({ error: 'no_email' });
  const sent = await sendMail(sh.rows[0].email, 'Your SafeDuuka reset code',
    `Your SafeDuuka code is ${req._code = String(Math.floor(100000 + Math.random() * 900000))}. It works for 15 minutes.`);
  if (!sent) return res.status(501).json({ error: 'email_not_configured' });
  await pool.query(
    `insert into sd_reset_codes(phone,code_hash,expires_at,tries) values ($1,$2,now() + interval '15 minutes',0)
     on conflict (phone) do update set code_hash=$2, expires_at=now() + interval '15 minutes', tries=0`,
    [phone, sha(req._code + phone)]);
  const e = String(sh.rows[0].email);
  res.json({ ok: true, to: e.replace(/^(.).*(@.*)$/, '$1***$2') });
}));

// Step 2: confirm the code and set the new PIN
app.post('/api/pin/forgot/confirm', wrap(async (req, res) => {
  const phone = norm(req.body.phone), code = String(req.body.code || ''), pin = String(req.body.pin || '');
  if (!goodPin(pin)) return res.status(400).json({ error: 'The PIN must be 4 to 14 digits.' });
  const r = await pool.query('select * from sd_reset_codes where phone=$1', [phone]);
  if (!r.rows.length || new Date(r.rows[0].expires_at) < new Date()) return res.status(400).json({ error: 'expired' });
  if (r.rows[0].tries >= 5) return res.status(429).json({ error: 'too_many' });
  if (r.rows[0].code_hash !== sha(code + phone)) {
    await pool.query('update sd_reset_codes set tries=tries+1 where phone=$1', [phone]);
    return res.status(400).json({ error: 'bad_code' });
  }
  const hash = await bcrypt.hash(pin, 10);
  await pool.query('update sd_users set pin_hash=$2 where phone=$1', [phone, hash]);
  await pool.query('update sd_shops set pin_hash=$2 where owner_phone=$1', [phone, hash]);
  await pool.query('delete from sd_reset_codes where phone=$1', [phone]);
  res.json({ ok: true });
}));

// "Ask for help" requests from the app
app.post('/api/support/request', wrap(async (req, res) => {
  const phone = norm(req.body.phone);
  if (!phone) return res.status(400).json({ error: 'Enter your phone number.' });
  await pool.query('insert into sd_support_requests(phone,note) values ($1,$2)', [phone, req.body.note || null]);
  res.json({ ok: true });
}));

/* ---------- agents ---------- */
app.post('/api/agent/register', wrap(async (req, res) => {
  const phone = norm(req.body.phone), pin = String(req.body.pin || ''), name = String(req.body.name || '').trim();
  if (!name || !goodPhone(phone) || !goodPin(pin))
    return res.status(400).json({ error: 'Enter your name, a phone like 0772123456 and a 4 to 14 digit PIN.' });
  const exists = await pool.query('select 1 from sd_users where phone=$1', [phone]);
  if (exists.rows.length) return res.status(409).json({ error: 'Already registered. Sign in instead.' });
  const c = await pool.query('insert into sd_users(role,phone,name,pin_hash) values ($1,$2,$3,$4) returning id',
    ['agent', phone, name, await bcrypt.hash(pin, 10)]);
  res.json({ token: sign({ id: c.rows[0].id, role: 'agent', phone }), agent: { name, phone }, sd_shops: [] });
}));

app.get('/api/agent/sd_shops', auth('agent'), wrap(async (req, res) => {
  const sd_shops = await pool.query('select phone, name, owner_name from sd_shops where agent_phone=$1', [req.user.phone]);
  res.json({ sd_shops: sd_shops.rows.map(r => ({ phone: r.phone, shop: r.name, owner: r.owner_name, mine: true })) });
}));

// Agent opens one of their sd_shops: read-only view of its data
app.get('/api/agent/shop/:phone', auth('agent'), wrap(async (req, res) => {
  const sh = await pool.query('select id from sd_shops where phone=$1 and agent_phone=$2', [norm(req.params.phone), req.user.phone]);
  if (!sh.rows.length) return res.status(403).json({ error: 'This shop is not on your list.' });
  res.json(await fullState(sh.rows[0].id));
}));

/* ---------- subscription (demo now; Flutterwave plugs in here later) ---------- */
app.post('/api/pay/demo', auth('owner'), wrap(async (req, res) => {
  const sh = await pool.query('select id from sd_shops where owner_phone=$1', [req.user.phone]);
  if (!sh.rows.length) return res.status(404).json({ error: 'no shop' });
  const p = await pool.query(
    'insert into sd_payments(shop_id,amount,phone,provider,status,paid_at) values ($1,$2,$3,$4,$5,now()) returning id',
    [sh.rows[0].id, +(req.body.amount || 10000), req.user.phone, 'demo', 'paid']);
  const r = await pool.query(
    `update sd_shops set paid_until = greatest(now(), paid_until) + interval '${PLAN_MONTHS} months' where id=$1 returning paid_until`,
    [sh.rows[0].id]);
  res.json({ paid_until: r.rows[0].paid_until, payment_id: p.rows[0].id });
}));

/* ---------- meta ---------- */
app.get('/api/health', (req, res) => res.json({ ok: true, service: 'SafeDuuka', time: new Date().toISOString() }));

/* ---------- static frontend (ONE deployment, ONE link) ---------- */
const FRONT = path.join(__dirname, '..', 'frontend');
app.use(express.static(FRONT));
app.get('*', (req, res) => res.sendFile(path.join(FRONT, 'index.html')));

init().then(() => app.listen(PORT, () => console.log(`SafeDuuka running on port ${PORT}`)))
  .catch(e => { console.error('Database init failed:', e.message); process.exit(1); });
