'use strict';
/**
 * DAKOS SLAYER — الخادم (Express + MongoDB) — جاهز للنشر على Vercel
 * كل المسارات مطابقة لملف API.md الذي تتصل به الواجهة.
 * المتغيرات المطلوبة: انظر .env.example
 */
const express = require('express');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

/* ============================== الثوابت ============================== */
const DAY = 24 * 60 * 60 * 1000;
const ADMIN_TTL_SEC = 12 * 60 * 60;       // صلاحية توكن المشرف
const INITDATA_MAX_AGE = DAY;             // صلاحية بيانات Telegram
const LOGIN_MAX_TRIES = 5;                // محاولات الدخول الفاشلة
const LOGIN_WINDOW = 15 * 60 * 1000;      // ... خلال 15 دقيقة
const HISTORY_MAX = 100;                  // آخر سجل عمليات يُحفظ لكل مستخدم
const PAGE_SIZE = 20;
const PROMO_MAX_TRIES = 10;               // محاولات إدخال كود برومو لكل مستخدم
const PROMO_RE = /^[A-Z0-9_-]{3,24}$/;

const DEFAULT_SETTINGS = { price: 100, welcomeGold: 100, referralGold: 100, dailyGold: 20, channelGold: 50, channel: '' };

const MSG = {
  bad_request: 'طلب غير صالح.', not_found: 'غير موجود.', config: 'الخدمة غير مُهيأة بعد.',
  not_telegram: 'افتح التطبيق من داخل Telegram.', bad_session: 'جلسة غير صالحة.', expired: 'انتهت الجلسة، أعد فتح التطبيق.',
  no_account: 'لا يوجد حساب.', banned: 'هذا الحساب محظور.', insufficient: 'رصيدك من الذهب غير كافٍ.',
  no_link: 'لا يوجد رابط لهذه الحلقة بعد.', daily_wait: 'المكافأة اليومية غير متاحة الآن.', task_done: 'تم استلام هذه المكافأة سابقًا.',
  not_member: 'لم يتم التحقق من اشتراكك في القناة.', channel_off: 'مهمة القناة غير مفعّلة.', channel_check: 'تعذّر التحقق من القناة الآن.',
  promo_invalid: 'كود البرومو غير صحيح.', promo_used: 'استخدمت هذا الكود سابقًا.', promo_exhausted: 'انتهت صلاحية الكود: استُنفد عدد المستفيدين.', promo_exists: 'هذا الكود موجود مسبقًا.',
  admin_auth: 'بيانات الدخول غير صحيحة.', rate_limited: 'محاولات كثيرة، حاول لاحقًا.', error: 'خطأ داخلي في الخادم.'
};

/* ============================== أدوات عامة ============================== */
class HttpError extends Error {
  constructor(status, code, message) { super(message || MSG[code] || code); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new HttpError(status, code, message); };
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
/* ====== القيم المضمّنة (تُستخدم فقط إن لم يُضبط المتغير في Vercel؛ متغيرات Vercel لها الأولوية) ======
 * عبّئ BOT_TOKEN و MONGODB_URI بين علامتي الاقتباس. لا ترفع هذا الملف على GitHub عام وهو يحوي أسرارًا. */
const LOCAL = {
  BOT_TOKEN: '8910839410:AAF1nCNRTkLgoe2fyA5o2P_5pMo-meSCoCo',
  MONGODB_URI: 'mongodb+srv://mohamedfoutani10k_db_user:dakos2004@moneybuxdb.q4kojcz.mongodb.net/?retryWrites=true&w=majority',
  BOT_USERNAME: 'dakoslayer_bot',// ← اسم البوت بدون @ (عدّله إن كان مختلفًا)
  ADMIN_EMAIL: 'admin@dakos.app',
  ADMIN_PASSWORD: 'x6CCgHhA1NH6mdXv',
  ADMIN_SECRET: '02c040b6593755bda3032f750f65d8cefe200366959783dcb55c173328c45d8b',
  TELEGRAM_WEBHOOK_SECRET: 'dakos_wh_7f3a9c1e5b2d4086',
  FRONTEND_URL: 'https://glistening-shortbread-e55027.netlify.app',   // ← رابط الواجهة (https://...) لزر فتح التطبيق في رسائل البوت
  MINI_APP_NAME: '',
  CHANNEL_URL: 'https://t.me/DakosSlayer',        // ← زر «اشترك في قناتنا» في رسالة /start (اتركه فارغًا لإخفائه)
  GROUP_URL: 'https://t.me/dakoslayergroup'       // ← زر «انضم لمجموعتنا» في رسالة /start (اتركه فارغًا لإخفائه)
};
const env = (k, d = '') => String(process.env[k] || LOCAL[k] || d).trim();

const clean = (v, max) => (typeof v === 'string' || typeof v === 'number') ? String(v).trim().slice(0, max) : '';
const int = (v, min, max, label = 'القيمة') => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail(400, 'bad_request', `${label} غير صالحة`);
  return n;
};
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const sid = (v) => {
  const s = (typeof v === 'string' || typeof v === 'number') ? String(v) : '';
  if (!ID_RE.test(s)) fail(400, 'bad_request', 'معرّف غير صالح');
  return s;
};
function httpUrl(v, label = 'الرابط', optional = false) {
  const s = clean(v, 2000);
  if (!s) { if (optional) return ''; fail(400, 'bad_request', `${label} مطلوب`); }
  let u;
  try { u = new URL(s); } catch { fail(400, 'bad_request', `${label} غير صالح`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') fail(400, 'bad_request', `${label} يجب أن يبدأ بـ http أو https`);
  return s;
}
const safeEqHex = (a, b) => {
  const x = Buffer.from(String(a), 'utf8'), y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const clientIp = (req) => (req.get('x-forwarded-for') || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || 'unknown';

/* ============================== قاعدة البيانات ============================== */
let dbPromise = null;
async function getDb() {
  if (!dbPromise) {
    const uri = env('MONGODB_URI');
    if (!uri) fail(500, 'config', 'MONGODB_URI غير مضبوط');
    dbPromise = new MongoClient(uri, { maxPoolSize: 5, serverSelectionTimeoutMS: 8000 }).connect()
      .then(async (client) => {
        const db = client.db(env('MONGODB_DB', 'dakos'));
        await ensureIndexes(db);
        return db;
      })
      .catch((e) => { dbPromise = null; throw e; });
  }
  return dbPromise;
}
async function ensureIndexes(db) {
  try {
    await Promise.all([
      db.collection('users').createIndex({ referralCode: 1 }, { unique: true, sparse: true }),
      db.collection('users').createIndex({ createdAt: -1 }),
      db.collection('users').createIndex({ referredBy: 1, createdAt: -1 }, { sparse: true }),
      db.collection('episodes').createIndex({ seriesId: 1, episode: 1 }, { unique: true }),
      db.collection('stories').createIndex({ seriesId: 1 }),
      db.collection('ratelimit').createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 })
    ]);
  } catch (e) { console.error('index error', e.message); }
}

/* ============================== الإعدادات ============================== */
async function getSettings(db) {
  const d = await db.collection('settings').findOne({ _id: 'main' });
  return { ...DEFAULT_SETTINGS, ...((d && d.values) || {}) };
}
const publicConfig = (s) => ({
  price: s.price, dailyGold: s.dailyGold, channelGold: s.channelGold, referralGold: s.referralGold,
  botUsername: env('BOT_USERNAME', 'dakoslayer_bot').replace(/^@/, ''), miniAppName: env('MINI_APP_NAME'), channel: s.channel
});

/* ============================== هوية المستخدم (Telegram) ============================== */
function verifyInitData(raw) {
  const token = env('BOT_TOKEN');
  if (!token) fail(500, 'config', 'BOT_TOKEN غير مضبوط');
  if (!raw) fail(401, 'not_telegram');
  const params = new URLSearchParams(String(raw));
  const hash = params.get('hash');
  if (!hash) fail(401, 'bad_session');
  params.delete('hash');
  const dcs = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const calc = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  if (!safeEqHex(calc, hash)) fail(401, 'bad_session');
  const authDate = Number(params.get('auth_date')) * 1000;
  if (!authDate || Date.now() - authDate > INITDATA_MAX_AGE) fail(401, 'expired');
  let user;
  try { user = JSON.parse(params.get('user')); } catch { fail(401, 'bad_session'); }
  if (!user || !Number.isSafeInteger(user.id)) fail(401, 'bad_session');
  return { user, startParam: params.get('start_param') || '' };
}
const userAuth = (req, res, next) => {
  try {
    const { user, startParam } = verifyInitData(req.get('x-telegram-init-data'));
    req.tg = user; req.startParam = startParam; next();
  } catch (e) { next(e); }
};
async function activeUser(db, id) {
  const u = await db.collection('users').findOne({ _id: id });
  if (!u) fail(404, 'no_account');
  if (u.banned) fail(403, 'banned');
  return u;
}

/* ============================== هوية المشرف ============================== */
function adminSecret() {
  const s = env('ADMIN_SECRET');
  if (s.length < 16) fail(500, 'config', 'ADMIN_SECRET غير مضبوط (16 حرفًا على الأقل)');
  return s;
}
function signAdmin() {
  const p = Buffer.from(JSON.stringify({ sub: 'admin', exp: Date.now() + ADMIN_TTL_SEC * 1000 })).toString('base64url');
  const s = crypto.createHmac('sha256', adminSecret()).update(p).digest('base64url');
  return `${p}.${s}`;
}
function verifyAdminToken(token) {
  try {
    const [p, s] = String(token || '').split('.');
    if (!p || !s) return false;
    const calc = crypto.createHmac('sha256', adminSecret()).update(p).digest('base64url');
    if (!safeEqHex(calc, s)) return false;
    const data = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    return data.sub === 'admin' && data.exp > Date.now();
  } catch (e) { if (e instanceof HttpError) throw e; return false; }
}
function verifyPassword(input) {
  const stored = env('ADMIN_PASSWORD_HASH');   // الصيغة: salt:hash (scrypt) — أنشئها بـ node hash-password.js
  if (stored) {
    const [salt, hex] = stored.split(':');
    if (!salt || !hex) return false;
    const expect = Buffer.from(hex, 'hex');
    const got = crypto.scryptSync(input, Buffer.from(salt, 'hex'), expect.length || 64);
    return expect.length > 0 && crypto.timingSafeEqual(got, expect);
  }
  const plain = env('ADMIN_PASSWORD');
  if (!plain) fail(500, 'config', 'ADMIN_PASSWORD_HASH أو ADMIN_PASSWORD غير مضبوط');
  const salt = crypto.randomBytes(16);
  return crypto.timingSafeEqual(crypto.scryptSync(input, salt, 64), crypto.scryptSync(plain, salt, 64));
}
const adminAuth = (req, res, next) => {
  try {
    const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
    if (!m || !verifyAdminToken(m[1])) fail(401, 'admin_auth', 'انتهت جلسة المشرف، سجّل الدخول من جديد.');
    next();
  } catch (e) { next(e); }
};

/**
 * عدّاد محاولات الدخول: تحديث ذرّي واحد (زيادة + إعادة ضبط النافذة) يسبق فحص كلمة السر.
 * لذلك لا يمكن لطلبات متزامنة تجاوز الحد: كل طلب يأخذ رقمًا فريدًا، ومن رقمه أكبر من الحد يُرفض قبل أي فحص.
 */
async function loginAttempt(rl, ip) {
  const now = Date.now();
  const run = () => rl.findOneAndUpdate({ _id: ip }, [
    { $set: { _live: { $gt: [{ $ifNull: ['$resetAt', 0] }, now] } } },
    { $set: {
      count: { $add: [{ $cond: ['$_live', { $ifNull: ['$count', 0] }, 0] }, 1] },
      resetAt: { $cond: ['$_live', '$resetAt', now + LOGIN_WINDOW] }
    } },
    { $set: { expireAt: { $toDate: '$resetAt' } } },
    { $unset: '_live' }
  ], { upsert: true, returnDocument: 'after' });
  try { return await run(); } catch (e) { if (e && e.code === 11000) return run(); throw e; }   // سباق إنشاء أول سجل
}

/* ============================== مساعدات البيانات ============================== */
const userName = (u) => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || String(u._id);
const publicUser = (u) => ({ id: u._id, first_name: u.first_name || '', username: u.username || '', language_code: u.language_code || '', photo_url: u.photo_url || '' });
const profileOf = (u) => ({
  gold: u.gold || 0, friends: u.friends || 0, referralGold: u.referralGold || 0, referralCode: String(u._id),
  unlocked: u.unlocked || {}, history: [...(u.history || [])].reverse().slice(0, 50), nextDailyAt: u.nextDailyAt || 0,
  channelClaimed: !!u.channelClaimed
});
const adminRow = (u) => ({
  id: u._id, name: userName(u), username: u.username || '', gold: u.gold || 0, unlocked: u.unlockCount || 0,
  views: u.views || 0, friends: u.friends || 0, banned: !!u.banned, createdAt: u.createdAt || 0, lastSeen: u.lastSeen || 0
});
const pushHistory = (entry) => ({ $each: [{ ...entry, at: Date.now() }], $slice: -HISTORY_MAX });
const newCode = () => crypto.randomBytes(5).toString('hex');

function cleanI18n(v) {
  const out = {};
  if (v && typeof v === 'object') {
    for (const [lang, o] of Object.entries(v).slice(0, 8)) {
      if (!/^[a-z]{2}$/.test(lang) || !o || typeof o !== 'object') continue;
      out[lang] = { title: clean(o.title, 200), description: clean(o.description, 3000) };
    }
  }
  return out;
}
const adminSeries = (s, linked) => ({
  id: s._id, title: s.title, category: s.category, year: s.year, rating: s.rating, image: s.image, tag: s.tag,
  description: s.description, episodes: s.episodes, i18n: s.i18n || {}, views: s.views || 0, linked: linked || []
});
async function linkedMap(db, match = {}) {
  const rows = await db.collection('episodes').aggregate([
    { $match: match }, { $sort: { episode: 1 } }, { $group: { _id: '$seriesId', eps: { $push: '$episode' } } }
  ]).toArray();
  return Object.fromEntries(rows.map((r) => [r._id, r.eps]));
}

async function assertChannelMember(channel, userId) {
  const token = env('BOT_TOKEN');
  if (!token) fail(500, 'config', 'BOT_TOKEN غير مضبوط');
  let data;
  try {
    const url = `https://api.telegram.org/bot${token}/getChatMember?chat_id=${encodeURIComponent('@' + channel)}&user_id=${userId}`;
    data = await (await fetch(url, { signal: AbortSignal.timeout(8000) })).json();
  } catch { fail(502, 'channel_check'); }
  if (!data || !data.ok) {
    if (/user not found|participant_id_invalid/i.test(String(data && data.description))) fail(403, 'not_member');
    fail(502, 'channel_check');
  }
  const st = data.result && data.result.status;
  if (['creator', 'administrator', 'member'].includes(st) || (st === 'restricted' && data.result.is_member)) return;
  fail(403, 'not_member');
}

/* ============================== التسجيل والإحالة (مشترك بين التطبيق والبوت) ============================== */
const tgFields = (tg) => ({
  first_name: clean(tg.first_name, 100), last_name: clean(tg.last_name, 100), username: clean(tg.username, 64),
  language_code: clean(tg.language_code, 10), photo_url: clean(tg.photo_url, 500)
});
const REF_CODE_RE = /^[A-Za-z0-9_-]{4,40}$/;
/** يتحقق من صاحب رابط الإحالة: الكود هو معرّف Telegram الرقمي (ويدعم الأكواد القديمة العشوائية). يجب أن يكون الحساب موجودًا وغير محظور. */
async function findInviter(users, code) {
  const c = String(code || '').trim();
  if (!REF_CODE_RE.test(c)) return null;
  if (/^\d{4,15}$/.test(c)) {
    const id = Number(c);
    if (Number.isSafeInteger(id)) {
      const byId = await users.findOne({ _id: id, banned: { $ne: true } });
      if (byId) return byId;
    }
  }
  return users.findOne({ referralCode: c, banned: { $ne: true } });
}

/**
 * ينشئ الحساب مرة واحدة فقط (upsert ذرّي)، وعند الإنشاء الفعلي فقط تُحتسب الإحالة لصاحب الرابط.
 * لذلك لا تتكرر المكافأة مهما تكرر الضغط على Start أو فتح التطبيق، ولا تُحتسب لحساب قديم.
 */
async function registerAccount(db, tg, settings, startCode) {
  const users = db.collection('users');
  const now = Date.now();
  const welcome = settings.welcomeGold;
  const r = await users.updateOne({ _id: tg.id }, {
    $setOnInsert: {
      ...tgFields(tg), gold: welcome, friends: 0, referralGold: 0, referralCode: String(tg.id), unlocked: {}, views: 0, unlockCount: 0,
      banned: false, createdAt: now, lastSeen: now, history: welcome > 0 ? [{ type: 'welcome', amount: welcome, at: now }] : []
    }
  }, { upsert: true });
  const created = r.upsertedCount > 0;
  let inviter = null;
  if (created && REF_CODE_RE.test(startCode || '')) {
    const found = await findInviter(users, startCode);
    if (found && found._id !== tg.id) {
      await users.updateOne({ _id: found._id }, {
        $inc: { gold: settings.referralGold, friends: 1, referralGold: settings.referralGold },
        $push: { history: pushHistory({ type: 'referral', amount: settings.referralGold }) }
      });
      await users.updateOne({ _id: tg.id }, { $set: { referredBy: found._id, referralReward: settings.referralGold } });
      inviter = found;
    }
  }
  return { created, inviter };
}

/* ============================== رسائل البوت ============================== */
const BOT_TEXT = {
  ar: {
    hello: (n) => `أهلاً ${n} 👋\nاضغط الزر لفتح DAKOS SLAYER وشاهد أحدث المسلسلات.`, open: 'فتح التطبيق 🎬', joined: (g) => `🎉 انضم صديق جديد عبر رابطك وحصلت على ${g} ذهب.`,
    // رسالة الترحيب الكاملة لأمر /start (من ملف البوت القديم) — تُستخدم بدل hello للعربية
    welcome: `✅ مرحبا بكم في تطبيق Dakos Slayer اكبر مكتبة في التلجرام لمشاهدة المسلسلات التركية مترجمة ومدبلجة مجانا وباعلى جودة انزل للاسفل واضغط على " اضغط هنا للمشاهدة" واستمتع 👋🔥`,
    openWatch: '🎬 اضغط هنا للمشاهدة', channelBtn: 'اشترك في قناتنا 💎', groupBtn: 'انضم لمجموعتنا على تلجرام 💡'
  },
  en: {
    hello: (n) => `Welcome ${n} 👋\nTap the button to open DAKOS SLAYER and watch the latest series.`, open: 'Open the app 🎬', joined: (g) => `🎉 A new friend joined through your link — you earned ${g} gold.`,
    channelBtn: 'Join our channel 💎', groupBtn: 'Join our Telegram group 💡'
  },
  fr: {
    hello: (n) => `Bienvenue ${n} 👋\nAppuyez sur le bouton pour ouvrir DAKOS SLAYER.`, open: 'Ouvrir l’app 🎬', joined: (g) => `🎉 Un nouvel ami a rejoint via votre lien — vous gagnez ${g} or.`,
    channelBtn: 'Rejoindre notre chaîne 💎', groupBtn: 'Rejoindre notre groupe Telegram 💡'
  }
};
const botLang = (code) => { const c = String(code || '').slice(0, 2).toLowerCase(); return BOT_TEXT[c] ? c : 'ar'; };
async function botSend(chatId, text, buttonText, extraRows = []) {
  const token = env('BOT_TOKEN');
  if (!token) return;
  const body = { chat_id: chatId, text };
  const web = env('FRONTEND_URL');
  const rows = [];
  if (buttonText && /^https:\/\//i.test(web)) rows.push([{ text: buttonText, web_app: { url: web } }]);
  for (const r of extraRows) rows.push(r);   // أزرار روابط إضافية (القناة والمجموعة)
  if (rows.length) body.reply_markup = { inline_keyboard: rows };
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(6000)
    });
  } catch { /* الرسالة اختيارية؛ لا تُفشل التسجيل */ }
}

/* ============================== التطبيق ============================== */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// CORS: عيّن ALLOWED_ORIGINS (دومين الواجهة) ليُسمح له فقط. إن تُرك فارغًا يُسمح للجميع.
app.use((req, res, next) => {
  const list = env('ALLOWED_ORIGINS').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  const origin = req.get('origin');
  if (!list.length) res.set('Access-Control-Allow-Origin', '*');
  else if (origin && list.includes(origin)) { res.set('Access-Control-Allow-Origin', origin); res.set('Vary', 'Origin'); }
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-telegram-init-data');
  res.set('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.set('Access-Control-Max-Age', '86400');
  res.set('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', (req, res) => res.json({ name: 'dakos-server', ok: true }));

/* ---------- فحص الحالة (بديل /.netlify/functions/health) ---------- */
app.get('/api/health', h(async (req, res) => {
  const checks = {
    mongodb_uri: !!env('MONGODB_URI'), bot_token: !!env('BOT_TOKEN'), bot_username: !!env('BOT_USERNAME', 'dakoslayer_bot'),
    admin_email: !!env('ADMIN_EMAIL'), admin_password: !!(env('ADMIN_PASSWORD_HASH') || env('ADMIN_PASSWORD')),
    admin_secret: env('ADMIN_SECRET').length >= 16
  };
  let db = false;
  try { await (await getDb()).command({ ping: 1 }); db = true; } catch { /* يظهر false */ }
  res.json({ ok: db && Object.values(checks).every(Boolean), db, checks });
}));

/* ======================================================================
   المستخدمون
   ====================================================================== */
app.get('/api/catalog', h(async (req, res) => {
  const db = await getDb();
  const now = Date.now();
  const [series, linked, stories, settings] = await Promise.all([
    db.collection('series').find({}).sort({ createdAt: -1 }).toArray(),
    linkedMap(db),
    db.collection('stories').find({ $or: [{ expiresAt: 0 }, { expiresAt: null }, { expiresAt: { $gt: now } }] }).sort({ createdAt: -1 }).toArray(),
    getSettings(db)
  ]);
  res.json({
    series: series.map((s) => ({
      id: s._id, title: s.title, category: s.category, year: s.year, rating: s.rating, image: s.image, tag: s.tag,
      description: s.description, episodes: s.episodes, i18n: s.i18n || {}, linked: linked[s._id] || []
    })),
    stories: stories.map((s) => ({ id: s._id, title: s.title, image: s.image, text: s.text || '', seriesId: s.seriesId || '' })),
    config: publicConfig(settings)
  });
}));

app.get('/api/user/profile', userAuth, h(async (req, res) => {
  const db = await getDb();
  const users = db.collection('users');
  const settings = await getSettings(db);
  const tg = req.tg;
  const existing = await users.findOne({ _id: tg.id });
  if (existing && existing.banned) fail(403, 'banned');

  let doc;
  if (existing) {
    doc = await users.findOneAndUpdate({ _id: tg.id }, { $set: { ...tgFields(tg), lastSeen: Date.now() } }, { returnDocument: 'after' });
  } else {
    // دخول مباشر للتطبيق (startapp): نفس منطق التسجيل والإحالة المستخدم في البوت
    await registerAccount(db, tg, settings, req.startParam);
    doc = await users.findOne({ _id: tg.id });
  }
  res.json({ user: publicUser(doc), profile: profileOf(doc), config: publicConfig(settings) });
}));

/* قائمة الأصدقاء الذين دعاهم المستخدم + المكافأة التي نالها من كل صديق */
app.get('/api/user/referrals', userAuth, h(async (req, res) => {
  const db = await getDb();
  const users = db.collection('users');
  const me = await activeUser(db, req.tg.id);
  const settings = await getSettings(db);
  const rows = await users.find({ referredBy: me._id })
    .project({ first_name: 1, last_name: 1, username: 1, photo_url: 1, createdAt: 1, referralReward: 1 })
    .sort({ createdAt: -1 }).limit(200).toArray();
  const friends = rows.map((u) => ({
    name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || 'User',
    username: u.username || '',
    photo_url: u.photo_url || '',
    at: u.createdAt || 0,
    gold: Number.isFinite(u.referralReward) ? u.referralReward : settings.referralGold
  }));
  res.json({ success: true, friends, total: me.friends || friends.length, referralGold: me.referralGold || 0 });
}));

app.post('/api/episodes/watch', userAuth, h(async (req, res) => {
  const db = await getDb();
  const users = db.collection('users');
  const seriesId = sid(req.body && req.body.seriesId);
  const episode = int(req.body && req.body.episode, 1, 5000, 'رقم الحلقة');
  const user = await activeUser(db, req.tg.id);

  const series = await db.collection('series').findOne({ _id: seriesId });
  if (!series || episode > series.episodes) fail(404, 'not_found');
  const link = await db.collection('episodes').findOne({ seriesId, episode });
  if (!link) fail(404, 'no_link');                       // لا خصم قبل التأكد من وجود الرابط

  const key = `unlocked.${seriesId}`;
  let alreadyUnlocked = ((user.unlocked || {})[seriesId] || []).includes(episode);
  let updated = null;

  if (!alreadyUnlocked) {
    const price = (await getSettings(db)).price;
    // خصم ذرّي: شرط الرصيد وعدم الفتح المسبق في نفس عملية التحديث
    updated = await users.findOneAndUpdate(
      { _id: user._id, banned: { $ne: true }, gold: { $gte: price }, [key]: { $ne: episode } },
      {
        $inc: { gold: -price, views: 1, unlockCount: 1 },
        $addToSet: { [key]: episode },
        $push: { history: pushHistory({ type: 'episode_unlock', amount: -price, seriesId, episode }) }
      },
      { returnDocument: 'after' }
    );
    if (!updated) {
      const fresh = await activeUser(db, user._id);
      if (((fresh.unlocked || {})[seriesId] || []).includes(episode)) alreadyUnlocked = true;   // سباق طلبين متزامنين
      else fail(402, 'insufficient');
    }
  }
  if (alreadyUnlocked) updated = await users.findOneAndUpdate({ _id: user._id }, { $inc: { views: 1 } }, { returnDocument: 'after' });
  await db.collection('series').updateOne({ _id: seriesId }, { $inc: { views: 1 } });

  res.json({ profile: profileOf(updated), watchUrl: link.watchUrl, alreadyUnlocked });
}));

app.post('/api/tasks/claim', userAuth, h(async (req, res) => {
  const db = await getDb();
  const users = db.collection('users');
  const task = req.body && req.body.task;
  if (task !== 'daily' && task !== 'channel') fail(400, 'bad_request');
  const user = await activeUser(db, req.tg.id);
  const settings = await getSettings(db);
  const now = Date.now();

  if (task === 'daily') {
    const reward = settings.dailyGold;
    const r = await users.findOneAndUpdate(
      { _id: user._id, banned: { $ne: true }, $or: [{ nextDailyAt: null }, { nextDailyAt: { $lte: now } }] },
      { $inc: { gold: reward }, $set: { nextDailyAt: now + DAY }, $push: { history: pushHistory({ type: 'task_daily', amount: reward }) } },
      { returnDocument: 'after' }
    );
    if (!r) fail(429, 'daily_wait');
    return res.json({ profile: profileOf(r), reward });
  }

  if (!settings.channel) fail(400, 'channel_off');
  if (user.channelClaimed) fail(409, 'task_done');
  await assertChannelMember(settings.channel, user._id);
  const reward = settings.channelGold;
  const r = await users.findOneAndUpdate(
    { _id: user._id, banned: { $ne: true }, channelClaimed: { $ne: true } },
    { $inc: { gold: reward }, $set: { channelClaimed: true }, $push: { history: pushHistory({ type: 'task_channel', amount: reward }) } },
    { returnDocument: 'after' }
  );
  if (!r) fail(409, 'task_done');
  res.json({ profile: profileOf(r), reward });
}));

/* ---------- أكواد البرومو: استخدام الكود من قِبل المستخدم ---------- */
app.post('/api/promo/redeem', userAuth, h(async (req, res) => {
  const db = await getDb();
  const users = db.collection('users');
  const promos = db.collection('promos');
  const user = await activeUser(db, req.tg.id);

  // حدّ للمحاولات حتى لا يُخمَّن الكود بالتجربة المتكررة
  const attempt = await loginAttempt(db.collection('ratelimit'), `promo:${user._id}`);
  if (attempt.count > PROMO_MAX_TRIES) fail(429, 'rate_limited');

  const code = clean(req.body && req.body.code, 40).toUpperCase();
  if (!PROMO_RE.test(code)) fail(404, 'promo_invalid');

  // 1) حجز مقعد في الكود ذريًا: لم يستخدمه هذا المستخدم من قبل، وعدد المستخدمين أقل من الحد الأقصى
  const promo = await promos.findOneAndUpdate(
    { _id: code, redeemedBy: { $ne: user._id }, $expr: { $lt: [{ $ifNull: ['$used', 0] }, '$maxUses'] } },
    { $inc: { used: 1 }, $addToSet: { redeemedBy: user._id } },
    { returnDocument: 'after' }
  );
  if (!promo) {
    const p = await promos.findOne({ _id: code }, { projection: { redeemedBy: 1, used: 1, maxUses: 1 } });
    if (!p) fail(404, 'promo_invalid');
    if ((p.redeemedBy || []).includes(user._id)) fail(409, 'promo_used');
    fail(410, 'promo_exhausted');
  }

  // 2) إضافة الذهب للمستخدم؛ إن فشلت (حساب حُذف/حُظر في اللحظة نفسها) يُرجَع المقعد المحجوز
  const reward = promo.perUser;
  const r = await users.findOneAndUpdate(
    { _id: user._id, banned: { $ne: true } },
    { $inc: { gold: reward }, $push: { history: pushHistory({ type: 'promo', amount: reward, note: code }) } },
    { returnDocument: 'after' }
  );
  if (!r) {
    await promos.updateOne({ _id: code }, { $inc: { used: -1 }, $pull: { redeemedBy: user._id } });
    fail(403, 'banned');
  }
  res.json({ profile: profileOf(r), reward });
}));

/* ======================================================================
   بوت Telegram (Webhook): عند ضغط Start من رابط الإحالة  t.me/BOT?start=CODE
   ====================================================================== */
app.post('/api/telegram/webhook', h(async (req, res) => {
  const secret = env('TELEGRAM_WEBHOOK_SECRET');
  if (!secret) fail(500, 'config', 'TELEGRAM_WEBHOOK_SECRET غير مضبوط');
  // ترويسة Telegram الرسمية، تُرسَل مع كل تحديث إن مرّرت secret_token في setWebhook
  if (!safeEqHex(req.get('x-telegram-bot-api-secret-token') || '', secret)) fail(403, 'bad_session', 'ترويسة Telegram غير صحيحة');

  const msg = req.body && req.body.message;
  const from = msg && msg.from;
  const m = msg && typeof msg.text === 'string' ? /^\/start(?:@\w+)?(?:\s+(\S+))?$/.exec(msg.text.trim()) : null;
  if (!m || !from || from.is_bot || !Number.isSafeInteger(from.id) || !msg.chat || msg.chat.type !== 'private') return res.json({ ok: true });

  const db = await getDb();
  const settings = await getSettings(db);
  const existing = await db.collection('users').findOne({ _id: from.id }, { projection: { banned: 1 } });
  if (existing && existing.banned) return res.json({ ok: true });

  const reg = existing ? { created: false, inviter: null } : await registerAccount(db, from, settings, m[1] || '');
  const t = BOT_TEXT[botLang(from.language_code)];
  // أزرار القناة والمجموعة (تظهر فقط إن كانت الروابط https صحيحة)
  const linkRows = [];
  if (/^https:\/\//i.test(env('CHANNEL_URL'))) linkRows.push([{ text: t.channelBtn, url: env('CHANNEL_URL') }]);
  if (/^https:\/\//i.test(env('GROUP_URL'))) linkRows.push([{ text: t.groupBtn, url: env('GROUP_URL') }]);
  const sends = [botSend(from.id, t.welcome || t.hello(clean(from.first_name, 60) || ''), t.openWatch || t.open, linkRows)];
  if (reg.inviter) sends.push(botSend(reg.inviter._id, BOT_TEXT[botLang(reg.inviter.language_code)].joined(settings.referralGold)));
  await Promise.allSettled(sends);
  res.json({ ok: true });
}));

/* تسجيل الـ Webhook للبوت بضغطة واحدة: افتح في المتصفح
   https://<دومين-الخادم>/api/telegram/setup?key=<TELEGRAM_WEBHOOK_SECRET> */
app.get('/api/telegram/setup', h(async (req, res) => {
  const secret = env('TELEGRAM_WEBHOOK_SECRET');
  const token = env('BOT_TOKEN');
  if (!secret || !token) fail(500, 'config', 'TELEGRAM_WEBHOOK_SECRET أو BOT_TOKEN غير مضبوط');
  if (!safeEqHex(String(req.query.key || ''), secret)) fail(403, 'bad_session', 'مفتاح غير صحيح');
  const host = req.get('x-forwarded-host') || req.get('host');
  const url = `https://${host}/api/telegram/webhook`;
  const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, secret_token: secret, allowed_updates: ['message'], drop_pending_updates: true }),
    signal: AbortSignal.timeout(8000)
  }).then((x) => x.json()).catch(() => ({ ok: false, description: 'network' }));
  const info = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`, { signal: AbortSignal.timeout(8000) })
    .then((x) => x.json()).catch(() => null);
  res.json({ success: !!r.ok, webhook_url: url, telegram: r, info: info && info.result ? { url: info.result.url, pending: info.result.pending_update_count, last_error: info.result.last_error_message || null } : null });
}));

/* ======================================================================
   المشرف
   ====================================================================== */
app.post('/api/admin/login', h(async (req, res) => {
  const db = await getDb();
  const rl = db.collection('ratelimit');
  const email = env('ADMIN_EMAIL').toLowerCase();
  if (!email) fail(500, 'config', 'ADMIN_EMAIL غير مضبوط');

  // 1) تُحتسب المحاولة ذريًا قبل أي فحص؛ ما زاد عن الحد يُرفض دون فحص كلمة السر
  const ip = clientIp(req);
  const attempt = await loginAttempt(rl, ip);
  if (attempt.count > LOGIN_MAX_TRIES) fail(429, 'rate_limited');

  // 2) تُنفَّذ المقارنتان دائمًا (زمن ثابت) حتى لا يُكشف أيهما الخاطئ
  const username = clean(req.body && req.body.username, 200).toLowerCase();
  const password = clean(req.body && req.body.password, 200);
  const emailOk = crypto.timingSafeEqual(sha(username), sha(email));
  const passOk = verifyPassword(password);
  if (!(emailOk && passOk)) fail(401, 'admin_auth');

  await rl.deleteOne({ _id: ip });                       // نجاح الدخول يصفّر العدّاد
  res.json({ token: signAdmin(), expiresIn: ADMIN_TTL_SEC });
}));

app.use('/api/admin', adminAuth);

/* ---------- الإحصاءات ---------- */
app.get('/api/admin/stats', h(async (req, res) => {
  const db = await getDb();
  const now = Date.now();
  const startToday = new Date(); startToday.setUTCHours(0, 0, 0, 0);
  const [u, s, linkedCount, top] = await Promise.all([
    db.collection('users').aggregate([{
      $group: {
        _id: null, users: { $sum: 1 },
        banned: { $sum: { $cond: [{ $eq: ['$banned', true] }, 1, 0] } },
        newToday: { $sum: { $cond: [{ $gte: ['$createdAt', startToday.getTime()] }, 1, 0] } },
        activeToday: { $sum: { $cond: [{ $gte: ['$lastSeen', now - DAY] }, 1, 0] } },
        gold: { $sum: '$gold' }, views: { $sum: '$views' }, unlocks: { $sum: '$unlockCount' }
      }
    }]).toArray(),
    db.collection('series').aggregate([{ $group: { _id: null, series: { $sum: 1 }, episodes: { $sum: '$episodes' } } }]).toArray(),
    db.collection('episodes').countDocuments({}),
    db.collection('series').find({ views: { $gt: 0 } }).sort({ views: -1 }).limit(5).toArray()
  ]);
  const a = u[0] || {}, b = s[0] || {};
  res.json({
    stats: {
      series: b.series || 0, episodes: b.episodes || 0, episodesLinked: linkedCount,
      users: a.users || 0, banned: a.banned || 0, newToday: a.newToday || 0, activeToday: a.activeToday || 0,
      gold: a.gold || 0, views: a.views || 0, unlocks: a.unlocks || 0
    },
    top: top.map((x) => ({ id: x._id, title: x.title, views: x.views || 0 }))
  });
}));

/* ---------- المستخدمون ---------- */
app.get('/api/admin/users', h(async (req, res) => {
  const db = await getDb();
  const users = db.collection('users');

  if (req.query.id !== undefined) {                       // تفاصيل مستخدم
    const id = int(req.query.id, 1, Number.MAX_SAFE_INTEGER, 'المعرّف');
    const u = await users.findOne({ _id: id });
    if (!u) fail(404, 'not_found');
    const ids = Object.keys(u.unlocked || {});
    const titles = ids.length ? await db.collection('series').find({ _id: { $in: ids } }).project({ title: 1 }).toArray() : [];
    const tmap = Object.fromEntries(titles.map((t) => [t._id, t.title]));
    return res.json({
      user: {
        ...adminRow(u), referralCode: String(u._id),
        watched: ids.map((k) => ({ seriesId: k, title: tmap[k] || k, episodes: [...u.unlocked[k]].sort((x, y) => x - y) })),
        history: [...(u.history || [])].reverse()
      }
    });
  }

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const q = clean(req.query.q, 64);
  const filter = {};
  if (req.query.status === 'banned') filter.banned = true;
  if (q) {
    const rx = new RegExp(escapeRx(q), 'i');
    filter.$or = [{ username: rx }, { first_name: rx }, { last_name: rx }];
    if (/^\d+$/.test(q) && Number.isSafeInteger(Number(q))) filter.$or.push({ _id: Number(q) });
  }
  const sorts = { joined: { createdAt: -1 }, recent: { lastSeen: -1 }, gold: { gold: -1 }, views: { views: -1 } };
  const sort = { ...(sorts[req.query.sort] || sorts.joined), _id: 1 };
  const [total, rows] = await Promise.all([
    users.countDocuments(filter),
    users.find(filter).sort(sort).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE).toArray()
  ]);
  res.json({ users: rows.map(adminRow), total, page, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) });
}));

app.post('/api/admin/users', h(async (req, res) => {
  const db = await getDb();
  const users = db.collection('users');
  const b = req.body || {};
  const action = b.action;
  const note = clean(b.note, 200);

  if (action === 'gift_all') {
    const amount = int(b.amount, 1, 1e6, 'المبلغ');
    const r = await users.updateMany({ banned: { $ne: true } }, {
      $inc: { gold: amount }, $push: { history: pushHistory({ type: 'admin_gift', amount, note }) }
    });
    return res.json({ gifted: r.modifiedCount });
  }

  const id = int(b.id, 1, Number.MAX_SAFE_INTEGER, 'المعرّف');
  if (action === 'add') {
    const amount = int(b.amount, 1, 1e9, 'المبلغ');
    const r = await users.findOneAndUpdate({ _id: id }, {
      $inc: { gold: amount }, $push: { history: pushHistory({ type: 'admin_adjust', amount, note }) }
    }, { returnDocument: 'after' });
    if (!r) fail(404, 'not_found');
    return res.json({ gold: r.gold });
  }
  if (action === 'subtract' || action === 'set') {
    const amount = int(b.amount, action === 'set' ? 0 : 1, 1e9, 'المبلغ');
    const newGold = action === 'set' ? amount : { $max: [0, { $subtract: [{ $ifNull: ['$gold', 0] }, amount] }] };
    const before = await users.findOneAndUpdate({ _id: id }, [{ $set: { gold: newGold } }], { returnDocument: 'before' });
    if (!before) fail(404, 'not_found');
    const old = before.gold || 0;
    const now = action === 'set' ? amount : Math.max(0, old - amount);
    if (now !== old) await users.updateOne({ _id: id }, { $push: { history: pushHistory({ type: 'admin_adjust', amount: now - old, note }) } });
    return res.json({ gold: now });
  }
  if (action === 'ban' || action === 'unban') {
    const r = await users.updateOne({ _id: id }, { $set: { banned: action === 'ban' } });
    if (!r.matchedCount) fail(404, 'not_found');
    return res.json({ banned: action === 'ban' });
  }
  if (action === 'delete') {
    const r = await users.deleteOne({ _id: id });
    if (!r.deletedCount) fail(404, 'not_found');
    return res.json({ deleted: true });
  }
  fail(400, 'bad_request', 'إجراء غير معروف');
}));

/* ---------- المسلسلات ---------- */
app.get('/api/admin/series', h(async (req, res) => {
  const db = await getDb();
  const [series, linked] = await Promise.all([db.collection('series').find({}).sort({ createdAt: -1 }).toArray(), linkedMap(db)]);
  res.json({ series: series.map((s) => adminSeries(s, linked[s._id])) });
}));

app.post('/api/admin/series', h(async (req, res) => {
  const db = await getDb();
  const b = req.body || {};
  const id = b.id ? sid(b.id) : 's' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
  const title = clean(b.title, 200);
  if (!title) fail(400, 'bad_request', 'عنوان المسلسل مطلوب');
  const fields = {
    title, category: clean(b.category, 40), year: clean(b.year, 10), rating: clean(b.rating, 10),
    image: httpUrl(b.image, 'رابط الصورة', true), tag: clean(b.tag, 40), description: clean(b.description, 3000),
    episodes: int(b.episodes, 1, 2000, 'عدد الحلقات'), i18n: cleanI18n(b.i18n)
  };
  await db.collection('series').updateOne({ _id: id }, { $set: fields, $setOnInsert: { views: 0, createdAt: Date.now() } }, { upsert: true });
  res.json({ saved: true, id });
}));

app.delete('/api/admin/series', h(async (req, res) => {
  const db = await getDb();
  const id = sid(req.body && req.body.id);
  const r = await db.collection('series').deleteOne({ _id: id });
  if (!r.deletedCount) fail(404, 'not_found');
  await Promise.all([db.collection('episodes').deleteMany({ seriesId: id }), db.collection('stories').deleteMany({ seriesId: id })]);
  res.json({ deleted: true });
}));

/* ---------- الحلقات (روابط المشاهدة) ---------- */
app.post('/api/admin/episodes', h(async (req, res) => {
  const db = await getDb();
  const b = req.body || {};
  const seriesId = sid(b.seriesId);
  const series = await db.collection('series').findOne({ _id: seriesId });
  if (!series) fail(404, 'not_found', 'المسلسل غير موجود');
  const ops = [];
  const push = (episode, url, label) => {
    if (episode > series.episodes) fail(400, 'bad_request', `الحلقة ${episode} خارج عدد حلقات المسلسل (${series.episodes})`);
    ops.push({ updateOne: { filter: { seriesId, episode }, update: { $set: { watchUrl: httpUrl(url, label) } }, upsert: true } });
  };
  if (Array.isArray(b.urls)) {                              // دفعة
    if (!b.urls.length || b.urls.length > 500) fail(400, 'bad_request', 'عدد الروابط غير صالح (1 إلى 500)');
    const start = int(b.start, 1, 5000, 'رقم البداية');
    b.urls.forEach((u, i) => push(start + i, u, `الرابط رقم ${i + 1}`));
  } else {                                                  // حلقة واحدة
    push(int(b.episode, 1, 5000, 'رقم الحلقة'), b.watchUrl, 'رابط الحلقة');
  }
  await db.collection('episodes').bulkWrite(ops, { ordered: false });
  res.json({ saved: ops.length });
}));

app.delete('/api/admin/episodes', h(async (req, res) => {
  const db = await getDb();
  const seriesId = sid(req.body && req.body.seriesId);
  const episode = int(req.body && req.body.episode, 1, 5000, 'رقم الحلقة');
  const r = await db.collection('episodes').deleteOne({ seriesId, episode });
  res.json({ deleted: r.deletedCount > 0 });
}));

/* ---------- القصص ---------- */
app.get('/api/admin/stories', h(async (req, res) => {
  const db = await getDb();
  const rows = await db.collection('stories').find({}).sort({ createdAt: -1 }).toArray();
  res.json({
    stories: rows.map((s) => ({
      id: s._id, title: s.title, image: s.image, text: s.text || '', seriesId: s.seriesId || '',
      expiresAt: s.expiresAt || 0, createdAt: s.createdAt || 0
    }))
  });
}));

app.post('/api/admin/stories', h(async (req, res) => {
  const db = await getDb();
  const b = req.body || {};
  const title = clean(b.title, 120);
  if (!title) fail(400, 'bad_request', 'عنوان القصة مطلوب');
  let seriesId = '';
  if (b.seriesId !== undefined && b.seriesId !== null && String(b.seriesId) !== '') {
    seriesId = sid(b.seriesId);
    if (!(await db.collection('series').findOne({ _id: seriesId }, { projection: { _id: 1 } }))) fail(404, 'not_found', 'المسلسل المرتبط غير موجود');
  }
  const hours = int(b.hours === undefined || b.hours === '' ? 24 : b.hours, 0, 720, 'المدة');
  const now = Date.now();
  const id = 'st_' + now.toString(36) + crypto.randomBytes(3).toString('hex');
  await db.collection('stories').insertOne({
    _id: id, title, image: httpUrl(b.image, 'رابط الصورة'), text: clean(b.text, 1000), seriesId,
    expiresAt: hours ? now + hours * 3600 * 1000 : 0, createdAt: now
  });
  res.json({ saved: true, id });
}));

app.delete('/api/admin/stories', h(async (req, res) => {
  const db = await getDb();
  const id = clean(req.body && req.body.id, 60);
  if (!id) fail(400, 'bad_request');
  const r = await db.collection('stories').deleteOne({ _id: id });
  res.json({ deleted: r.deletedCount > 0 });
}));

/* ---------- أكواد البرومو (المشرف) ---------- */
app.get('/api/admin/promos', h(async (req, res) => {
  const db = await getDb();
  const rows = await db.collection('promos').find({}).project({ redeemedBy: 0 }).sort({ createdAt: -1 }).limit(200).toArray();
  res.json({
    promos: rows.map((p) => ({
      code: p._id, perUser: p.perUser, maxUses: p.maxUses, used: p.used || 0, totalGold: p.totalGold, createdAt: p.createdAt || 0
    }))
  });
}));

app.post('/api/admin/promos', h(async (req, res) => {
  const db = await getDb();
  const b = req.body || {};
  const totalGold = int(b.totalGold, 1, 1e7, 'إجمالي الذهب');
  const maxUses = int(b.maxUses, 1, 1e5, 'عدد المستفيدين');
  // الحساب يتم في الخادم دائمًا (لا نثق بقيمة perUser القادمة من الواجهة): إجمالي الذهب ÷ عدد المستفيدين، بدون كسور
  const perUser = Math.floor(totalGold / maxUses);
  if (perUser < 1) fail(400, 'bad_request', 'نصيب كل شخص يجب ألا يقل عن 1 ذهب');
  const code = b.code ? clean(b.code, 40).toUpperCase() : 'DK' + crypto.randomBytes(4).toString('hex').toUpperCase();
  if (!PROMO_RE.test(code)) fail(400, 'bad_request', 'الكود يجب أن يكون 3 إلى 24 حرفًا (أحرف إنجليزية كبيرة وأرقام و - _ فقط)');
  const doc = { _id: code, totalGold, maxUses, perUser, used: 0, redeemedBy: [], createdAt: Date.now() };
  try { await db.collection('promos').insertOne(doc); }
  catch (e) { if (e && e.code === 11000) fail(409, 'promo_exists'); throw e; }
  res.json({ saved: true, promo: { code, perUser, maxUses, used: 0, totalGold, createdAt: doc.createdAt, leftover: totalGold - perUser * maxUses } });
}));

app.delete('/api/admin/promos', h(async (req, res) => {
  const db = await getDb();
  const code = clean(req.body && req.body.code, 40).toUpperCase();
  if (!PROMO_RE.test(code)) fail(400, 'bad_request');
  const r = await db.collection('promos').deleteOne({ _id: code });
  if (!r.deletedCount) fail(404, 'not_found');
  res.json({ deleted: true });
}));

/* ---------- الإعدادات ---------- */
app.get('/api/admin/settings', h(async (req, res) => {
  res.json({ settings: await getSettings(await getDb()) });
}));

app.post('/api/admin/settings', h(async (req, res) => {
  const db = await getDb();
  const b = req.body || {};
  const next = await getSettings(db);
  for (const k of ['price', 'welcomeGold', 'referralGold', 'dailyGold', 'channelGold']) {
    if (b[k] !== undefined) next[k] = int(b[k], 0, 1e6, k);
  }
  if (b.channel !== undefined) {
    const ch = clean(b.channel, 100).replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '');
    if (!/^[A-Za-z0-9_]{0,64}$/.test(ch)) fail(400, 'bad_request', 'اسم القناة غير صالح (بدون @ أو روابط)');
    next.channel = ch;
  }
  await db.collection('settings').updateOne({ _id: 'main' }, { $set: { values: next } }, { upsert: true });
  res.json({ settings: next });
}));

/* ============================== الأخطاء ============================== */
app.use((req, res) => res.status(404).json({ success: false, code: 'not_found', message: MSG.not_found }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ success: false, code: err.code, message: err.message });
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) return res.status(400).json({ success: false, code: 'bad_request', message: MSG.bad_request });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ success: false, code: 'bad_request', message: 'الطلب كبير جدًا.' });
  console.error(err);
  res.status(500).json({ success: false, code: 'error', message: MSG.error });
});

/* على Vercel يُصدَّر التطبيق كما هو، وللتشغيل المحلي: node server.js */
if (require.main === module) {
  const port = Number(process.env.PORT) || 3001;
  app.listen(port, () => console.log(`dakos server on :${port}`));
}
module.exports = app;
