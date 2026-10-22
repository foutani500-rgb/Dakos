const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const crypto = require('crypto');
const https = require('https');
require('dotenv').config();

const app = express();
app.disable('x-powered-by');
// Railway يضع وسيطًا واحدًا أمام التطبيق؛ بدون هذا السطر سيظهر كل المستخدمين بنفس عنوان IP.
app.set('trust proxy', 1);

// يمكن تقييد مصادر المتصفح عبر CORS_ORIGINS مفصولة بفواصل في بيئة التشغيل.
const configuredOrigins = (process.env.CORS_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean);
app.use(cors({
  origin(origin, callback) {
    if (!origin || configuredOrigins.length === 0 || configuredOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin is not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-telegram-init-data'],
  maxAge: 600
}));
app.use(express.json({ limit: '100kb' }));

// --------------------------------------------------
// تحديد معدل الطلبات (Rate Limiting) دون مكتبات خارجية.
// المفتاح: هوية Telegram الموثقة إن وُجدت، وإلا عنوان IP.
// الذاكرة محلية للعملية؛ إن شغّلت أكثر من نسخة فسيُحسب الحد لكل نسخة على حدة.
// --------------------------------------------------
const rateLimitStore = new Map();

function rateLimitKeyFor(req) {
  try {
    const verified = verifyTelegramInitData(req.get('x-telegram-init-data'));
    if (verified) return `u:${verified.id}`;
  } catch (err) {
    // نرجع إلى IP عند أي خطأ في التحقق.
  }
  return `ip:${req.ip}`;
}

function createRateLimiter(name, windowMs, max, options = {}) {
  const perIpOnly = Boolean(options.perIpOnly);
  return function rateLimiter(req, res, next) {
    const now = Date.now();
    const key = `${name}|${perIpOnly ? `ip:${req.ip}` : rateLimitKeyFor(req)}`;
    let entry = rateLimitStore.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      rateLimitStore.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        success: false,
        message: `طلبات كثيرة جدًا. حاول بعد ${retryAfter} ثانية.`,
        retryAfter
      });
    }
    return next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore) {
    if (entry.resetAt <= now) rateLimitStore.delete(key);
  }
}, 60 * 1000).unref();

// حد عام لكل IP (واسع لأن عدة مستخدمين قد يشتركون في IP واحد)؛ يستثني استطلاع الصاروخ وpostback الخاص بـ Monetag.
const globalIpLimiter = createRateLimiter('global', 60 * 1000, 600, { perIpOnly: true });
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/games/rocket') || req.path === '/monetag/postback') return next();
  return globalIpLimiter(req, res, next);
});

// حدود أضيق للمسارات الحساسة (لكل مستخدم موثق في الدقيقة).
app.use('/api/promo', createRateLimiter('promo', 60 * 1000, 15));
app.use('/api/tasks/complete', createRateLimiter('task-complete', 60 * 1000, 20));
app.use('/api/tasks/visit-ticket', createRateLimiter('task-ticket', 60 * 1000, 40));
app.use(['/api/wallet/exchange', '/api/wallet/convert'], createRateLimiter('wallet-convert', 60 * 1000, 30));
app.use(['/api/wallet/withdraw', '/api/wallet/deposit'], createRateLimiter('wallet-money', 60 * 1000, 10));
app.use(['/api/user/transfer', '/api/transfer', '/api/wallet/transfer'], createRateLimiter('transfer', 60 * 1000, 20));
app.use('/api/friends/claim', createRateLimiter('friends-claim', 60 * 1000, 20));
app.use('/api/monetag/start', createRateLimiter('monetag-start', 60 * 1000, 12));
app.use('/api/user/profile', createRateLimiter('profile', 60 * 1000, 60));
app.use(['/api/games/rocket/start', '/api/games/rocket/cashout'], createRateLimiter('rocket-action', 60 * 1000, 60));

// لا تضع بيانات MongoDB السرية مباشرة في الكود.
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error('❌ يجب ضبط MONGO_URI في متغيرات البيئة');
}

mongoose.connect(MONGO_URI || 'mongodb://127.0.0.1:27017/moneyslayer')
  .then(() => {
    console.log('✅ تم الاتصال بقاعدة بيانات MongoDB');
    // الإحالات المسجّلة قبل قاعدة "إكمال المهام" دُفعت مكافأتها فعلًا؛ نعلّمها مؤهّلة كي لا تُدفع مرتين.
    User.updateMany(
      { referredBy: { $nin: [null, ''] }, referralQualified: { $exists: false } },
      { $set: { referralQualified: true, referralQualifiedAt: new Date() } }
    ).then((r) => {
      if (r && r.modifiedCount) console.log(`ℹ️ تم ترحيل ${r.modifiedCount} إحالة قديمة إلى حالة مؤهّلة`);
    }).catch((migrationErr) => console.error('referral migration error:', migrationErr.message));
    // تحميل إعدادات الصاروخ المحفوظة، مع تحديث دوري كي تتزامن النسخ المتعددة من السيرفر.
    loadRocketConfig().catch((configErr) => console.error('rocket config load error:', configErr.message));
    if (!globalThis.__rocketConfigTimer) {
      globalThis.__rocketConfigTimer = setInterval(() => {
        loadRocketConfig().catch((configErr) => console.error('rocket config refresh error:', configErr.message));
      }, 60 * 1000);
    }
    // محرك الجولات يعمل حتى عند عدم وجود لاعبين متصلين.
    // يبدأ فقط بعد نجاح اتصال قاعدة البيانات، وأخطاء الدورة لا توقف السيرفر.
    if (!globalThis.__rocketRoundTimer) {
      globalThis.__rocketRoundTimer = setInterval(async () => {
        if (mongoose.connection.readyState !== 1) return;
        try {
          await ensurePublicRocketRound();
        } catch (err) {
          console.error('❌ خطأ في دورة الصاروخ الخلفية:', err.message);
        }
      }, 500);
    }
  })
  .catch((err) => console.error('❌ خطأ في الاتصال بقاعدة البيانات:', err));

const ADMIN_ID = '6669520092';
// يجب ضبط هذا المتغير في Railway باستخدام رمز البوت الحقيقي من BotFather.
// لا تضع الرمز مباشرة في هذا الملف ولا تتجاوز التحقق عند غيابه.
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();

// مكافأة الإحالة الثابتة: 1000 Gold لكل مستخدم جديد تتم إحالته مرة واحدة فقط.
const REFERRAL_REWARD_GOLD = 1000;
// عدد المهام المطلوب من الصديق قبل دفع مكافأة الإحالة. 0 = بلا شرط: تُضاف المكافأة فور تسجيل الإحالة.
// (يمكن إعادة تفعيل الشرط بضبط REFERRAL_QUALIFY_TASKS > 0 وتعديل registerReferral ليعلّم الإحالة غير مؤهلة.)
const REFERRAL_QUALIFY_TASKS = 0;
// الصديق يُعد "نشطًا" إذا فتح التطبيق خلال آخر 7 أيام.
const FRIEND_ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// مكافأة المهام: 1000 Gold (= 0.05$) لكل مهمة، لكن فقط بعد التحقق الفعلي من الانضمام عبر Telegram Bot API.
// تنبيه: المنشئ يدفع حاليًا 1$ لكل 50 منفّذًا (= 0.02$ للإنجاز)، أي أقل من قيمة هذه المكافأة،
// فتبقى إمكانية الربح من تدوير الرصيد بحسابات وهمية قائمة ما لم يُرفع سعر إنشاء المهمة (انظر createPaidTask).
const TASK_REWARD_GOLD = 1000;
// سقف يومي (بتوقيت UTC) لعدد المهام التي يُكافأ عليها المستخدم؛ الافتراضي 100 وقابل للضبط عبر DAILY_TASK_REWARD_LIMIT.
const DAILY_TASK_REWARD_LIMIT = Math.max(1, Number.parseInt(process.env.DAILY_TASK_REWARD_LIMIT, 10) || 100);
// للمهام التي لا يمكن التحقق منها عبر تلغرام: أقل مدة بين فتح الرابط وطلب المكافأة (ضع 0 لإلغائها).
const UNVERIFIABLE_TASK_MIN_WAIT_MS = 10 * 1000;
// أقل فاصل بين محاولتي تحقق لنفس المستخدم لحماية حصة Bot API من الإغراق.
const TASK_VERIFY_COOLDOWN_MS = 3000;

// إعدادات الصاروخ
// هامش نظري مستهدف للعبة: 15% على المدى الطويل وفق نموذج الاحتمالات أدناه؛
// ليس ضمانًا لربح المنصة في كل جولة أو فترة قصيرة.
const ROCKET_HOUSE_EDGE = 0.15;
// حقول توافق قديمة للواجهة؛ ليست نسبة فوز مضمونة لكل لاعب.
const ROCKET_LOSS_RATE = 65;
const ROCKET_WIN_RATE = 35;
const ROCKET_MAX_MULTIPLIER = 20;
const ROCKET_MIN_BET = 1;
const ROCKET_MAX_BET = 1000000;
// الإعدادات الحية للصاروخ: تبدأ بالقيم الافتراضية أعلاه، ثم تُحمَّل من قاعدة البيانات
// وتُعدَّل من لوحة الأدمن (/api/admin/update-rocket) وتسري على الجولات الجديدة.
const rocketConfig = {
  houseEdge: ROCKET_HOUSE_EDGE,
  maxMultiplier: ROCKET_MAX_MULTIPLIER,
  minBet: ROCKET_MIN_BET,
  maxBet: ROCKET_MAX_BET,
  updatedAt: null,
  updatedBy: null
};
const ROCKET_GROWTH_RATE = 0.12; // سرعة نمو المضاعف

// --------------------------------------------------
// النماذج
// --------------------------------------------------

const userSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true },
  name: { type: String, default: 'زائر كريم' },
  // كل حساب جديد يبدأ برصيد صفر؛ لا توجد هدايا ابتدائية.
  gold: { type: Number, default: 0 },
  // diamonds هو رصيد عملة GRAM في المحفظة.
  diamonds: { type: Number, default: 0 },
  // أرصدة العملات الأخرى الناتجة عن التحويل من المحفظة.
  trx: { type: Number, default: 0 },
  btc: { type: Number, default: 0 },
  eth: { type: Number, default: 0 },
  sol: { type: Number, default: 0 },
  balance: { type: Number, default: 0 },
  currency: { type: String, default: 'MAD' },
  referralCount: { type: Number, default: 0 },
  // هوية المستخدم الذي أحال هذا المستخدم؛ تمنع احتساب الإحالة أكثر من مرة.
  referredBy: { type: String, default: null, index: true },
  referralRewardedAt: { type: Date, default: null },
  // تأهيل الإحالة: يصبح true بعد إكمال هذا المستخدم عددًا كافيًا من المهام ودفع مكافأة المُحيل.
  // لا نضع default عمدًا؛ الغياب = إحالة قديمة تُرحَّل عند الاتصال بقاعدة البيانات.
  referralQualified: { type: Boolean },
  referralQualifiedAt: { type: Date },
  // مكافآت الإحالة المعلّقة (تنتظر ضغط زر الاستلام) والمستلمة سابقًا.
  pendingReferralGold: { type: Number, default: 0 },
  totalReferralGold: { type: Number, default: 0 },
  lastActiveAt: { type: Date, default: Date.now },
  isBanned: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// إحالة معلّقة: تُحفظ عندما يرسل المستخدم الجديد /start ref_<id> للبوت (هوية موثوقة من Telegram)،
// ثم تُستهلك عند إنشاء حسابه أول مرة في /api/user/profile. تنتهي تلقائيًا بعد 7 أيام.
const pendingReferralSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true },
  referrerId: { type: String, required: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } }
}, { timestamps: true });
const PendingReferral = mongoose.model('PendingReferral', pendingReferralSchema);
const PENDING_REFERRAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const taskSchema = new mongoose.Schema({
  title: { type: String, required: true },
  platform: { type: String, required: true },
  link: { type: String, required: true },
  current: { type: Number, default: 0 },
  target: { type: Number, required: true },
  cost: { type: String, required: true },
  creatorId: { type: String, required: true },
  completedBy: [{ type: String }],
  status: { type: String, default: 'جارٍ التنفيذ' },
  createdAt: { type: Date, default: Date.now }
});
const Task = mongoose.model('Task', taskSchema);

// Short-lived, single-use server-issued proof that a user opened a task link.
const taskVisitTicketSchema = new mongoose.Schema({
  tokenHash: { type: String, required: true, unique: true, index: true },
  taskId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  userId: { type: String, required: true, index: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  usedAt: { type: Date, default: null }
}, { timestamps: true });
const TaskVisitTicket = mongoose.model('TaskVisitTicket', taskVisitTicketSchema);

// عداد يومي لمكافآت المهام لكل مستخدم (يُحذف تلقائيًا بعد يومين).
const taskDailyCounterSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  day: { type: String, required: true }, // YYYY-MM-DD بتوقيت UTC
  count: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true, index: { expires: 0 } }
});
taskDailyCounterSchema.index({ userId: 1, day: 1 }, { unique: true });

const TaskDailyCounter = mongoose.model('TaskDailyCounter', taskDailyCounterSchema);

// Monetag rewarded-ad attempts and daily limits.
const MONETAG_ZONE_ID = '12092133';
const MONETAG_REWARD_GOLD = 500;
const MONETAG_DAILY_LIMIT = 50;
const MONETAG_COOLDOWN_MS = 60 * 1000;
const monetagAttemptSchema = new mongoose.Schema({
  ymid: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, index: true },
  day: { type: String, required: true, index: true },
  status: { type: String, enum: ['pending', 'rewarded', 'rejected'], default: 'pending' },
  createdAt: { type: Date, default: Date.now },
  rewardedAt: { type: Date, default: null }
});
monetagAttemptSchema.index({ userId: 1, day: 1, createdAt: -1 });
const MonetagAttempt = mongoose.model('MonetagAttempt', monetagAttemptSchema);
const monetagDailySchema = new mongoose.Schema({
  userId: { type: String, required: true },
  day: { type: String, required: true },
  count: { type: Number, default: 0 },
  lastStartedAt: { type: Date, default: null }
});
monetagDailySchema.index({ userId: 1, day: 1 }, { unique: true });
const MonetagDaily = mongoose.model('MonetagDaily', monetagDailySchema);



const promoSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  amount: { type: Number, required: true },
  type: { type: String, required: true, default: 'gold' },
  maxUses: { type: Number, default: 100 },
  usedCount: { type: Number, default: 0 },
  usedBy: [{ type: String }],
  createdAt: { type: Date, default: Date.now }
});
// بيانات تمويل الرموز التي ينشئها المستخدمون. الرموز الإدارية القديمة تبقى متوافقة.
promoSchema.add({
  creatorId: { type: String, default: null, index: true },
  fundedAmount: { type: Number, default: 0 },
  feeAmount: { type: Number, default: 0 },
  feeRate: { type: Number, default: 0 },
  fundingStatus: { type: String, enum: ['legacy', 'funded'], default: 'legacy', index: true }
});
const Promo = mongoose.model('Promo', promoSchema);

// سجل مستقل لرسوم المنصة المحصلة من إنشاء الرموز الممولة.
const platformFeeSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  promoCode: { type: String, required: true, unique: true },
  amount: { type: Number, required: true, min: 0 },
  rate: { type: Number, required: true, default: 5 },
  createdAt: { type: Date, default: Date.now }
});
const PlatformFee = mongoose.model('PlatformFee', platformFeeSchema);

// سجل إيرادات المنصة الناتجة عن رسوم تحويل العملات. كل عملية تُسجَّل بعملتها الأصلية:
// - إذا كان التحويل من الذهب: الرسوم تُحتسب بالذهب (currency = 'gold').
// - إذا كان التحويل من عملة أخرى (USDT/GRAM/TRX/BTC/ETH/SOL): الرسوم تُحتسب بالدولار (currency = 'usd').
// يُسجَّل أيضًا تفصيل التحويل ليظهر ضمن نشاطات المستخدم في لوحة الإدارة.
const platformRevenueSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  source: { type: String, required: true, default: 'convert_fee', index: true },
  currency: { type: String, enum: ['gold', 'usd'], required: true, index: true },
  amount: { type: Number, required: true, min: 0 },
  from: { type: String, default: null },
  to: { type: String, default: null },
  sourceAmount: { type: Number, default: 0 },
  receivedAmount: { type: Number, default: 0 },
  usdValue: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});
const PlatformRevenue = mongoose.model('PlatformRevenue', platformRevenueSchema);

const transactionSchema = new mongoose.Schema({
  txId: { type: String, required: true },
  userId: { type: String, required: true },
  type: { type: String, required: true },
  amount: { type: Number, required: true },
  method: { type: String, required: true },
  details: { type: String },
  status: { type: String, default: 'pending' },
  date: { type: String, default: () => new Date().toLocaleString() },
  createdAt: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', transactionSchema);

// جولات الصاروخ: النتيجة ووقت الانفجار محفوظان على السيرفر.
const rocketRoundSchema = new mongoose.Schema({
  roundId: { type: String, required: true, unique: true },
  userId: { type: String, required: true, index: true },
  betAmount: { type: Number, required: true },
  crashMultiplier: { type: Number, required: true },
  startedAt: { type: Date, required: true },
  crashAt: { type: Date, required: true },
  status: {
    type: String,
    enum: ['running', 'crashed', 'cashed_out'],
    default: 'running',
    index: true
  },
  cashOutMultiplier: { type: Number, default: null },
  wonAmount: { type: Number, default: 0 },
  settledAt: { type: Date, default: null }
}, { timestamps: true });

rocketRoundSchema.index({ userId: 1, status: 1 });
const RocketRound = mongoose.model('RocketRound', rocketRoundSchema);

// الجولات العامة المشتركة: يشاهد جميع اللاعبين الصاروخ ونقطة الانفجار نفسها.
const publicRocketRoundSchema = new mongoose.Schema({
  roundId: { type: String, required: true, unique: true },
  status: { type: String, enum: ['betting', 'running', 'crashed'], default: 'betting', index: true },
  crashMultiplier: { type: Number, required: true },
  bettingEndsAt: { type: Date, required: true },
  startedAt: { type: Date, default: null },
  crashAt: { type: Date, default: null },
  crashedAt: { type: Date, default: null }
}, { timestamps: true });
publicRocketRoundSchema.index({ status: 1, createdAt: -1 });
const PublicRocketRound = mongoose.model('PublicRocketRound', publicRocketRoundSchema);

// لا يظهر اللاعب في قائمة الجولة إلا بعد إنشاء رهان فعلي وحفظه.
const rocketBetSchema = new mongoose.Schema({
  roundId: { type: String, required: true, index: true },
  userId: { type: String, required: true, index: true },
  betSlot: { type: Number, default: 1, min: 1, max: 2 },
  betAmount: { type: Number, required: true },
  status: { type: String, enum: ['active', 'cashed_out', 'lost'], default: 'active', index: true },
  cashOutMultiplier: { type: Number, default: null },
  wonAmount: { type: Number, default: 0 },
  cashedOutAt: { type: Date, default: null }
}, { timestamps: true });
rocketBetSchema.index({ roundId: 1, userId: 1, betSlot: 1 }, { unique: true });
rocketBetSchema.index({ roundId: 1, status: 1 });
const RocketBet = mongoose.model('RocketBet', rocketBetSchema);

// --------------------------------------------------
// السجل المالي الموحّد (Ledger)
// كل تغيير في أي رصيد يُسجَّل هنا بإشارة (+ إضافة / - خصم) مع الرصيد بعد العملية.
// العمليات داخل معاملات MongoDB تُسجَّل ضمن نفس المعاملة (ذرية)، وغيرها تُسجَّل بعد نجاحها دون إيقاف العملية عند الفشل.
// --------------------------------------------------
const ledgerEntrySchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  type: { type: String, required: true, index: true },
  // اسم حقل الرصيد في المستخدم: gold | balance | diamonds | trx | btc | eth | sol
  currency: { type: String, required: true, index: true },
  amount: { type: Number, required: true },
  balanceAfter: { type: Number, default: null },
  // مفتاح يربط القيد بالعملية الأصلية (مهمة، رهان، رمز...) ويمنع تكرار العرض.
  refKey: { type: String, default: null, index: true },
  description: { type: String, default: '' },
  meta: { type: mongoose.Schema.Types.Mixed, default: null },
  createdAt: { type: Date, default: Date.now, index: true }
});
ledgerEntrySchema.index({ userId: 1, createdAt: -1 });
ledgerEntrySchema.index({ type: 1, createdAt: -1 });
const LedgerEntry = mongoose.model('LedgerEntry', ledgerEntrySchema);

async function recordLedger(entries, options = {}) {
  const list = (Array.isArray(entries) ? entries : [entries])
    .filter((entry) => entry && entry.userId && entry.currency && Number.isFinite(Number(entry.amount)) && Number(entry.amount) !== 0)
    .map((entry) => ({
      userId: String(entry.userId),
      type: String(entry.type),
      currency: String(entry.currency),
      amount: Number(entry.amount),
      balanceAfter: Number.isFinite(Number(entry.balanceAfter)) ? Number(entry.balanceAfter) : null,
      refKey: entry.refKey ? String(entry.refKey) : null,
      description: String(entry.description || '').slice(0, 300),
      meta: entry.meta || null
    }));
  if (!list.length) return;
  if (options.session) {
    // داخل معاملة: أي فشل يُلغي المعاملة كلها كي لا يتغير رصيد بلا قيد.
    await LedgerEntry.create(list, { session: options.session, ordered: true });
    return;
  }
  try {
    await LedgerEntry.create(list);
  } catch (ledgerErr) {
    console.error('ledger write error:', ledgerErr.message);
  }
}

// سجل تدقيق لإجراءات الأدمن الحساسة.
const adminAuditSchema = new mongoose.Schema({
  adminId: { type: String, required: true },
  action: { type: String, required: true, index: true },
  target: { type: String, default: null },
  details: { type: mongoose.Schema.Types.Mixed, default: null },
  createdAt: { type: Date, default: Date.now, index: true }
});
const AdminAudit = mongoose.model('AdminAudit', adminAuditSchema);

async function recordAdminAudit(adminId, action, target, details) {
  try {
    await AdminAudit.create({ adminId: String(adminId), action, target: target ? String(target) : null, details: details || null });
  } catch (auditErr) {
    console.error('admin audit write error:', auditErr.message);
  }
}

// --------------------------------------------------
// إعدادات الصاروخ المخزنة في قاعدة البيانات
// --------------------------------------------------
const rocketSettingsSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, default: 'rocket' },
  houseEdge: { type: Number, required: true },
  maxMultiplier: { type: Number, required: true },
  minBet: { type: Number, required: true },
  maxBet: { type: Number, required: true },
  updatedBy: { type: String, default: null },
  updatedAt: { type: Date, default: Date.now }
});
const RocketSettings = mongoose.model('RocketSettings', rocketSettingsSchema);

const ROCKET_LIMITS = {
  houseEdgePercent: { min: 0.5, max: 30 },
  maxMultiplier: { min: 1.5, max: 100 },
  minBet: { min: 1, max: 1000000000 },
  maxBet: { min: 1, max: 1000000000 }
};

function applyRocketConfig(values) {
  if (!values) return;
  const edge = Number(values.houseEdge);
  const maxMultiplier = Number(values.maxMultiplier);
  const minBet = Number(values.minBet);
  const maxBet = Number(values.maxBet);
  if (Number.isFinite(edge) && edge >= ROCKET_LIMITS.houseEdgePercent.min / 100 && edge <= ROCKET_LIMITS.houseEdgePercent.max / 100) {
    rocketConfig.houseEdge = edge;
  }
  if (Number.isFinite(maxMultiplier) && maxMultiplier >= ROCKET_LIMITS.maxMultiplier.min && maxMultiplier <= ROCKET_LIMITS.maxMultiplier.max) {
    rocketConfig.maxMultiplier = maxMultiplier;
  }
  if (Number.isSafeInteger(minBet) && Number.isSafeInteger(maxBet) && minBet >= 1 && maxBet >= minBet) {
    rocketConfig.minBet = minBet;
    rocketConfig.maxBet = maxBet;
  }
  rocketConfig.updatedAt = values.updatedAt || rocketConfig.updatedAt;
  rocketConfig.updatedBy = values.updatedBy || rocketConfig.updatedBy;
}

async function loadRocketConfig() {
  if (mongoose.connection.readyState !== 1) return;
  const doc = await RocketSettings.findOne({ key: 'rocket' }).lean();
  if (doc) applyRocketConfig(doc);
}

function publicRocketConfig() {
  return {
    // حقول توافق قديمة للواجهة؛ ليست نسبة فوز مضمونة لكل لاعب.
    lossRate: ROCKET_LOSS_RATE,
    winRate: ROCKET_WIN_RATE,
    houseEdge: rocketConfig.houseEdge,
    houseEdgePercent: Math.round(rocketConfig.houseEdge * 10000) / 100,
    maxMultiplier: rocketConfig.maxMultiplier,
    minBet: rocketConfig.minBet,
    maxBet: rocketConfig.maxBet,
    updatedAt: rocketConfig.updatedAt,
    updatedBy: rocketConfig.updatedBy
  };
}

// يتحقق من القيم المرسلة (النسبة المئوية للهامش، المضاعف الأقصى، حدّا الرهان) ويعيد القيم المدمجة مع الحالية.
function parseRocketSettingsInput(body) {
  const next = {
    houseEdge: rocketConfig.houseEdge,
    maxMultiplier: rocketConfig.maxMultiplier,
    minBet: rocketConfig.minBet,
    maxBet: rocketConfig.maxBet
  };
  let changed = false;

  if (body.houseEdgePercent !== undefined) {
    const percent = Number(body.houseEdgePercent);
    const { min, max } = ROCKET_LIMITS.houseEdgePercent;
    if (!Number.isFinite(percent) || percent < min || percent > max) {
      return { error: `هامش المنصة يجب أن يكون بين ${min}% و${max}%.` };
    }
    next.houseEdge = Math.round(percent * 100) / 10000;
    changed = true;
  }
  if (body.maxMultiplier !== undefined) {
    const multiplier = Number(body.maxMultiplier);
    const { min, max } = ROCKET_LIMITS.maxMultiplier;
    if (!Number.isFinite(multiplier) || multiplier < min || multiplier > max) {
      return { error: `المضاعف الأقصى يجب أن يكون بين ${min} و${max}.` };
    }
    next.maxMultiplier = Math.round(multiplier * 100) / 100;
    changed = true;
  }
  if (body.minBet !== undefined) {
    const minBet = Number(body.minBet);
    if (!Number.isSafeInteger(minBet) || minBet < ROCKET_LIMITS.minBet.min || minBet > ROCKET_LIMITS.minBet.max) {
      return { error: 'الحد الأدنى للرهان يجب أن يكون عددًا صحيحًا موجبًا.' };
    }
    next.minBet = minBet;
    changed = true;
  }
  if (body.maxBet !== undefined) {
    const maxBet = Number(body.maxBet);
    if (!Number.isSafeInteger(maxBet) || maxBet < ROCKET_LIMITS.maxBet.min || maxBet > ROCKET_LIMITS.maxBet.max) {
      return { error: 'الحد الأقصى للرهان يجب أن يكون عددًا صحيحًا موجبًا.' };
    }
    next.maxBet = maxBet;
    changed = true;
  }
  if (next.maxBet < next.minBet) {
    return { error: 'الحد الأقصى للرهان يجب ألا يقل عن الحد الأدنى.' };
  }
  return { values: next, changed };
}

// --------------------------------------------------
// أدوات مساعدة
// --------------------------------------------------

function isValidPositiveNumber(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function publicUser(user) {
  if (!user) return null;
  return {
    telegramId: user.telegramId,
    name: user.name,
    gold: user.gold,
    diamonds: user.diamonds,
    trx: user.trx || 0,
    btc: user.btc || 0,
    eth: user.eth || 0,
    sol: user.sol || 0,
    balance: user.balance,
    currency: user.currency,
    referralCount: user.referralCount,
    isBanned: user.isBanned
  };
}

function randomId() {
  return crypto.randomBytes(16).toString('hex');
}

// التحقق من Telegram Mini App initData باستخدام رمز البوت على السيرفر.
function verifyTelegramInitData(initData) {
  if (!TELEGRAM_BOT_TOKEN || !initData || typeof initData !== 'string') {
    return null;
  }

  try {
    const params = new URLSearchParams(initData);
    const receivedHash = params.get('hash');

    if (!receivedHash) return null;

    params.delete('hash');

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(TELEGRAM_BOT_TOKEN)
      .digest();

    const calculatedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest();

    const suppliedHash = Buffer.from(receivedHash, 'hex');

    if (
      suppliedHash.length !== calculatedHash.length ||
      !crypto.timingSafeEqual(suppliedHash, calculatedHash)
    ) {
      return null;
    }

    const authDate = Number(params.get('auth_date'));
    if (!Number.isFinite(authDate)) return null;

    // نرفض بيانات قديمة لتقليل مخاطر إعادة الاستخدام.
    const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
    if (ageSeconds < -60 || ageSeconds > 86400) return null;

    const userString = params.get('user');
    if (!userString) return null;

    const telegramUser = JSON.parse(userString);
    if (!telegramUser || telegramUser.id == null) return null;

    return {
      id: String(telegramUser.id),
      first_name: telegramUser.first_name || '',
      // start_param موقّع ضمن initData، وفيه ref_<referrerId> عند الدخول من رابط إحالة.
      start_param: params.get('start_param') || ''
    };
  } catch {
    return null;
  }
}

function telegramAuth(req, res, next) {
  const telegramUser = verifyTelegramInitData(req.get('x-telegram-init-data'));
  if (!telegramUser) {
    return res.status(401).json({
      success: false,
      message: 'تعذر التحقق من حساب Telegram. افتح التطبيق من داخل Telegram.'
    });
  }
  req.telegramUser = telegramUser;
  next();
}

function rocketAuth(req, res, next) {
  const initData = req.get('x-telegram-init-data');
  const telegramUser = verifyTelegramInitData(initData);

  if (!telegramUser) {
    return res.status(401).json({
      success: false,
      message: 'تعذر التحقق من حساب Telegram. افتح اللعبة من تطبيق Telegram.'
    });
  }

  req.telegramUser = telegramUser;
  next();
}

// يفرض هوية Telegram الموقعة على طلبات المستخدم، ولا يثق في userId المرسل من العميل.
function userRequestAuth(req, res, next) {
  return telegramAuth(req, res, () => {
    const authenticatedId = String(req.telegramUser.id);
    const claimedId = req.body?.userId ?? req.query?.userId;

    if (claimedId != null && String(claimedId) !== authenticatedId) {
      return res.status(403).json({
        success: false,
        message: 'معرّف المستخدم لا يطابق حساب Telegram الموثق.'
      });
    }

    if (req.body && typeof req.body === 'object') {
      req.body.userId = authenticatedId;
    }
    next();
  });
}

// صلاحيات الإدارة لا تعتمد على adminId داخل الطلب؛ يجب أن تكون هوية Telegram الموقعة هي حساب الإدارة.
function adminAuth(req, res, next) {
  return telegramAuth(req, res, () => {
    if (String(req.telegramUser.id) !== String(ADMIN_ID)) {
      return res.status(403).json({ success: false, message: 'غير مصرح لك بالوصول' });
    }
    next();
  });
}

// المضاعف اللحظي؛ يتزايد مع الوقت.
function calculateMultiplier(startedAt, now = Date.now()) {
  const elapsedSeconds = Math.max(0, (now - new Date(startedAt).getTime()) / 1000);
  return Number(Math.exp(ROCKET_GROWTH_RATE * elapsedSeconds).toFixed(2));
}

// يولّد نقطة الانهيار بتوزيع ذي هامش نظري مستهدف 15% عند السحب على مضاعف ثابت.
// توجد احتمالية لانهيار فوري تحت 1.00x؛ وهذا مقصود في نموذج Crash القياسي.
// سقف 20x يعني أن احتمال تجاوز السقف يُجمع عند 20x، ولا يضمن وصول كل جولة إليه.
// النتيجة مستقلة عن هوية اللاعب وحجم رهانه، ولا تُعد نسبة فوز ثابتة لكل لاعب.
function generateCrashMultiplier() {
  // rand في المجال (0, 1] لتجنب القسمة على صفر.
  const rand = (crypto.randomInt(0, 1000000) + 1) / 1000000;
  const rawMultiplier = (1 - rocketConfig.houseEdge) / rand;
  const cappedMultiplier = Math.min(rocketConfig.maxMultiplier, rawMultiplier);
  return Number(Math.max(0.01, cappedMultiplier).toFixed(2));
}

// الوقت الذي يصل فيه المضاعف النظري إلى نقطة الانفجار.
function getCrashAt(startedAt, crashMultiplier) {
  const seconds = Math.log(crashMultiplier) / ROCKET_GROWTH_RATE;
  return new Date(new Date(startedAt).getTime() + seconds * 1000);
}

async function settleCrashIfNeeded(round) {
  if (!round || round.status !== 'running') return round;

  if (Date.now() < new Date(round.crashAt).getTime()) return round;

  const updated = await RocketRound.findOneAndUpdate(
    { _id: round._id, status: 'running' },
    {
      $set: {
        status: 'crashed',
        settledAt: new Date()
      }
    },
    { new: true }
  );

  return updated || RocketRound.findById(round._id);
}

// --------------------------------------------------
// الصفحة الرئيسية
// --------------------------------------------------

app.get('/', (req, res) => {
  res.send('Money Slayer Pro Backend Server is Running! 🚀');
});

// --------------------------------------------------
// 1. ملف المستخدم
// --------------------------------------------------

app.get('/api/user/profile', userRequestAuth, async (req, res) => {
  try {
    const requestedUserId = req.query.userId ? String(req.query.userId) : '';
    const initData = req.get('x-telegram-init-data');
    const verifiedTelegramUser = initData ? verifyTelegramInitData(initData) : null;

    // إذا وصلت بيانات Telegram موقعة، فالمعرّف الموثوق يأتي منها لا من query string.
    // نحافظ على التوافق القديم عند عدم إرسال initData، لكن لا نحدّث الاسم إلا ببيانات موثقة.
    const userId = verifiedTelegramUser ? verifiedTelegramUser.id : requestedUserId;
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'تعذر تحديد المستخدم. افتح التطبيق من Telegram.'
      });
    }

    if (verifiedTelegramUser && requestedUserId && requestedUserId !== verifiedTelegramUser.id) {
      return res.status(403).json({
        success: false,
        message: 'معرّف المستخدم لا يطابق حساب Telegram الموثق.'
      });
    }

    let user = await User.findOne({ telegramId: userId });
    // الإحالة تُحتسب فقط إذا أُنشئ الحساب الآن أثناء الدخول من رابط الإحالة.
    let isNewUser = !user;

    if (!user) {
      user = new User({
        telegramId: userId,
        name: verifiedTelegramUser?.first_name || 'زائر كريم',
        gold: 0,
        diamonds: 0,
        balance: 0
      });
    } else if (verifiedTelegramUser?.first_name) {
      // لا نغيّر الاسم إلا بعد نجاح التحقق من توقيع Telegram.
      user.name = verifiedTelegramUser.first_name;
    }

    if (user.isBanned) {
      return res.status(403).json({
        success: false,
        message: 'حسابك محظور من استخدام المنصة.'
      });
    }

    user.lastActiveAt = new Date();
    try {
      await user.save();
    } catch (saveErr) {
      // قد يفتح المستخدم التطبيق بطلبين متزامنين لأول مرة؛ منع خطأ 500 بسبب unique telegramId.
      if (saveErr?.code === 11000 && isNewUser) {
        user = await User.findOne({ telegramId: userId });
        if (!user) throw saveErr;
        user.lastActiveAt = new Date();
        await user.save();
        isNewUser = false;
      } else {
        throw saveErr;
      }
    }

    // تسجيل الإحالة تلقائيًا عند أول دخول عبر رابط ?startapp=ref_<id>.
    let referrerFromLink = parseReferralParam(verifiedTelegramUser?.start_param);
    if (isNewUser && !referrerFromLink) {
      // الدخول عبر زر البوت لا يحمل start_param؛ نقرأ الإحالة التي سجّلها أمر /start ref_<id>.
      try {
        const pending = await PendingReferral.findOne({
          telegramId: user.telegramId,
          expiresAt: { $gt: new Date() }
        }).lean();
        referrerFromLink = pending ? pending.referrerId : null;
      } catch (pendingErr) {
        console.error('pending referral lookup error:', pendingErr.message);
      }
    }
    if (isNewUser && referrerFromLink) {
      try {
        const referralResult = await registerReferral(user.telegramId, referrerFromLink);
        if (!referralResult?.success) {
          console.warn('auto referral not registered:', referralResult?.status || 'unknown', referralResult?.message || 'unknown reason');
        }
      } catch (refErr) {
        console.error('auto referral error:', refErr.message);
      }
    }
    if (isNewUser) {
      PendingReferral.deleteOne({ telegramId: user.telegramId })
        .catch((delErr) => console.error('pending referral cleanup error:', delErr.message));
    }

    res.json({ success: true, user });
  } catch (err) {
    console.error('profile error:', err);
    res.status(500).json({ success: false, error: 'خطأ في جلب بيانات المستخدم' });
  }
});

app.post('/api/user/update-currency', userRequestAuth, async (req, res) => {
  try {
    const { userId, currency } = req.body;

    if (!userId || !currency) {
      return res.status(400).json({ success: false, message: 'بيانات غير صالحة' });
    }

    const user = await User.findOne({ telegramId: String(userId) });
    if (!user) return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
    if (user.isBanned) return res.status(403).json({ success: false, message: 'حساب محظور' });

    user.currency = String(currency);
    await user.save();

    res.json({ success: true, message: 'تم تحديث العملة بنجاح' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في تحديث العملة' });
  }
});

// --------------------------------------------------
// 2. الإحالات
// --------------------------------------------------

app.get('/api/referrals/stats', userRequestAuth, async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId' });
    }

    const ownerId = String(userId);
    const user = await User.findOne({ telegramId: ownerId }).select('telegramId referralCount gold');
    if (!user) {
      return res.json({ success: true, referralCount: 0, referrals: [], rewardPerReferral: REFERRAL_REWARD_GOLD, totalReferralGold: 0 });
    }

    // نعتمد على سجلات المستخدمين المرتبطين فعليًا بهذا المُحيل، لا على عداد قديم فقط.
    const referrals = await User.find({ referredBy: ownerId })
      .select('telegramId name createdAt referralRewardedAt referralQualified')
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      referralCount: referrals.length,
      referrals: referrals.map((item) => ({
        userId: item.telegramId,
        name: item.name,
        createdAt: item.createdAt,
        rewarded: Boolean(item.referralQualified),
        requiredTasks: REFERRAL_QUALIFY_TASKS
      })),
      rewardPerReferral: REFERRAL_REWARD_GOLD,
      totalReferralGold: referrals.filter((item) => item.referralQualified).length * REFERRAL_REWARD_GOLD,
      gold: user.gold
    });
  } catch (err) {
    console.error('referral stats error:', err);
    res.status(500).json({ success: false, message: 'تعذر جلب إحصائيات الإحالات' });
  }
});

function parseReferralParam(value) {
  const match = /^ref_(\d{1,20})$/.exec(String(value || '').trim());
  return match ? match[1] : null;
}

// يربط المستخدم الجديد بالمُحيل مرة واحدة فقط، ويضيف المكافأة كرصيد معلّق للمُحيل.
async function registerReferral(referredUserId, ownerId) {
  referredUserId = String(referredUserId);
  ownerId = String(ownerId);

  if (!ownerId || referredUserId === ownerId) {
    return { success: false, status: 400, message: 'رابط الإحالة غير صالح' };
  }

  // لا نستخدم withTransaction هنا: كانت تفشل على MongoDB غير المهيأ كـ Replica Set
  // بعد أن يكون حساب الصديق قد حُفظ، فتضيع الإحالة نهائيًا. نستخدم تحديثات ذرية مع تراجع يدوي.
  const [referredUser, referrer] = await Promise.all([
    User.findOne({ telegramId: referredUserId }),
    User.findOne({ telegramId: ownerId })
  ]);

  if (!referredUser) return { success: false, status: 404, message: 'يجب إنشاء حساب المستخدم أولاً' };
  if (!referrer || referrer.isBanned) return { success: false, status: 404, message: 'المُحيل غير موجود أو محظور' };
  if (referredUser.isBanned) return { success: false, status: 403, message: 'المستخدم محظور' };
  if (referredUser.referredBy || referredUser.referralRewardedAt) {
    return { success: false, status: 409, message: 'تم تسجيل إحالة هذا المستخدم مسبقًا' };
  }

  const claimedUser = await User.findOneAndUpdate(
    {
      telegramId: referredUserId,
      isBanned: { $ne: true },
      $and: [
        { $or: [{ referredBy: null }, { referredBy: { $exists: false } }] },
        { $or: [{ referralRewardedAt: null }, { referralRewardedAt: { $exists: false } }] }
      ]
    },
    { $set: { referredBy: ownerId, referralRewardedAt: new Date(), referralQualified: true, referralQualifiedAt: new Date() } },
    { new: true }
  );
  if (!claimedUser) return { success: false, status: 409, message: 'تم تسجيل إحالة هذا المستخدم مسبقًا' };

  try {
    const updatedReferrer = await User.findOneAndUpdate(
      { telegramId: ownerId, isBanned: { $ne: true } },
      { $inc: { referralCount: 1, pendingReferralGold: REFERRAL_REWARD_GOLD } },
      { new: true }
    );
    if (!updatedReferrer) throw new Error('تعذر تحديث حساب المُحيل');

    return {
      success: true,
      status: 200,
      message: 'تم تسجيل الإحالة وإضافة المكافأة إلى رصيدك المعلّق',
      reward: REFERRAL_REWARD_GOLD,
      referralCount: updatedReferrer.referralCount,
      pendingReward: updatedReferrer.pendingReferralGold
    };
  } catch (err) {
    console.error('referral reward failed, rolling back claim:', err.message);
    await User.updateOne(
      { telegramId: referredUserId, referredBy: ownerId },
      { $set: { referredBy: null, referralRewardedAt: null, referralQualified: false }, $unset: { referralQualifiedAt: '' } }
    ).catch((rollbackErr) => console.error('referral rollback failed:', rollbackErr.message));
    return { success: false, status: 500, message: 'تعذر تسجيل الإحالة حاليًا' };
  }
}

// يُستدعى بعد كل مهمة ينجزها المستخدم: إذا بلغ عدد مهامه الحد المطلوب تُضاف مكافأة الإحالة للمُحيل مرة واحدة فقط.
async function qualifyReferralIfEligible(userId) {
  userId = String(userId);
  const friend = await User.findOne({
    telegramId: userId,
    isBanned: { $ne: true },
    referredBy: { $nin: [null, ''] },
    referralQualified: false
  }).select('referredBy').lean();
  if (!friend) return null;

  const completedTasks = await Task.countDocuments({ completedBy: userId });
  if (completedTasks < REFERRAL_QUALIFY_TASKS) return null;

  // علامة ذرية: تمنع دفع المكافأة مرتين عند إكمال مهمتين بالتزامن.
  const claimed = await User.findOneAndUpdate(
    { telegramId: userId, referralQualified: false },
    { $set: { referralQualified: true, referralQualifiedAt: new Date() } },
    { new: true }
  );
  if (!claimed) return null;

  const referrerId = String(friend.referredBy);
  try {
    const referrer = await User.findOneAndUpdate(
      { telegramId: referrerId, isBanned: { $ne: true } },
      { $inc: { pendingReferralGold: REFERRAL_REWARD_GOLD } },
      { new: true }
    );
    if (!referrer) throw new Error('المُحيل غير متاح أو محظور');
    return { referrerId, reward: REFERRAL_REWARD_GOLD };
  } catch (err) {
    console.error('referral qualification failed, rolling back:', err.message);
    await User.updateOne(
      { telegramId: userId, referralQualified: true },
      { $set: { referralQualified: false }, $unset: { referralQualifiedAt: '' } }
    ).catch((rollbackErr) => console.error('referral qualification rollback failed:', rollbackErr.message));
    return null;
  }
}

// التسجيل اليدوي للإحالة معطّل: الإحالة تُسجَّل فقط عند إنشاء الحساب الجديد
// عبر /api/user/profile مع initData موقّع يحتوي start_param=ref_<id>.
// هذا يمنع ربط مستخدمين فتحوا التطبيق سابقًا دون رابط إحالة.
const referralRegistrationDisabled = (req, res) => {
  res.status(410).json({
    success: false,
    message: 'تُحتسب الإحالة تلقائيًا فقط عند أول دخول للحساب الجديد عبر رابط الإحالة.'
  });
};
app.post('/api/user/referral', referralRegistrationDisabled);
app.post('/api/friends/register', referralRegistrationDisabled);

async function friendsStatsFor(ownerId) {
  const [owner, totalInvited] = await Promise.all([
    User.findOne({ telegramId: ownerId }).select('pendingReferralGold totalReferralGold isBanned').lean(),
    User.countDocuments({ referredBy: ownerId })
  ]);
  return {
    owner,
    stats: {
      totalInvited,
      totalEarnedGold: Math.max(0, Number(owner?.totalReferralGold) || 0),
      pendingReward: Math.max(0, Number(owner?.pendingReferralGold) || 0)
    }
  };
}

app.get('/api/friends/list', telegramAuth, async (req, res) => {
  try {
    const ownerId = req.telegramUser.id;
    if (req.query.userId && String(req.query.userId) !== ownerId) {
      return res.status(403).json({ success: false, message: 'معرّف المستخدم لا يطابق حساب Telegram الموثق.' });
    }

    const { owner, stats } = await friendsStatsFor(ownerId);
    if (owner?.isBanned) return res.status(403).json({ success: false, message: 'حساب محظور' });

    const friends = await User.find({ referredBy: ownerId })
      .select('telegramId name createdAt lastActiveAt referralQualified')
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();

    const now = Date.now();
    res.json({
      success: true,
      friends: friends.map((friend) => ({
        telegramId: friend.telegramId,
        name: friend.name,
        earnedGold: friend.referralQualified ? REFERRAL_REWARD_GOLD : 0,
        qualified: Boolean(friend.referralQualified),
        requiredTasks: REFERRAL_QUALIFY_TASKS,
        isActive: now - new Date(friend.lastActiveAt || friend.createdAt).getTime() <= FRIEND_ACTIVE_WINDOW_MS,
        joinedAt: friend.createdAt
      })),
      stats,
      rewardPerReferral: REFERRAL_REWARD_GOLD
    });
  } catch (err) {
    console.error('friends list error:', err);
    res.status(500).json({ success: false, message: 'تعذر جلب قائمة الأصدقاء' });
  }
});

app.post('/api/friends/claim', telegramAuth, async (req, res) => {
  try {
    const ownerId = req.telegramUser.id;
    if (req.body?.userId && String(req.body.userId) !== ownerId) {
      return res.status(403).json({ success: false, message: 'معرّف المستخدم لا يطابق حساب Telegram الموثق.' });
    }

    // تحديث ذري واحد: يصفّر المعلّق ويضيفه للذهب، فلا يمكن استلامه مرتين.
    const before = await User.findOneAndUpdate(
      { telegramId: ownerId, isBanned: { $ne: true }, pendingReferralGold: { $gt: 0 } },
      [{
        $set: {
          gold: { $add: [{ $ifNull: ['$gold', 0] }, '$pendingReferralGold'] },
          totalReferralGold: { $add: [{ $ifNull: ['$totalReferralGold', 0] }, '$pendingReferralGold'] },
          pendingReferralGold: 0
        }
      }],
      { new: false }
    );

    if (!before) {
      return res.status(400).json({ success: false, message: 'لا توجد مكافآت معلّقة للاستلام حاليًا.' });
    }

    const claimedAmount = Number(before.pendingReferralGold) || 0;
    const { stats } = await friendsStatsFor(ownerId);
    const user = await User.findOne({ telegramId: ownerId });
    await recordLedger({
      userId: String(ownerId), type: 'referral_claim', currency: 'gold', amount: claimedAmount, balanceAfter: user?.gold,
      refKey: `referral-claim:${ownerId}:${Date.now()}`, description: 'استلام مكافآت الإحالة'
    });

    res.json({ success: true, claimedAmount, stats, gold: user?.gold, user: publicUser(user) });
  } catch (err) {
    console.error('friends claim error:', err);
    res.status(500).json({ success: false, message: 'تعذر استلام المكافأة' });
  }
});

// --------------------------------------------------
// 3. المحفظة والتحويلات
// --------------------------------------------------

// ---------- أسعار العملات والتحويل بينها ----------

// سعر الذهب ثابت: كل 100,000 ذهب = 5$ (أي 20,000 ذهب = 1$).
const GOLD_PER_USD = 20000;
if (TASK_REWARD_GOLD / GOLD_PER_USD >= 1 / 50) {
  console.error('⚠️ مكافأة المهمة تساوي أو تتجاوز تكلفتها على المنشئ؛ خفّض TASK_REWARD_GOLD لتفادي الخسارة.');
}
// الحد الأدنى لقيمة أي عملية تحويل بالدولار (200 ذهب = 0.01$).
const MIN_CONVERT_USD = 0.01;
// رسوم التحويل بين العملات (0 = بدون رسوم، 0.01 = 1%). يمكن ضبطها من WALLET_CONVERT_FEE_RATE.
// الافتراضي 1% لتغطية تأخر الأسعار (حتى 30 ثانية) ومنع المراجحة بين العملات؛ اضبط المتغير على 0 لإلغائها.
const WALLET_CONVERT_FEE_RATE = Math.min(
  0.5,
  Math.max(
    0,
    process.env.WALLET_CONVERT_FEE_RATE !== undefined && process.env.WALLET_CONVERT_FEE_RATE !== ''
      ? (Number(process.env.WALLET_CONVERT_FEE_RATE) || 0)
      : 0.01
  )
);

const PRICE_CACHE_TTL_MS = 30 * 1000;          // أقصى عمر للسعر قبل تحديثه عند الطلب
const PRICE_REFRESH_INTERVAL_MS = 30 * 1000;   // تحديث دوري في الخلفية
const PRICE_MAX_STALE_MS = 5 * 60 * 1000;      // بعد هذه المدة يُرفض التحويل بدل استخدام سعر قديم
const PRICE_FETCH_TIMEOUT_MS = 6000;
const PRICE_MAX_SOURCE_DIVERGENCE = 0.03;      // أقصى فرق مسموح بين مصدرين (3%)

// العملة -> الحقل الذي يخزن رصيدها في قاعدة البيانات.
// GRAM هو الرصيد المخزن في diamonds، و USDT هو الرصيد المالي balance.
const CONVERTIBLE_ASSETS = {
  GOLD: 'gold',
  USDT: 'balance',
  GRAM: 'diamonds',
  TRX: 'trx',
  BTC: 'btc',
  ETH: 'eth',
  SOL: 'sol'
};

// العملات التي لها سعر سوق حي (GRAM = Toncoin سابقًا).
const MARKET_ASSETS = ['BTC', 'ETH', 'SOL', 'TRX', 'GRAM'];

const COINGECKO_IDS = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  TRX: 'tron',
  GRAM: process.env.GRAM_COINGECKO_ID || 'the-open-network'
};

const BINANCE_SYMBOLS = {
  BTC: ['BTCUSDT'],
  ETH: ['ETHUSDT'],
  SOL: ['SOLUSDT'],
  TRX: ['TRXUSDT'],
  GRAM: ['GRAMUSDT', 'TONUSDT']
};

const ASSET_ALIASES = {
  GOLD: 'GOLD', G: 'GOLD',
  USDT: 'USDT', USD: 'USDT', BALANCE: 'USDT', DOLLAR: 'USDT', '$': 'USDT',
  GRAM: 'GRAM', DIAMOND: 'GRAM', DIAMONDS: 'GRAM', '💎': 'GRAM', TON: 'GRAM', TONCOIN: 'GRAM',
  TRX: 'TRX', TRON: 'TRX',
  BTC: 'BTC', BITCOIN: 'BTC',
  ETH: 'ETH', ETHEREUM: 'ETH',
  SOL: 'SOL', SOLANA: 'SOL'
};

function normalizeAssetSymbol(value) {
  if (value === undefined || value === null) return null;
  const key = String(value).trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(ASSET_ALIASES, key) ? ASSET_ALIASES[key] : null;
}

// تقريب لأقرب 8 خانات عشرية (لمبلغ يخصمه المستخدم).
function roundTo8(value) {
  return Number(Number(value).toFixed(8));
}

// تقريب لأسفل إلى 8 خانات عشرية (لمبلغ يستلمه المستخدم، لصالح المنصة دائمًا).
function floorTo8(value) {
  return Math.floor(Number((Number(value) * 1e8).toFixed(3))) / 1e8;
}

function httpsGetJson(url, { headers = {}, timeoutMs = PRICE_FETCH_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { Accept: 'application/json', 'User-Agent': 'moneyslayer-server/1.0', ...headers } },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
          if (raw.length > 1000000) req.destroy(new Error('response too large'));
        });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            reject(new Error('invalid JSON'));
          }
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function fetchCoinGeckoPrices() {
  const idToSymbol = {};
  Object.entries(COINGECKO_IDS).forEach(([symbol, id]) => {
    idToSymbol[id] = symbol;
  });

  const headers = process.env.COINGECKO_API_KEY
    ? { 'x-cg-demo-api-key': process.env.COINGECKO_API_KEY }
    : {};

  const ids = Object.keys(idToSymbol).join(',');
  const data = await httpsGetJson(
    `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=usd`,
    { headers }
  );

  const out = {};
  for (const [id, symbol] of Object.entries(idToSymbol)) {
    const price = Number(data && data[id] && data[id].usd);
    if (Number.isFinite(price) && price > 0) out[symbol] = price;
  }
  return out;
}

async function fetchBinancePrices() {
  const out = {};

  await Promise.all(
    Object.entries(BINANCE_SYMBOLS).map(async ([symbol, pairs]) => {
      for (const pair of pairs) {
        try {
          const data = await httpsGetJson(
            `https://data-api.binance.vision/api/v3/ticker/price?symbol=${pair}`
          );
          const price = Number(data && data.price);
          if (Number.isFinite(price) && price > 0) {
            out[symbol] = price;
            return;
          }
        } catch (err) {
          // نجرب الرمز التالي.
        }
      }
    })
  );

  return out;
}

const marketPrices = { prices: {}, times: {} };
let priceRefreshPromise = null;

// يجلب الأسعار من CoinGecko و Binance. إذا توفر المصدران ويتقاربان نأخذ متوسطهما،
// وإذا تباعدا أكثر من 3% نتجاهل التحديث لتلك العملة (حماية من سعر خاطئ).
function refreshMarketPrices() {
  if (priceRefreshPromise) return priceRefreshPromise;

  priceRefreshPromise = (async () => {
    const [cg, bn] = await Promise.allSettled([fetchCoinGeckoPrices(), fetchBinancePrices()]);

    if (cg.status === 'rejected') console.warn('CoinGecko price fetch failed:', cg.reason && cg.reason.message);
    if (bn.status === 'rejected') console.warn('Binance price fetch failed:', bn.reason && bn.reason.message);

    const cgPrices = cg.status === 'fulfilled' ? cg.value : {};
    const bnPrices = bn.status === 'fulfilled' ? bn.value : {};

    for (const symbol of MARKET_ASSETS) {
      const a = cgPrices[symbol];
      const b = bnPrices[symbol];
      let price = null;

      if (a && b) {
        const divergence = Math.abs(a - b) / Math.min(a, b);
        if (divergence > PRICE_MAX_SOURCE_DIVERGENCE) {
          console.error(`Price sources diverge for ${symbol}: coingecko=${a} binance=${b}`);
          continue;
        }
        price = (a + b) / 2;
      } else {
        price = a || b || null;
      }

      if (price) {
        marketPrices.prices[symbol] = price;
        marketPrices.times[symbol] = Date.now();
      }
    }
  })()
    .catch((err) => {
      console.error('Price refresh error:', err && err.message);
    })
    .finally(() => {
      priceRefreshPromise = null;
    });

  return priceRefreshPromise;
}

// تسخين الأسعار عند التشغيل وتحديثها دوريًا.
refreshMarketPrices();
setInterval(refreshMarketPrices, PRICE_REFRESH_INTERVAL_MS).unref();

// يعيد سعر العملة بالدولار، أو null إذا لم يتوفر سعر حديث.
async function getAssetUsdPrice(symbol) {
  if (symbol === 'USDT') return 1;
  if (symbol === 'GOLD') return 1 / GOLD_PER_USD;

  const updatedAt = marketPrices.times[symbol] || 0;
  if (Date.now() - updatedAt > PRICE_CACHE_TTL_MS) {
    await refreshMarketPrices();
  }

  const price = marketPrices.prices[symbol];
  const lastUpdate = marketPrices.times[symbol] || 0;
  if (!price || Date.now() - lastUpdate > PRICE_MAX_STALE_MS) return null;
  return price;
}

async function getWalletPriceSnapshot() {
  const entries = await Promise.all(
    MARKET_ASSETS.map(async (symbol) => [symbol, await getAssetUsdPrice(symbol)])
  );

  const prices = { USDT: 1 };
  entries.forEach(([symbol, price]) => {
    prices[symbol] = price;
  });

  const times = MARKET_ASSETS.map((symbol) => marketPrices.times[symbol] || 0).filter(Boolean);

  return {
    prices,
    updatedAt: times.length ? new Date(Math.min(...times)).toISOString() : null,
    complete: MARKET_ASSETS.every((symbol) => prices[symbol] !== null)
  };
}

// القيمة بالدولار: الذهب بالقسمة على 20,000 (دقيقة)، و USDT كما هي، والباقي بالسعر الحي.
function usdValueOf(symbol, amount, price) {
  if (symbol === 'GOLD') return amount / GOLD_PER_USD;
  if (symbol === 'USDT') return amount;
  return amount * price;
}

async function performWalletConversion(userId, fromRaw, toRaw, amountRaw) {
  const from = normalizeAssetSymbol(fromRaw);
  const to = normalizeAssetSymbol(toRaw);

  if (!from || !to) {
    return { status: 400, body: { success: false, message: 'العملة غير مدعومة.' } };
  }

  if (from === to) {
    return { status: 400, body: { success: false, message: 'اختر عملتين مختلفتين.' } };
  }

  if (to === 'GOLD') {
    return { status: 400, body: { success: false, message: 'لا يمكن التحويل إلى الذهب.' } };
  }

  if (!isValidPositiveNumber(amountRaw)) {
    return { status: 400, body: { success: false, message: 'المبلغ غير صالح.' } };
  }

  let amount = Number(amountRaw);

  if (from === 'GOLD') {
    if (!Number.isSafeInteger(amount)) {
      return { status: 400, body: { success: false, message: 'كمية الذهب يجب أن تكون عددًا صحيحًا.' } };
    }
  } else {
    amount = roundTo8(amount);
    if (!(amount > 0)) {
      return { status: 400, body: { success: false, message: 'المبلغ صغير جدًا.' } };
    }
  }

  const [fromPrice, toPrice] = await Promise.all([getAssetUsdPrice(from), getAssetUsdPrice(to)]);

  if (!fromPrice || !toPrice) {
    return {
      status: 503,
      body: { success: false, message: 'أسعار السوق غير متاحة حاليًا. حاول بعد لحظات.' }
    };
  }

  const usdValue = usdValueOf(from, amount, fromPrice);

  if (!Number.isFinite(usdValue) || usdValue < MIN_CONVERT_USD) {
    return {
      status: 400,
      body: {
        success: false,
        message: `الحد الأدنى للتحويل ما يعادل ${MIN_CONVERT_USD}$ (${GOLD_PER_USD * MIN_CONVERT_USD} ذهب).`
      }
    };
  }

  const netUsd = usdValue * (1 - WALLET_CONVERT_FEE_RATE);
  const received = to === 'USDT' ? floorTo8(netUsd) : floorTo8(netUsd / toPrice);

  if (!Number.isFinite(received) || !(received > 0)) {
    return { status: 400, body: { success: false, message: 'المبلغ صغير جدًا للتحويل.' } };
  }

  const fromField = CONVERTIBLE_ASSETS[from];
  const toField = CONVERTIBLE_ASSETS[to];
  const telegramId = String(userId);

  // خصم وإضافة في عملية واحدة ذرية؛ تفشل إذا الرصيد غير كافٍ.
  const updatedUser = await User.findOneAndUpdate(
    { telegramId, isBanned: { $ne: true }, [fromField]: { $gte: amount } },
    { $inc: { [fromField]: -amount, [toField]: received } },
    { new: true }
  );

  if (!updatedUser) {
    const existing = await User.findOne({ telegramId });
    if (!existing) {
      return { status: 404, body: { success: false, message: 'المستخدم غير موجود.' } };
    }
    if (existing.isBanned) {
      return { status: 403, body: { success: false, message: 'هذا الحساب محظور.' } };
    }
    return { status: 400, body: { success: false, message: `رصيد ${from} غير كافٍ.` } };
  }

  // تسجيل رسوم التحويل كإيراد للمنصة (الذهب بالذهب، وغيره بالدولار)، وتسجيل قيدي التحويل في السجل المالي.
  // فشل التسجيل لا يوقف التحويل.
  let conversionRef = `convert:${telegramId}:${Date.now()}`;
  try {
    const feeInGold = from === 'GOLD';
    const revenueDoc = await PlatformRevenue.create({
      userId: telegramId,
      source: 'convert_fee',
      currency: feeInGold ? 'gold' : 'usd',
      amount: feeInGold ? amount * WALLET_CONVERT_FEE_RATE : usdValue * WALLET_CONVERT_FEE_RATE,
      from,
      to,
      sourceAmount: amount,
      receivedAmount: received,
      usdValue
    });
    conversionRef = `convert:${revenueDoc._id}`;
  } catch (revenueErr) {
    console.error('platform revenue log error:', revenueErr.message);
  }
  await recordLedger([
    { userId: telegramId, type: 'convert_out', currency: fromField, amount: -amount, balanceAfter: updatedUser[fromField], refKey: conversionRef, description: `تحويل ${amount} ${from} إلى ${received} ${to}`, meta: { from, to, usdValue } },
    { userId: telegramId, type: 'convert_in', currency: toField, amount: received, balanceAfter: updatedUser[toField], refKey: conversionRef, description: `تحويل ${amount} ${from} إلى ${received} ${to}`, meta: { from, to, usdValue } }
  ]);

  return {
    status: 200,
    body: {
      success: true,
      message: `تم تحويل ${amount} ${from} إلى ${received} ${to}.`,
      from,
      to,
      amount,
      received,
      usdValue,
      feeRate: WALLET_CONVERT_FEE_RATE,
      rates: {
        goldPerUsd: GOLD_PER_USD,
        fromUsd: usdValue / amount,
        toUsd: toPrice
      },
      user: publicUser(updatedUser)
    }
  };
}

// أنواع التحويل القديمة التي قد ترسلها الواجهة (تبقى مدعومة).
// ملاحظة: diamonds_to_gram يحوّل رصيد GRAM (diamonds) إلى الرصيد المالي USDT.
const LEGACY_EXCHANGE_TYPES = {
  gold_to_diamonds: ['GOLD', 'GRAM'],
  diamonds_to_gram: ['GRAM', 'USDT']
};

async function walletConversionHandler(req, res) {
  try {
    const body = req.body || {};
    const userId = String(body.userId);

    let from = body.from ?? body.fromSymbol ?? body.fromCurrency ?? body.fromAsset;
    let to = body.to ?? body.toSymbol ?? body.toCurrency ?? body.toAsset;
    const type = typeof body.type === 'string' ? body.type.trim().toLowerCase() : '';

    if ((from === undefined || to === undefined) && type) {
      if (LEGACY_EXCHANGE_TYPES[type]) {
        [from, to] = LEGACY_EXCHANGE_TYPES[type];
      } else if (type.includes('_to_')) {
        const [typeFrom, typeTo] = type.split('_to_');
        from = typeFrom;
        to = typeTo;
      }
    }

    if (from === undefined || to === undefined) {
      return res.status(400).json({ success: false, message: 'نوع التحويل غير صالح.' });
    }

    const result = await performWalletConversion(userId, from, to, body.amount);
    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('Wallet conversion error:', err);
    return res.status(500).json({ success: false, message: 'حدث خطأ أثناء التحويل.' });
  }
}

app.get('/api/wallet/prices', telegramAuth, async (req, res) => {
  try {
    const snapshot = await getWalletPriceSnapshot();
    res.json({
      success: true,
      goldPerUsd: GOLD_PER_USD,
      usdPer100kGold: (100000 / GOLD_PER_USD),
      prices: snapshot.prices,
      updatedAt: snapshot.updatedAt,
      complete: snapshot.complete
    });
  } catch (err) {
    console.error('Wallet prices error:', err);
    res.status(500).json({ success: false, message: 'تعذر جلب الأسعار.' });
  }
});

app.get('/api/wallet/details', userRequestAuth, async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ success: false, message: 'Missing userId' });

    const user = await User.findOne({ telegramId: String(userId) });

    if (user && user.isBanned) {
      return res.status(403).json({ success: false, message: 'حساب محظور' });
    }

    const transactions = await Transaction.find({ userId: String(userId) }).sort({ createdAt: -1 });
    const snapshot = await getWalletPriceSnapshot();

    // السعر الحي بالدولار؛ 0 مع priceAvailable=false إذا لم يتوفر سعر حديث.
    const priceOf = (symbol) => snapshot.prices[symbol] ?? 0;
    const hasPrice = (symbol) => snapshot.prices[symbol] !== null && snapshot.prices[symbol] !== undefined;

    res.json({
      success: true,
      balance: user ? user.balance : 0,
      gold: user ? user.gold : 0,
      diamonds: user ? user.diamonds : 0,
      goldPerUsd: GOLD_PER_USD,
      usdPer100kGold: 100000 / GOLD_PER_USD,
      pricesUpdatedAt: snapshot.updatedAt,
      assets: [
        { symbol: 'USDT', name: 'TetherUS', logo: '₮', color: '#26a69a', amount: user ? user.balance : 0, rate: 1, priceAvailable: true },
        { symbol: 'GRAM', name: 'Gram Token', logo: '💎', color: '#00d2ff', amount: user ? user.diamonds : 0, rate: priceOf('GRAM'), priceAvailable: hasPrice('GRAM') },
        { symbol: 'TRX', name: 'Tron', logo: 'TRX', color: '#ff0000', amount: user ? user.trx || 0 : 0, rate: priceOf('TRX'), priceAvailable: hasPrice('TRX') },
        { symbol: 'BTC', name: 'Bitcoin', logo: '₿', color: '#f7931a', amount: user ? user.btc || 0 : 0, rate: priceOf('BTC'), priceAvailable: hasPrice('BTC') },
        { symbol: 'ETH', name: 'Ethereum', logo: 'Ξ', color: '#627eea', amount: user ? user.eth || 0 : 0, rate: priceOf('ETH'), priceAvailable: hasPrice('ETH') },
        { symbol: 'SOL', name: 'Solana', logo: '◎', color: '#14f195', amount: user ? user.sol || 0 : 0, rate: priceOf('SOL'), priceAvailable: hasPrice('SOL') }
      ],
      transactions: transactions.map((t) => ({
        id: t.txId,
        userId: t.userId,
        type: t.type,
        amount: t.amount,
        method: t.method,
        details: t.details,
        status: t.status,
        date: t.date
      }))
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في جلب بيانات المحفظة' });
  }
});

// التحويل بين العملات (المسار القديم والجديد يستخدمان نفس المنطق).
app.post('/api/wallet/exchange', userRequestAuth, walletConversionHandler);
app.post('/api/wallet/convert', userRequestAuth, walletConversionHandler);

const handleTransfer = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { userId, recipientId, amount, type } = req.body;
    if (!userId || !isValidPositiveNumber(amount)) {
      return res.status(400).json({ success: false, message: 'بيانات غير صالحة' });
    }

    const transferAmount = Number(amount);
    const transferType = type || 'gold';
    if (!Number.isFinite(transferAmount) || transferAmount <= 0 || !['gold', 'diamonds', 'balance'].includes(transferType)) {
      return res.status(400).json({ success: false, message: 'نوع الرصيد أو المبلغ غير صالح' });
    }

    const targetId = String(recipientId || req.body.toUserId || '');
    if (!targetId || targetId === String(userId)) {
      return res.status(400).json({ success: false, message: 'معرف المستلم غير صالح' });
    }

    let updatedSender;
    await session.withTransaction(async () => {
      updatedSender = await User.findOneAndUpdate(
        { telegramId: String(userId), isBanned: { $ne: true }, [transferType]: { $gte: transferAmount } },
        { $inc: { [transferType]: -transferAmount } },
        { new: true, session }
      );
      if (!updatedSender) {
        const existingSender = await User.findOne({ telegramId: String(userId) }).select('isBanned').session(session);
        const e = new Error(!existingSender ? 'المستخدم غير موجود' : existingSender.isBanned ? 'حساب محظور' : 'رصيدك غير كافٍ');
        e.statusCode = !existingSender ? 404 : existingSender.isBanned ? 403 : 400;
        throw e;
      }

      const recipient = await User.findOneAndUpdate(
        { telegramId: targetId, isBanned: { $ne: true } },
        { $inc: { [transferType]: transferAmount } },
        { new: true, session }
      );
      if (!recipient) {
        const e = new Error('المستلم محظور أو غير موجود');
        e.statusCode = 400;
        throw e;
      }
      const transferRef = `transfer:${crypto.randomBytes(8).toString('hex')}`;
      await recordLedger([
        { userId: String(userId), type: 'transfer_out', currency: transferType, amount: -transferAmount, balanceAfter: updatedSender[transferType], refKey: transferRef, description: `تحويل إلى ${targetId}`, meta: { counterparty: targetId } },
        { userId: targetId, type: 'transfer_in', currency: transferType, amount: transferAmount, balanceAfter: recipient[transferType], refKey: transferRef, description: `تحويل من ${userId}`, meta: { counterparty: String(userId) } }
      ], { session });
    });

    return res.json({ success: true, message: 'تم التحويل بنجاح', sender: publicUser(updatedSender) });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
    console.error('transfer transaction failed:', err);
    return res.status(500).json({ success: false, message: 'تعذر إتمام التحويل بأمان. تأكد أن MongoDB يدعم المعاملات (Replica Set).' });
  } finally {
    await session.endSession();
  }
};

app.post('/api/user/transfer', userRequestAuth, handleTransfer);
app.post('/api/transfer', userRequestAuth, handleTransfer);
app.post('/api/wallet/transfer', userRequestAuth, handleTransfer);

app.post('/api/wallet/deposit', userRequestAuth, async (req, res) => {
  try {
    const { userId, amount, method, txId } = req.body;

    if (!userId || !isValidPositiveNumber(amount)) {
      return res.status(400).json({ success: false, message: 'بيانات غير صالحة' });
    }

    const user = await User.findOne({ telegramId: String(userId) });
    if (!user || user.isBanned) {
      return res.status(403).json({ success: false, message: 'حساب محظور أو غير موجود' });
    }

    const newTx = new Transaction({
      txId: `DEP-${crypto.randomBytes(12).toString('hex')}`,
      userId: String(userId),
      type: 'إيداع',
      amount: Number(amount),
      method: (method || 'BINANCE').toUpperCase(),
      details: `TxID: ${String(txId || 'N/A').slice(0, 300)}`,
      status: 'pending'
    });

    await newTx.save();
    res.json({ success: true, message: 'تم استلام طلب الإيداع وهو قيد المراجعة' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في إرسال طلب الإيداع' });
  }
});

app.post('/api/admin/deposit-notify', adminAuth, async (req, res) => {
  try {
    const { userId, amount, method, details } = req.body;
    if (!userId || !isValidPositiveNumber(amount)) {
      return res.status(400).json({ success: false, message: 'بيانات غير صالحة' });
    }

    await new Transaction({
      txId: `DEP-${crypto.randomInt(100000, 1000000)}`,
      userId: String(userId),
      type: 'إيداع',
      amount: Number(amount),
      method: method || 'BINANCE',
      details: details || '',
      status: 'pending'
    }).save();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

app.post('/api/admin/withdraw-notify', adminAuth, async (req, res) => {
  try {
    const { userId, amount, method, details } = req.body;
    if (!userId || !isValidPositiveNumber(amount)) {
      return res.status(400).json({ success: false, message: 'بيانات غير صالحة' });
    }

    await new Transaction({
      txId: `WIT-${crypto.randomInt(100000, 1000000)}`,
      userId: String(userId),
      type: 'سحب',
      amount: Number(amount),
      method: method || 'BANK',
      details: details || '',
      status: 'pending'
    }).save();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

app.post('/api/wallet/withdraw', userRequestAuth, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { userId, amount, method, details } = req.body;
    if (!userId || !isValidPositiveNumber(amount) || Number(amount) < 10) {
      return res.status(400).json({ success: false, message: 'الحد الأدنى للسحب هو 10$' });
    }

    const withdrawalAmount = Number(amount);
    if (!Number.isFinite(withdrawalAmount) || withdrawalAmount <= 0) {
      return res.status(400).json({ success: false, message: 'مبلغ السحب غير صالح' });
    }

    let txId;
    await session.withTransaction(async () => {
      const reservedUser = await User.findOneAndUpdate(
        { telegramId: String(userId), isBanned: { $ne: true }, balance: { $gte: withdrawalAmount } },
        { $inc: { balance: -withdrawalAmount } },
        { new: true, session }
      );
      if (!reservedUser) {
        const existing = await User.findOne({ telegramId: String(userId) }).select('isBanned').session(session);
        const e = new Error(!existing ? 'حساب غير موجود' : existing.isBanned ? 'حساب محظور' : 'الرصيد غير كافٍ');
        e.statusCode = !existing || existing.isBanned ? 403 : 400;
        throw e;
      }

      txId = `WIT-${crypto.randomBytes(12).toString('hex')}`;
      await new Transaction({
        txId,
        userId: String(userId),
        type: 'سحب',
        amount: withdrawalAmount,
        method: String(method || 'BANK').toUpperCase().slice(0, 40),
        details: String(details || 'طلب سحب').slice(0, 1000),
        status: 'pending'
      }).save({ session });
      await recordLedger({
        userId: String(userId), type: 'withdraw_hold', currency: 'balance', amount: -withdrawalAmount, balanceAfter: reservedUser.balance,
        refKey: `tx:${txId}`, description: 'حجز مبلغ طلب سحب'
      }, { session });
    });

    return res.json({ success: true, txId, message: 'تم إرسال طلب السحب للمراجعة، وحُجز المبلغ حتى تتم المراجعة.' });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
    console.error('withdraw transaction failed:', err);
    return res.status(500).json({ success: false, message: 'تعذر إنشاء طلب السحب بأمان. تأكد أن MongoDB يدعم المعاملات (Replica Set).' });
  } finally {
    await session.endSession();
  }
});

// --------------------------------------------------
// 4. الرموز الترويجية
// --------------------------------------------------

async function redeemPromo(req, res, responseKey = 'reward') {
  try {
    const { userId, code } = req.body;

    if (!userId || !code) {
      return res.status(400).json({ success: false, message: 'الرجاء إدخال الرمز' });
    }

    const cleanCode = String(code).trim().toUpperCase();
    const promo = await Promo.findOne({ code: cleanCode });

    if (!promo) return res.status(400).json({ success: false, message: 'الرمز غير صحيح' });
    if (promo.usedBy.includes(String(userId))) {
      return res.status(400).json({ success: false, message: 'استخدمت هذا الرمز مسبقاً' });
    }
    if (promo.usedCount >= promo.maxUses) {
      return res.status(400).json({ success: false, message: 'انتهت صلاحية الرمز' });
    }

    const user = await User.findOne({ telegramId: String(userId) });
    if (!user || user.isBanned) {
      return res.status(403).json({ success: false, message: 'حساب محظور أو غير موجود' });
    }

    const rewardType = promo.type || 'gold';
    if (!['gold', 'diamonds', 'balance'].includes(rewardType)) {
      return res.status(400).json({ success: false, message: 'نوع مكافأة الرمز غير صالح' });
    }

    const reward = Number(promo.amount);
    if (!Number.isFinite(reward) || reward <= 0) {
      return res.status(400).json({ success: false, message: 'قيمة المكافأة غير صالحة' });
    }

    // تحديث شرطي للرمز لتقليل فرص استخدامه أكثر من الحد المسموح.
    const claimedPromo = await Promo.findOneAndUpdate(
      {
        _id: promo._id,
        usedCount: { $lt: promo.maxUses },
        usedBy: { $ne: String(userId) }
      },
      { $inc: { usedCount: 1 }, $addToSet: { usedBy: String(userId) } },
      { new: true }
    );

    if (!claimedPromo) {
      return res.status(400).json({ success: false, message: 'تم استخدام الرمز أو انتهت صلاحيته' });
    }

    // زيادة رصيد المستفيد ذريًا بدل حفظ مستند قديم يمكنه الكتابة فوق تحديثات متزامنة.
    let creditedUser;
    try {
      creditedUser = await User.findOneAndUpdate(
        { telegramId: String(userId), isBanned: { $ne: true } },
        { $inc: { [rewardType]: reward } },
        { new: true }
      );
    } catch (creditError) {
      // إذا تعذر إيداع المكافأة، نعيد حجز الرمز قدر الإمكان كي لا يُستهلك بلا مقابل.
      await Promo.updateOne(
        { _id: promo._id, usedBy: String(userId) },
        { $inc: { usedCount: -1 }, $pull: { usedBy: String(userId) } }
      ).catch((rollbackError) => console.error('promo claim rollback failed:', rollbackError));
      throw creditError;
    }

    if (!creditedUser) {
      await Promo.updateOne(
        { _id: promo._id, usedBy: String(userId) },
        { $inc: { usedCount: -1 }, $pull: { usedBy: String(userId) } }
      );
      return res.status(403).json({ success: false, message: 'الحساب محظور أو غير موجود' });
    }

    await recordLedger({
      userId: String(userId), type: 'promo_redeem', currency: rewardType, amount: reward, balanceAfter: creditedUser[rewardType],
      refKey: `promo-use:${promo._id}`, description: `تفعيل الرمز ${cleanCode}`
    });

    res.json({
      success: true,
      [responseKey]: reward,
      reward,
      user: publicUser(creditedUser),
      message: `تم تفعيل الكود بنجاح! حصلت على ${reward}`
    });
  } catch (err) {
    console.error('redeem promo error:', err);
    res.status(500).json({ success: false, message: 'خطأ في تفعيل الرمز' });
  }
}

app.post('/api/promo/redeem', userRequestAuth, (req, res) => redeemPromo(req, res, 'reward'));
app.post('/api/promo/apply', userRequestAuth, (req, res) => redeemPromo(req, res, 'goldReward'));

app.post('/api/promo/create', userRequestAuth, async (req, res) => {
  let authenticatedUserId = String(req.telegramUser.id);
  let reservedTotal = 0;
  let createdPromoId = null;
  let createdFeeId = null;

  try {
    const { code, maxUses, goldRewardPerPerson } = req.body || {};

    // لا نقبل القيم الافتراضية الضمنية؛ يجب تحديد عدد المستفيدين ومكافأة كل شخص.
    const cleanCode = typeof code === 'string' ? code.trim().toUpperCase() : '';
    const reward = Number(goldRewardPerPerson);
    const uses = Number(maxUses);

    if (!/^[A-Z0-9_-]{3,32}$/.test(cleanCode)) {
      return res.status(400).json({ success: false, message: 'الرمز يجب أن يتكون من 3 إلى 32 حرفًا أو رقمًا أو _ أو -' });
    }
    if (!Number.isSafeInteger(reward) || reward <= 0 || reward > 1000000000 ||
        !Number.isSafeInteger(uses) || uses <= 0 || uses > 100000) {
      return res.status(400).json({ success: false, message: 'قيمة المكافأة أو عدد المستفيدين غير صالح' });
    }

    const existing = await Promo.findOne({ code: cleanCode }).select('_id').lean();
    if (existing) {
      return res.status(409).json({ success: false, message: 'هذا الرمز موجود مسبقًا' });
    }

    const distributionTotal = reward * uses;
    const fee = Math.ceil(distributionTotal * 0.05);
    reservedTotal = distributionTotal + fee;
    if (!Number.isSafeInteger(distributionTotal) || !Number.isSafeInteger(fee) ||
        !Number.isSafeInteger(reservedTotal) || reservedTotal <= 0) {
      return res.status(400).json({ success: false, message: 'المبلغ الإجمالي أكبر من الحد المسموح' });
    }

    // خصم ذري مشروط يمنع الرصيد السالب أو إنفاق الرصيد نفسه بطلبات متزامنة.
    const chargedUser = await User.findOneAndUpdate(
      { telegramId: authenticatedUserId, isBanned: { $ne: true }, gold: { $gte: reservedTotal } },
      { $inc: { gold: -reservedTotal } },
      { new: true }
    );
    if (!chargedUser) {
      const userExists = await User.exists({ telegramId: authenticatedUserId, isBanned: { $ne: true } });
      return res.status(userExists ? 400 : 403).json({
        success: false,
        message: userExists ? `رصيدك غير كافٍ. تحتاج إلى ${reservedTotal} ذهب (يشمل رسوم 5%)` : 'الحساب محظور أو غير موجود'
      });
    }

    try {
      const promo = await new Promo({
        code: cleanCode,
        amount: reward,
        type: 'gold',
        maxUses: uses,
        usedCount: 0,
        usedBy: [],
        creatorId: authenticatedUserId,
        fundedAmount: distributionTotal,
        feeAmount: fee,
        feeRate: 5,
        fundingStatus: 'funded'
      }).save();
      createdPromoId = promo._id;

      const feeRecord = await new PlatformFee({
        userId: authenticatedUserId,
        promoCode: cleanCode,
        amount: fee,
        rate: 5
      }).save();
      createdFeeId = feeRecord._id;
      await recordLedger([
        { userId: authenticatedUserId, type: 'promo_create', currency: 'gold', amount: -distributionTotal, balanceAfter: chargedUser.gold, refKey: `promo-create:${createdPromoId}`, description: `تمويل الرمز ${cleanCode}` },
        { userId: authenticatedUserId, type: 'promo_fee', currency: 'gold', amount: -fee, balanceAfter: chargedUser.gold, refKey: `promo-create:${createdPromoId}`, description: `رسوم المنصة 5% للرمز ${cleanCode}` }
      ]);

      return res.json({
        success: true,
        message: 'تم إنشاء الرمز وخصم قيمة المكافآت ورسوم المنصة بنجاح',
        promo: {
          code: cleanCode,
          rewardPerPerson: reward,
          maxUses: uses,
          distributionTotal,
          platformFee: fee,
          feeRate: 5,
          totalDeducted: reservedTotal
        },
        user: publicUser(chargedUser)
      });
    } catch (creationError) {
      // تعويض أي خطوة مكتملة إذا فشلت خطوة لاحقة؛ لا نترك خصمًا بلا رمز.
      if (createdFeeId) await PlatformFee.deleteOne({ _id: createdFeeId });
      if (createdPromoId) await Promo.deleteOne({ _id: createdPromoId });
      await User.updateOne({ telegramId: authenticatedUserId }, { $inc: { gold: reservedTotal } });
      reservedTotal = 0;
      if (creationError && creationError.code === 11000) {
        return res.status(409).json({ success: false, message: 'هذا الرمز موجود مسبقًا' });
      }
      throw creationError;
    }
  } catch (err) {
    console.error('promo creation error:', err);
    return res.status(500).json({ success: false, message: 'فشل إنشاء الرمز؛ إذا خُصم الرصيد فتحقق من سجل الرصيد قبل إعادة المحاولة' });
  }
});


// --------------------------------------------------
// Monetag rewarded ads: 500 Gold, max 50/day, 60-second cooldown.
// Real rewards are granted only from a validated Monetag postback.
// Configure MONETAG_POSTBACK_SECRET in the server environment.
app.get('/api/monetag/status', userRequestAuth, async (req, res) => {
  try {
    const userId = String(req.telegramUser.id);
    const day = new Date().toISOString().slice(0, 10);
    const doc = await MonetagDaily.findOne({ userId, day }).lean();
    const now = Date.now();
    const last = doc?.lastStartedAt ? new Date(doc.lastStartedAt).getTime() : 0;
    const waitSeconds = Math.max(0, Math.ceil((last + MONETAG_COOLDOWN_MS - now) / 1000));
    res.json({ success: true, rewardGold: MONETAG_REWARD_GOLD, dailyLimit: MONETAG_DAILY_LIMIT,
      adsToday: Number(doc?.count || 0), waitSeconds, remaining: Math.max(0, MONETAG_DAILY_LIMIT - Number(doc?.count || 0)) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر جلب حالة إعلانات المكافآت.' });
  }
});

app.post('/api/monetag/start', userRequestAuth, async (req, res) => {
  try {
    const userId = String(req.telegramUser.id);
    const day = new Date().toISOString().slice(0, 10);
    const now = new Date();

    // إنشاء سجل اليوم إن لم يوجد (آمن مع الطلبات المتزامنة بفضل الفهرس الفريد).
    try {
      await MonetagDaily.updateOne(
        { userId, day },
        { $setOnInsert: { count: 0, lastStartedAt: null } },
        { upsert: true }
      );
    } catch (upsertErr) {
      if (!(upsertErr && upsertErr.code === 11000)) throw upsertErr;
    }

    // حجز ذري: يفشل إذا بلغ الحد اليومي أو لم ينتهِ المؤقت، فلا يمكن تجاوزهما بطلبات متزامنة.
    const cooldownEdge = new Date(now.getTime() - MONETAG_COOLDOWN_MS);
    const daily = await MonetagDaily.findOneAndUpdate(
      {
        userId,
        day,
        count: { $lt: MONETAG_DAILY_LIMIT },
        $or: [{ lastStartedAt: null }, { lastStartedAt: { $lte: cooldownEdge } }]
      },
      { $inc: { count: 1 }, $set: { lastStartedAt: now } },
      { new: true }
    );

    if (!daily) {
      const current = await MonetagDaily.findOne({ userId, day }).lean();
      if (current && Number(current.count) >= MONETAG_DAILY_LIMIT) {
        return res.status(429).json({ success: false, message: 'وصلت إلى الحد اليومي: 50 إعلانًا.', adsToday: current.count, remaining: 0 });
      }
      const last = current && current.lastStartedAt ? new Date(current.lastStartedAt).getTime() : 0;
      const waitSeconds = Math.max(1, Math.ceil((last + MONETAG_COOLDOWN_MS - now.getTime()) / 1000));
      return res.status(429).json({ success: false, message: 'انتظر انتهاء المؤقت قبل مشاهدة الإعلان التالي.', waitSeconds });
    }

    const ymid = crypto.randomUUID();
    try {
      await MonetagAttempt.create({ ymid, userId, day, status: 'pending' });
    } catch (attemptErr) {
      // لا نستهلك حصة المستخدم إذا تعذر تسجيل المحاولة.
      await MonetagDaily.updateOne({ userId, day, count: { $gt: 0 } }, { $inc: { count: -1 } })
        .catch((rollbackErr) => console.error('Monetag counter rollback failed:', rollbackErr.message));
      throw attemptErr;
    }
    res.json({ success: true, ymid, zoneId: MONETAG_ZONE_ID, rewardGold: MONETAG_REWARD_GOLD, adsToday: daily.count, remaining: Math.max(0, MONETAG_DAILY_LIMIT - daily.count) });
  } catch (err) {
    console.error('Monetag start error:', err.message);
    res.status(500).json({ success: false, message: 'تعذر بدء الإعلان حاليًا.' });
  }
});

// Monetag Postback endpoint. In Monetag, configure macros in the URL:
// ?key=YOUR_SECRET&telegram_id={telegram_id}&zone_id={zone_id}&event_type={event_type}&reward_event_type={reward_event_type}&ymid={ymid}
app.get('/api/monetag/postback', async (req, res) => {
  try {
    const secret = String(process.env.MONETAG_POSTBACK_SECRET || '');
    const suppliedKey = Buffer.from(String(req.query.key || ''));
    const expectedKey = Buffer.from(secret);
    if (!secret || suppliedKey.length !== expectedKey.length ||
        !crypto.timingSafeEqual(suppliedKey, expectedKey)) {
      return res.status(403).send('forbidden');
    }
    if (String(req.query.zone_id || '') !== MONETAG_ZONE_ID ||
        String(req.query.event_type || '') !== 'impression' ||
        String(req.query.reward_event_type || '') !== 'valued') {
      return res.status(200).send('ignored');
    }
    const ymid = String(req.query.ymid || '');
    if (!ymid || ymid.length > 128) return res.status(400).send('invalid ymid');
    const attempt = await MonetagAttempt.findOne({ ymid });
    if (!attempt) return res.status(404).send('unknown ymid');
    if (String(req.query.telegram_id || '') !== attempt.userId) return res.status(403).send('user mismatch');
    if (attempt.status === 'rewarded') return res.status(200).send('duplicate');
    if (attempt.status !== 'pending') return res.status(200).send('ignored');
    const userExists = await User.exists({ telegramId: attempt.userId });
    if (!userExists) return res.status(404).send('user not found');

    // تحديث شرطي للحالة يمنع دفع المكافأة مرتين لنفس الـ postback.
    const claimed = await MonetagAttempt.findOneAndUpdate(
      { _id: attempt._id, status: 'pending' },
      { $set: { status: 'rewarded', rewardedAt: new Date() } },
      { new: true }
    );
    if (!claimed) return res.status(200).send('duplicate');

    // إضافة الذهب بعملية $inc ذرية بدل قراءة المستند ثم حفظه (كان يسبب ضياع تحديثات متزامنة).
    let credited;
    try {
      credited = await User.findOneAndUpdate(
        { telegramId: attempt.userId, isBanned: { $ne: true } },
        { $inc: { gold: MONETAG_REWARD_GOLD } },
        { new: true }
      );
    } catch (creditErr) {
      // نعيد المحاولة إلى pending كي يستطيع Monetag إعادة إرسال الـ postback دون ضياع المكافأة.
      await MonetagAttempt.updateOne(
        { _id: claimed._id, status: 'rewarded' },
        { $set: { status: 'pending', rewardedAt: null } }
      ).catch((revertErr) => console.error('Monetag revert failed:', revertErr.message));
      throw creditErr;
    }
    if (credited) {
      await recordLedger({
        userId: String(attempt.userId), type: 'monetag_reward', currency: 'gold', amount: MONETAG_REWARD_GOLD, balanceAfter: credited.gold,
        refKey: `monetag:${claimed._id}`, description: 'مكافأة مشاهدة إعلان'
      });
    }
    if (!credited) {
      // الحساب محظور: لا مكافأة.
      await MonetagAttempt.updateOne(
        { _id: claimed._id, status: 'rewarded' },
        { $set: { status: 'rejected', rewardedAt: null } }
      );
      return res.status(200).send('ignored');
    }
    return res.status(200).send('ok');
  } catch (err) {
    console.error('Monetag postback error:', err.message);
    return res.status(500).send('retry');
  }
});

// --------------------------------------------------
// 5. المهام
// --------------------------------------------------

// --------------------------------------------------
// التحقق الفعلي من الانضمام عبر Telegram Bot API (getChatMember)
// --------------------------------------------------

const TELEGRAM_RESERVED_PATHS = new Set([
  'joinchat', 'addstickers', 'addemoji', 'addtheme', 'addlist', 'setlanguage', 'share',
  'proxy', 'socks', 'login', 'invoice', 'boost', 'iv', 'giftcode', 'contact', 'bg',
  'confirmphone', 'message', 'web'
]);

// يستخرج اسم القناة/المجموعة العامة من رابط t.me. الروابط الخاصة (+invite / joinchat / c/)
// لا يمكن التحقق منها عبر getChatMember فتُرفض.
function extractTelegramChat(link) {
  let url;
  try { url = link instanceof URL ? link : new URL(String(link)); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (!['t.me', 'telegram.me', 'telegram.dog'].includes(host)) return null;
  const first = url.pathname.split('/').filter(Boolean)[0];
  if (!first || !/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(first)) return null;
  if (TELEGRAM_RESERVED_PATHS.has(first.toLowerCase())) return null;
  return { username: first, chatId: `@${first}`, link: `https://t.me/${first}` };
}

// استدعاء Bot API؛ يُرجع JSON الخام (ok / result / description) حتى في حالة أخطاء 4xx.
function telegramBotApi(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!TELEGRAM_BOT_TOKEN) return reject(new Error('TELEGRAM_BOT_TOKEN غير مضبوط'));
    const query = new URLSearchParams(params).toString();
    const req = https.get(
      { hostname: 'api.telegram.org', path: `/bot${TELEGRAM_BOT_TOKEN}/${method}?${query}`, headers: { Accept: 'application/json' } },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
          if (raw.length > 200000) req.destroy(new Error('response too large'));
        });
        res.on('end', () => {
          try { resolve(JSON.parse(raw)); } catch { reject(new Error('invalid JSON from Telegram')); }
        });
      }
    );
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
    // لا نمرر رسالة الخطأ الأصلية كما هي حتى لا يتسرب مسار الطلب (يحتوي رمز البوت) إلى السجلات.
    req.on('error', (err) => reject(new Error(`Telegram request failed: ${err.code || err.message}`)));
  });
}

// يرجع { isMember } أو يرمي خطأ (unverifiable) إذا تعذر التحقق (البوت ليس مشرفًا، القناة محذوفة، حد الطلبات...).
async function checkTelegramMembership(chatId, telegramUserId) {
  const data = await telegramBotApi('getChatMember', { chat_id: chatId, user_id: String(telegramUserId) });
  if (data && data.ok && data.result) {
    const status = data.result.status;
    const isMember = ['creator', 'administrator', 'member'].includes(status) ||
      (status === 'restricted' && data.result.is_member === true);
    return { isMember };
  }
  const description = String((data && data.description) || '').toLowerCase();
  if (description.includes('user not found') || description.includes('participant_id_invalid')) {
    return { isMember: false };
  }
  const err = new Error(`getChatMember failed: ${(data && data.error_code) || '?'} ${description}`);
  err.unverifiable = true;
  throw err;
}

// عند إنشاء المهمة: نتأكد أن الرابط قناة/مجموعة عامة وأن البوت يستطيع قراءة أعضائها.
async function assertBotCanVerifyChat(chat, probeUserId) {
  const info = await telegramBotApi('getChat', { chat_id: chat.chatId });
  if (!info || !info.ok || !info.result || !['channel', 'supergroup', 'group'].includes(info.result.type)) {
    return { ok: false, message: 'الرابط لا يشير إلى قناة أو مجموعة تلغرام عامة موجودة.' };
  }
  try {
    await checkTelegramMembership(chat.chatId, probeUserId);
  } catch {
    return { ok: false, message: 'أضف البوت كمشرف (Admin) في القناة أو المجموعة أولاً ليتمكن من التحقق من المنضمين، ثم أعد إنشاء المهمة.' };
  }
  return { ok: true };
}

const taskVerifyCooldown = new Map();

app.get('/api/tasks', async (req, res) => {
  try {
    // لا نُرجع معرّفات منشئي المهام أو قائمة هويات جميع من أكملوها إلى مسار عام.
    const tasks = await Task.find({ status: { $ne: 'مكتملة' } })
      .select('_id title platform link current target cost status createdAt')
      .sort({ createdAt: -1 }).lean();
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: 'خطأ في جلب المهام' });
  }
});

app.get('/api/tasks/list', userRequestAuth, async (req, res) => {
  try {
    const tasks = await Task.find({ status: { $ne: 'مكتملة' } }).sort({ createdAt: -1 });

    res.json({
      success: true,
      tasks: tasks.map((t) => ({
        id: t._id,
        creatorId: t.creatorId,
        title: t.title,
        platform: t.platform,
        link: t.link,
        targetUsers: t.target,
        current: t.current,
        rewardGold: TASK_REWARD_GOLD,
        verifiable: !!extractTelegramChat(t.link),
        // توافق مع الواجهة: نكشف حالة إتمام المستخدم الحالي فقط، لا هويات بقية المستخدمين.
        completedBy: (t.completedBy || []).map(String).includes(String(req.telegramUser.id)) ? [String(req.telegramUser.id)] : []
      }))
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'خطأ في جلب المهام' });
  }
});


async function createPaidTask(req, res, legacyRoute = false) {
  const userId = String(req.telegramUser.id);
  const { title, platform, link } = req.body;
  const target = Number(legacyRoute ? (req.body.target ?? req.body.targetUsers ?? 50) : req.body.targetUsers);
  if (typeof title !== 'string' || !title.trim() || typeof link !== 'string' ||
      !Number.isInteger(target) || target < 50 || target > 10000 || target % 50 !== 0) {
    return res.status(400).json({ success: false, message: 'بيانات المهمة غير صالحة؛ العدد يجب أن يكون من 50 إلى 10000 وبمضاعفات 50.' });
  }
  let parsedUrl;
  try { parsedUrl = new URL(link); } catch {
    return res.status(400).json({ success: false, message: 'رابط المهمة غير صالح' });
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return res.status(400).json({ success: false, message: 'يسمح بروابط HTTP وHTTPS فقط' });
  }
  // روابط بصيغة https://t.me@evil.com تُستخدم للتصيّد؛ نرفض أي رابط يحمل اسم مستخدم أو كلمة مرور.
  if (parsedUrl.username || parsedUrl.password) {
    return res.status(400).json({ success: false, message: 'رابط المهمة غير صالح' });
  }
  // مهام قنوات/مجموعات تلغرام العامة يُتحقق منها فعليًا بـ getChatMember، لذا يجب أن يكون البوت مشرفًا فيها.
  // باقي الروابط (يوتيوب، إنستغرام، روابط دعوة خاصة...) تُقبل كما هي.
  const chat = extractTelegramChat(parsedUrl);
  if (chat) {
    try {
      const botCheck = await assertBotCanVerifyChat(chat, userId);
      if (!botCheck.ok) return res.status(400).json({ success: false, message: botCheck.message });
    } catch (err) {
      console.error('Task chat verification setup failed:', err.message);
      return res.status(503).json({ success: false, message: 'تعذر الاتصال بتلغرام للتحقق من القناة، حاول لاحقًا.' });
    }
  }
  const totalCost = target / 50; // $1 per 50 users; 10,000 users costs $200.
  const session = await mongoose.startSession();
  let createdTask;
  try {
    await session.withTransaction(async () => {
      const chargedUser = await User.findOneAndUpdate(
        { telegramId: userId, isBanned: { $ne: true }, balance: { $gte: totalCost } },
        { $inc: { balance: -totalCost } },
        { new: true, session }
      );
      if (!chargedUser) {
        const existing = await User.findOne({ telegramId: userId }).session(session);
        const e = new Error(!existing || existing.isBanned ? 'حساب محظور أو غير موجود' : `رصيد USD غير كافٍ. التكلفة المطلوبة: $${totalCost.toFixed(2)}`);
        e.statusCode = !existing || existing.isBanned ? 403 : 400;
        throw e;
      }
      const docs = await Task.create([{
        title: title.trim().slice(0, 160),
        platform: String(platform || 'Telegram').slice(0, 40),
        link: chat ? chat.link : parsedUrl.href, target, cost: totalCost.toFixed(2), creatorId: userId
      }], { session });
      createdTask = docs[0];
      await recordLedger({
        userId, type: 'task_create', currency: 'balance', amount: -totalCost, balanceAfter: chargedUser.balance,
        refKey: `task-create:${createdTask._id}`, description: `إنشاء مهمة: ${createdTask.title}`
      }, { session });
    });
    return res.status(201).json({ success: true, message: 'تم إنشاء المهمة بنجاح', task: createdTask, chargedUsd: totalCost });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
    console.error('Task creation transaction failed:', err);
    return res.status(500).json({ success: false, message: 'فشل إنشاء المهمة بأمان. تأكد أن MongoDB يدعم المعاملات (Replica Set).' });
  } finally { await session.endSession(); }
}

app.post('/api/tasks', userRequestAuth, async (req, res) => {
  try { return await createPaidTask(req, res, true); }
  catch (err) { console.error('Legacy task route error:', err); return res.status(500).json({ success: false, message: 'فشل إنشاء المهمة' }); }
});

app.post('/api/tasks/create', userRequestAuth, async (req, res) => {
  try { return await createPaidTask(req, res, false); }
  catch (err) { console.error('Task creation error:', err); return res.status(500).json({ success: false, message: 'خطأ في إنشاء المهمة' }); }
});

app.post('/api/tasks/visit-ticket', userRequestAuth, async (req, res) => {
  try {
    const userId = String(req.telegramUser.id);
    const taskId = String(req.body.taskId || '');
    if (!mongoose.isValidObjectId(taskId)) return res.status(400).json({ success: false, message: 'معرّف المهمة غير صالح' });
    const task = await Task.findOne({ _id: taskId, status: { $ne: 'مكتملة' } }).lean();
    if (!task) return res.status(404).json({ success: false, message: 'المهمة غير موجودة أو مكتملة' });
    if (String(task.creatorId) === userId) return res.status(403).json({ success: false, message: 'لا يمكنك إكمال مهمتك الخاصة' });
    if ((task.completedBy || []).map(String).includes(userId)) return res.status(400).json({ success: false, message: 'لقد أتممت هذه المهمة مسبقًا' });
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await TaskVisitTicket.create({ tokenHash, taskId: task._id, userId, expiresAt: new Date(Date.now() + 30 * 60 * 1000) });
    const base = String(process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    return res.json({ success: true, visitUrl: `${base}/api/tasks/visit/redirect/${token}` });
  } catch (err) {
    console.error('Visit ticket error:', err);
    return res.status(500).json({ success: false, message: 'تعذر تجهيز رابط الزيارة' });
  }
});

// مواقع معروفة تُحوَّل مباشرة؛ أي موقع آخر يمر عبر صفحة تحذير حتى لا يُستغل نطاقك في التصيّد.
const TRUSTED_TASK_HOSTS = [
  't.me', 'telegram.me', 'telegram.dog', 'telegram.org',
  'youtube.com', 'youtu.be', 'instagram.com', 'tiktok.com', 'facebook.com', 'fb.com', 'fb.me',
  'x.com', 'twitter.com', 'discord.gg', 'discord.com', 'whatsapp.com', 'wa.me',
  'snapchat.com', 'reddit.com', 'linkedin.com', 'twitch.tv'
];

function isTrustedTaskHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return TRUSTED_TASK_HOSTS.some((trusted) => host === trusted || host.endsWith(`.${trusted}`));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderExternalLinkWarning(destination) {
  const safeHost = escapeHtml(destination.hostname);
  const safeHref = escapeHtml(destination.href);
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>تنبيه قبل فتح الرابط</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Tahoma,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:24px;display:flex;justify-content:center}
.card{max-width:480px;width:100%;background:#1e293b;border-radius:16px;padding:24px;box-shadow:0 8px 30px rgba(0,0,0,.35)}
h1{font-size:20px;margin:0 0 12px}
p{line-height:1.7;margin:8px 0}
.host{direction:ltr;unicode-bidi:embed;background:#0f172a;border-radius:8px;padding:10px;word-break:break-all;font-family:monospace}
a.btn{display:block;text-align:center;margin-top:18px;padding:12px;border-radius:10px;background:#f59e0b;color:#111827;text-decoration:none;font-weight:700}
</style>
</head>
<body>
<div class="card">
<h1>⚠️ أنت تغادر Money Slayer</h1>
<p>هذا الرابط وضعه أحد المستخدمين ولم تراجعه المنصة. لا تُدخل كلمات مرور أو بيانات دفع أو رموز تحقق في الموقع التالي:</p>
<p class="host">${safeHost}</p>
<a class="btn" href="${safeHref}" rel="noopener noreferrer nofollow">أفهم المخاطر، تابع</a>
</div>
</body>
</html>`;
}

app.get('/api/tasks/visit/redirect/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '');
    if (!/^[a-f0-9]{64}$/.test(token)) return res.status(400).send('رابط الزيارة غير صالح');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const ticket = await TaskVisitTicket.findOneAndUpdate(
      { tokenHash, usedAt: null, expiresAt: { $gt: new Date() } },
      { $set: { usedAt: new Date() } }, { new: true }
    );
    if (!ticket) return res.status(410).send('انتهت صلاحية رابط الزيارة أو تم استخدامه');
    const task = await Task.findById(ticket.taskId).lean();
    if (!task) return res.status(410).send('المهمة لم تعد متاحة');
    const destination = new URL(task.link);
    if (!['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password) {
      return res.status(410).send('رابط المهمة غير صالح');
    }
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    if (isTrustedTaskHost(destination.hostname)) {
      return res.redirect(302, destination.href);
    }
    // موقع غير معروف: نعرض صفحة تحذير بدل تحويل مباشر من نطاقك الموثوق.
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
    res.set('X-Robots-Tag', 'noindex, nofollow');
    return res.status(200).type('html').send(renderExternalLinkWarning(destination));
  } catch (err) {
    console.error('Visit redirect error:', err);
    return res.status(500).send('تعذر فتح رابط المهمة');
  }
});

app.post('/api/tasks/complete', userRequestAuth, async (req, res) => {
  const userId = String(req.telegramUser.id);
  const taskId = String(req.body.taskId || '');
  const visitToken = String(req.body.visitToken || '');
  if (!mongoose.isValidObjectId(taskId) || !/^[a-f0-9]{64}$/.test(visitToken)) {
    return res.status(400).json({ success: false, message: 'يجب فتح رابط المهمة من زر الزيارة أولاً.' });
  }
  const tokenHash = crypto.createHash('sha256').update(visitToken).digest('hex');

  // تهدئة بين محاولات التحقق لنفس المستخدم.
  const now = Date.now();
  if (now - (taskVerifyCooldown.get(userId) || 0) < TASK_VERIFY_COOLDOWN_MS) {
    return res.status(429).json({ success: false, message: 'انتظر بضع ثوانٍ ثم حاول التحقق مجددًا.' });
  }
  taskVerifyCooldown.set(userId, now);
  if (taskVerifyCooldown.size > 5000) {
    for (const [key, ts] of taskVerifyCooldown) {
      if (now - ts > TASK_VERIFY_COOLDOWN_MS) taskVerifyCooldown.delete(key);
    }
  }

  const today = new Date().toISOString().slice(0, 10);

  try {
    // فحوص قراءة فقط قبل أي اتصال خارجي.
    const task = await Task.findOne({ _id: taskId, status: { $ne: 'مكتملة' } }).lean();
    if (!task) return res.status(404).json({ success: false, message: 'المهمة غير موجودة أو مكتملة' });
    if (String(task.creatorId) === userId) return res.status(403).json({ success: false, message: 'لا يمكنك إكمال مهمتك الخاصة' });
    if ((task.completedBy || []).map(String).includes(userId)) return res.status(400).json({ success: false, message: 'لقد أتممت هذه المهمة مسبقًا' });

    const chat = extractTelegramChat(task.link); // null = مهمة غير تلغرامية عامة (لا يمكن التحقق عبر Bot API)

    const visitedTicket = await TaskVisitTicket.findOne(
      { tokenHash, taskId, userId, usedAt: { $ne: null }, expiresAt: { $gt: new Date() } }
    ).lean();
    if (!visitedTicket) {
      return res.status(400).json({ success: false, message: 'لم يتم تسجيل زيارة صالحة لهذا الرابط. افتح المهمة من الزر ثم حاول مجددًا.' });
    }

    const dailyDoc = await TaskDailyCounter.findOne({ userId, day: today }).lean();
    if (dailyDoc && dailyDoc.count >= DAILY_TASK_REWARD_LIMIT) {
      return res.status(429).json({ success: false, message: `وصلت إلى الحد اليومي (${DAILY_TASK_REWARD_LIMIT} مهام). عد غدًا.`, dailyLimit: DAILY_TASK_REWARD_LIMIT });
    }

    if (chat) {
      // التحقق الفعلي: هل المستخدم عضو في القناة/المجموعة الآن؟
      let membership;
      try {
        membership = await checkTelegramMembership(chat.chatId, userId);
      } catch (err) {
        console.error('getChatMember verification unavailable:', err.message);
        return res.status(503).json({ success: false, message: 'تعذر التحقق من الانضمام حاليًا، حاول بعد قليل.' });
      }
      if (!membership.isMember) {
        return res.status(400).json({ success: false, message: 'لم نجد انضمامك للقناة/المجموعة. انضم أولاً ثم اضغط تحقق مرة أخرى.' });
      }
    } else if (UNVERIFIABLE_TASK_MIN_WAIT_MS > 0) {
      // لا توجد طريقة للتحقق من الإنجاز؛ نشترط على الأقل مرور وقت بعد فتح الرابط.
      const waitedMs = Date.now() - new Date(visitedTicket.usedAt).getTime();
      if (waitedMs < UNVERIFIABLE_TASK_MIN_WAIT_MS) {
        const remaining = Math.ceil((UNVERIFIABLE_TASK_MIN_WAIT_MS - waitedMs) / 1000);
        return res.status(400).json({ success: false, message: `أنجز المهمة أولاً ثم اضغط تحقق بعد ${remaining} ثانية.` });
      }
    }
  } catch (err) {
    console.error('Task pre-verification failed:', err);
    return res.status(500).json({ success: false, message: 'تعذر التحقق من المهمة.' });
  }

  const session = await mongoose.startSession();
  let updatedUser;
  let dailyCompleted = 0;
  try {
    await session.withTransaction(async () => {
      const user = await User.findOne({ telegramId: userId, isBanned: { $ne: true } }).session(session);
      if (!user) { const e = new Error('حساب محظور أو غير موجود'); e.statusCode = 403; throw e; }

      const ticket = await TaskVisitTicket.findOneAndUpdate(
        { tokenHash, taskId, userId, usedAt: { $ne: null }, expiresAt: { $gt: new Date() } },
        { $set: { usedAt: new Date() } }, { new: true, session }
      );
      if (!ticket) { const e = new Error('لم يتم تسجيل زيارة صالحة لهذا الرابط. افتح المهمة من الزر ثم حاول مجددًا.'); e.statusCode = 400; throw e; }

      // السقف اليومي بشكل ذري: التحديث لا يطابق إذا بلغ العداد السقف (وقد يؤدي لخطأ تكرار مفتاح عند الـ upsert).
      let counter;
      try {
        counter = await TaskDailyCounter.findOneAndUpdate(
          { userId, day: today, count: { $lt: DAILY_TASK_REWARD_LIMIT } },
          { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000) } },
          { upsert: true, new: true, session }
        );
      } catch (err) {
        if (err && err.code === 11000) {
          const e = new Error(`وصلت إلى الحد اليومي (${DAILY_TASK_REWARD_LIMIT} مهام). عد غدًا.`);
          e.statusCode = 429; throw e;
        }
        throw err;
      }
      dailyCompleted = counter ? counter.count : 0;

      const task = await Task.findOneAndUpdate(
        { _id: taskId, creatorId: { $ne: userId }, completedBy: { $ne: userId }, status: { $ne: 'مكتملة' }, $expr: { $lt: ['$current', '$target'] } },
        { $addToSet: { completedBy: userId }, $inc: { current: 1 } },
        { new: true, session }
      );
      if (!task) { const e = new Error('المهمة مكتملة أو سبق لك إتمامها أو لا يمكنك إكمال مهمتك الخاصة'); e.statusCode = 400; throw e; }
      if (task.current >= task.target) { task.status = 'مكتملة'; await task.save({ session }); }

      updatedUser = await User.findOneAndUpdate(
        { telegramId: userId, isBanned: { $ne: true } }, { $inc: { gold: TASK_REWARD_GOLD } }, { new: true, session }
      );
      if (!updatedUser) { const e = new Error('تعذر تحديث رصيد المكافأة'); e.statusCode = 500; throw e; }
      await recordLedger({
        userId, type: 'task_reward', currency: 'gold', amount: TASK_REWARD_GOLD, balanceAfter: updatedUser.gold,
        refKey: `task:${task._id}`, description: task.title || 'مهمة'
      }, { session });
    });
    // لا شرط مهام لمكافأة الإحالة حاليًا (REFERRAL_QUALIFY_TASKS = 0)، فلا حاجة لاستدعاء qualifyReferralIfEligible هنا.
    return res.json({
      success: true,
      rewardGold: TASK_REWARD_GOLD,
      dailyCompleted,
      dailyLimit: DAILY_TASK_REWARD_LIMIT,
      message: `تم إتمام المهمة بنجاح! حصلت على ${TASK_REWARD_GOLD} ذهبة`,
      user: publicUser(updatedUser)
    });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
    console.error('Task completion transaction failed:', err);
    return res.status(500).json({ success: false, message: 'تعذر إتمام المهمة بأمان. تأكد أن MongoDB يدعم المعاملات (Replica Set).' });
  } finally { await session.endSession(); }
});

// --------------------------------------------------
// 6. لعبة الصاروخ - جولات مشتركة متعددة اللاعبين
// --------------------------------------------------

const ROCKET_BETTING_SECONDS = 8;
const ROCKET_ROUND_PAUSE_SECONDS = 3;

function publicTelegramId(id) {
  const value = String(id || '');
  if (value.length <= 2) return '*'.repeat(value.length);
  return `${value.slice(0, 2)}${'*'.repeat(Math.min(8, Math.max(4, value.length - 2)))}`;
}

async function ensurePublicRocketRound() {
  const now = new Date();
  let round = await PublicRocketRound.findOne({ status: { $in: ['betting', 'running'] } })
    .sort({ createdAt: -1 });

  if (round && round.status === 'betting' && now >= round.bettingEndsAt) {
    const startedAt = round.bettingEndsAt;
    const crashAt = new Date(startedAt.getTime() + (Math.log(round.crashMultiplier) / ROCKET_GROWTH_RATE) * 1000);
    round = await PublicRocketRound.findOneAndUpdate(
      { _id: round._id, status: 'betting' },
      { $set: { status: 'running', startedAt, crashAt } },
      { new: true }
    ) || await PublicRocketRound.findById(round._id);
  }

  if (round && round.status === 'running' && round.crashAt && now >= round.crashAt) {
    await PublicRocketRound.updateOne(
      { _id: round._id, status: 'running' },
      { $set: { status: 'crashed', crashedAt: now } }
    );
    await RocketBet.updateMany(
      { roundId: round.roundId, status: 'active' },
      { $set: { status: 'lost' } }
    );
    round = await PublicRocketRound.findById(round._id);
  }

  if (!round || (round.status === 'crashed' && now.getTime() - new Date(round.crashedAt || round.updatedAt).getTime() >= ROCKET_ROUND_PAUSE_SECONDS * 1000)) {
    const current = await PublicRocketRound.findOne({ status: { $in: ['betting', 'running'] } }).sort({ createdAt: -1 });
    if (current) return current;
    const createdAt = new Date();
    try {
      round = await new PublicRocketRound({
        roundId: randomId(),
        status: 'betting',
        crashMultiplier: generateCrashMultiplier(),
        bettingEndsAt: new Date(createdAt.getTime() + ROCKET_BETTING_SECONDS * 1000)
      }).save();
    } catch (err) {
      // إذا أنشأ طلب متزامن الجولة أولًا، نقرأ الجولة التي أنشأها.
      round = await PublicRocketRound.findOne({ status: { $in: ['betting', 'running'] } }).sort({ createdAt: -1 });
      if (!round) throw err;
    }
  }
  return round;
}

async function getPublicRocketBets(roundId) {
  const bets = await RocketBet.find({ roundId }).sort({ createdAt: -1 }).limit(100).lean();
  if (!bets.length) return [];
  const ids = [...new Set(bets.map((bet) => bet.userId))];
  const users = await User.find({ telegramId: { $in: ids } }).select('telegramId name').lean();
  const byId = new Map(users.map((user) => [user.telegramId, user]));
  return bets.map((bet) => {
    const user = byId.get(bet.userId);
    return {
      betId: String(bet._id),
      userId: publicTelegramId(bet.userId),
      name: user?.name || 'مستخدم Telegram',
      betSlot: bet.betSlot,
      betAmount: bet.betAmount,
      status: bet.status,
      cashOutMultiplier: bet.cashOutMultiplier,
      wonAmount: bet.wonAmount
    };
  });
}

async function rocketRoundPayload(round, userId) {
  if (!round) return { round: null, bets: [] };
  const [bets, ownBets] = await Promise.all([
    getPublicRocketBets(round.roundId),
    userId ? RocketBet.find({ roundId: round.roundId, userId }).sort({ betSlot: 1 }).lean() : []
  ]);
  const now = Date.now();
  const currentMultiplier = round.status === 'running' && round.startedAt
    ? Math.min(calculateMultiplier(round.startedAt, now), round.crashMultiplier)
    : (round.status === 'betting' ? 1 : null);
  return {
    round: {
      roundId: round.roundId,
      status: round.status,
      bettingEndsAt: round.bettingEndsAt,
      startedAt: round.startedAt,
      crashedAt: round.crashedAt,
      currentMultiplier,
      // لا نكشف نقطة الانفجار قبل انتهاء الجولة.
      crashMultiplier: round.status === 'crashed' ? round.crashMultiplier : undefined,
      ownBets: ownBets.map((bet) => ({
        betId: String(bet._id), betSlot: bet.betSlot, betAmount: bet.betAmount,
        status: bet.status, cashOutMultiplier: bet.cashOutMultiplier, wonAmount: bet.wonAmount
      }))
    },
    bets
  };
}

async function sendRocketState(req, res) {
  const userId = req.telegramUser.id;
  const user = await User.findOne({ telegramId: userId });
  if (!user) return res.status(404).json({ success: false, message: 'المستخدم غير موجود. افتح ملف المستخدم أولاً.' });
  if (user.isBanned) return res.status(403).json({ success: false, message: 'حساب محظور' });
  const globalRound = await ensurePublicRocketRound();
  const payload = await rocketRoundPayload(globalRound, userId);
  return res.json({
    success: true,
    balance: user.gold,
    config: {
      lossRate: ROCKET_LOSS_RATE, winRate: ROCKET_WIN_RATE,
      houseEdge: rocketConfig.houseEdge, maxMultiplier: rocketConfig.maxMultiplier, minBet: rocketConfig.minBet,
      maxBet: rocketConfig.maxBet, bettingSeconds: ROCKET_BETTING_SECONDS
    },
    round: payload.round,
    bets: payload.bets
  });
}

app.get('/api/games/rocket/status', rocketAuth, async (req, res) => {
  try { return await sendRocketState(req, res); }
  catch (err) {
    console.error('rocket status error:', err);
    return res.status(500).json({ success: false, message: 'خطأ في جلب بيانات لعبة الصاروخ' });
  }
});

app.post('/api/games/rocket/state', rocketAuth, async (req, res) => {
  try { return await sendRocketState(req, res); }
  catch (err) {
    console.error('rocket state error:', err);
    return res.status(500).json({ success: false, message: 'تعذر تحديث حالة لعبة الصاروخ' });
  }
});

// هذا المسار يسمح برهان واحد أو رهانيْن في خانتي الواجهة خلال نافذة المراهنة.
// يمكن للصاروخ أن يعمل دون أي رهانات؛ وجود رهان ليس شرطًا لإنشاء الجولة أو تحريكها.
app.post('/api/games/rocket/start', rocketAuth, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const userId = req.telegramUser.id;
    const betAmount = Number(req.body.betAmount);
    const betSlot = Number(req.body.betSlot || 1);
    if (!Number.isSafeInteger(betAmount) || betAmount < rocketConfig.minBet || betAmount > rocketConfig.maxBet) {
      return res.status(400).json({ success: false, message: 'مبلغ الرهان يجب أن يكون عددًا صحيحًا ضمن الحد المسموح' });
    }
    if (![1, 2].includes(betSlot)) {
      return res.status(400).json({ success: false, message: 'خانة الرهان غير صالحة' });
    }

    const round = await ensurePublicRocketRound();
    if (round.status !== 'betting' || Date.now() >= new Date(round.bettingEndsAt).getTime()) {
      return res.status(409).json({ success: false, message: 'بدأ صعود الصاروخ؛ انتظر الجولة التالية', roundId: round.roundId });
    }

    let updatedUser;
    let bet;
    await session.withTransaction(async () => {
      const currentRound = await PublicRocketRound.findOne({
        _id: round._id, status: 'betting', bettingEndsAt: { $gt: new Date() }
      }).session(session);
      if (!currentRound) {
        const e = new Error('بدأ صعود الصاروخ؛ انتظر الجولة التالية');
        e.statusCode = 409;
        throw e;
      }

      const existingBet = await RocketBet.findOne({ roundId: round.roundId, userId, betSlot }).session(session);
      if (existingBet) {
        const e = new Error('وضعت رهانًا بالفعل في هذه الخانة لهذه الجولة');
        e.statusCode = 409;
        throw e;
      }

      updatedUser = await User.findOneAndUpdate(
        { telegramId: userId, isBanned: { $ne: true }, gold: { $gte: betAmount } },
        { $inc: { gold: -betAmount } },
        { new: true, session }
      );
      if (!updatedUser) {
        const existingUser = await User.findOne({ telegramId: userId }).select('isBanned').session(session);
        const e = new Error(!existingUser ? 'المستخدم غير موجود' : existingUser.isBanned ? 'حساب محظور' : 'رصيدك من الذهب غير كافٍ');
        e.statusCode = !existingUser || existingUser.isBanned ? 403 : 400;
        throw e;
      }

      bet = new RocketBet({ roundId: round.roundId, userId, betSlot, betAmount, status: 'active' });
      await bet.save({ session });
      await recordLedger({
        userId, type: 'rocket_bet', currency: 'gold', amount: -betAmount, balanceAfter: updatedUser.gold,
        refKey: `bet:${bet._id}`, description: `رهان ${betAmount} ذهب`
      }, { session });
    });

    const payload = await rocketRoundPayload(round, userId);
    return res.status(201).json({
      success: true, message: 'تم تسجيل رهانك في الجولة المشتركة', balance: updatedUser.gold,
      round: payload.round, bets: payload.bets,
      bet: { betId: String(bet._id), roundId: bet.roundId, betSlot: bet.betSlot, betAmount: bet.betAmount, status: bet.status }
    });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
    if (err && err.code === 11000) return res.status(409).json({ success: false, message: 'وضعت رهانًا بالفعل في هذه الخانة لهذه الجولة' });
    console.error('rocket start transaction failed:', err);
    return res.status(500).json({ success: false, message: 'تعذر تسجيل الرهان بأمان. تأكد أن MongoDB يدعم المعاملات (Replica Set).' });
  } finally {
    await session.endSession();
  }
});

app.post('/api/games/rocket/cashout', rocketAuth, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const userId = req.telegramUser.id;
    const { roundId, betId, betSlot } = req.body;
    if (!roundId || typeof roundId !== 'string') {
      return res.status(400).json({ success: false, message: 'معرف الجولة غير صالح' });
    }

    await ensurePublicRocketRound();
    const now = new Date();
    let round;
    let claimedBet;
    let updatedUser;
    let multiplier;
    let wonAmount;

    await session.withTransaction(async () => {
      round = await PublicRocketRound.findOne({ roundId }).session(session);
      if (!round) {
        const e = new Error('الجولة غير موجودة'); e.statusCode = 404; throw e;
      }
      if (round.status !== 'running' || !round.crashAt || now >= round.crashAt) {
        const e = new Error('انفجر الصاروخ أو انتهت الجولة قبل السحب');
        e.statusCode = 409; e.crashed = true; throw e;
      }

      const filter = { roundId, userId, status: 'active' };
      if (betId) filter._id = betId;
      else if (betSlot != null) filter.betSlot = Number(betSlot);
      const bet = await RocketBet.findOne(filter).session(session);
      if (!bet) {
        const e = new Error('لا يوجد رهان نشط لك في هذه الخانة'); e.statusCode = 404; throw e;
      }

      multiplier = Math.min(calculateMultiplier(round.startedAt, now.getTime()), round.crashMultiplier);
      wonAmount = Math.floor(bet.betAmount * multiplier);
      claimedBet = await RocketBet.findOneAndUpdate(
        { _id: bet._id, status: 'active' },
        { $set: { status: 'cashed_out', cashOutMultiplier: multiplier, wonAmount, cashedOutAt: now } },
        { new: true, session }
      );
      if (!claimedBet) {
        const e = new Error('تمت تسوية هذا الرهان مسبقًا'); e.statusCode = 409; throw e;
      }

      updatedUser = await User.findOneAndUpdate(
        { telegramId: userId, isBanned: { $ne: true } },
        { $inc: { gold: wonAmount } },
        { new: true, session }
      );
      if (!updatedUser) {
        const e = new Error('حسابك غير موجود أو محظور؛ لم تُعتمد تسوية الرهان'); e.statusCode = 403; throw e;
      }
      await recordLedger({
        userId, type: 'rocket_win', currency: 'gold', amount: wonAmount, balanceAfter: updatedUser.gold,
        refKey: `bet:${claimedBet._id}`, description: `سحب عند ${multiplier}x`
      }, { session });
    });

    const payload = await rocketRoundPayload(round, userId);
    return res.json({
      success: true, message: `نجح السحب عند ${multiplier}x`, roundId,
      betId: String(claimedBet._id), betSlot: claimedBet.betSlot,
      cashOutMultiplier: multiplier, wonAmount, balance: updatedUser.gold,
      roundStatus: 'cashed_out', round: payload.round, bets: payload.bets
    });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, crashed: Boolean(err.crashed), message: err.message });
    console.error('rocket cashout transaction failed:', err);
    return res.status(500).json({ success: false, message: 'تعذر تنفيذ السحب بأمان. تأكد أن MongoDB يدعم المعاملات (Replica Set).' });
  } finally {
    await session.endSession();
  }
});

// بيانات عامة لعرض رهانات الجولة الحالية؛ لا نُنشئ أسماء أو رهانات وهمية.
app.get('/api/games/rocket/bets', rocketAuth, async (req, res) => {
  try {
    const round = await ensurePublicRocketRound();
    return res.json({ success: true, roundId: round.roundId, bets: await getPublicRocketBets(round.roundId) });
  } catch (err) {
    console.error('rocket bets error:', err);
    return res.status(500).json({ success: false, message: 'تعذر جلب رهانات الجولة' });
  }
});

// توافق واضح مع الواجهة القديمة: لا نقبل نتيجة يحددها العميل.
app.post('/api/games/rocket/play', (req, res) => {
  res.status(410).json({
    success: false,
    message: 'هذا المسار قديم. استخدم /api/games/rocket/start ثم /api/games/rocket/cashout.'
  });
});

// --------------------------------------------------
// 7. لوحة الأدمن
// تنبيه: التحقق باستخدام adminId في الطلب ليس مصادقة آمنة.
// أبقيت سلوك المسارات القديمة للتوافق، ويلزم تأمينها لاحقًا.
// --------------------------------------------------

app.get('/api/admin/dashboard', adminAuth, async (req, res) => {
  try {
    if (String(req.query.adminId) !== ADMIN_ID) {
      return res.status(403).json({ success: false, message: 'غير مصرح لك بالوصول' });
    }

    const totalUsers = await User.countDocuments();
    const tasks = await Task.find({ status: { $ne: 'مكتملة' } }).sort({ createdAt: -1 });
    const pendingTxs = await Transaction.find({ status: 'pending' }).sort({ createdAt: -1 });
    const promos = await Promo.find().sort({ createdAt: -1 });

    // أرباح المنصة: كل عملة تُحتسب بمفردها دون خلط.
    // الذهب = صافي رهانات الصاروخ + رسوم إنشاء الرموز الترويجية + رسوم التحويل من الذهب.
    // الدولار = رسوم التحويل من العملات الأخرى (مسجلة بالدولار).
    const [rocketNetGold, promoFeesGold, ledgerTotals] = await Promise.all([
      RocketBet.aggregate([
        { $group: { _id: null, wagered: { $sum: '$betAmount' }, paidOut: { $sum: '$wonAmount' } } },
        { $project: { _id: 0, net: { $subtract: ['$wagered', '$paidOut'] } } }
      ]).then((rows) => rows[0]?.net || 0),
      PlatformFee.aggregate([
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]).then((rows) => rows[0]?.total || 0),
      PlatformRevenue.aggregate([
        { $group: { _id: '$currency', total: { $sum: '$amount' } } }
      ])
    ]);
    const ledgerGold = ledgerTotals.find((row) => row._id === 'gold')?.total || 0;
    const ledgerUsd = ledgerTotals.find((row) => row._id === 'usd')?.total || 0;
    const totalRevenueGold = Math.round((rocketNetGold + promoFeesGold + ledgerGold) * 100) / 100;
    const totalRevenueUsd = Math.round(ledgerUsd * 100) / 100;

    res.json({
      success: true,
      stats: {
        totalUsers,
        activeToday: Math.floor(totalUsers * 0.4),
        totalRevenue: totalRevenueUsd,
        totalRevenueGold,
        revenueBreakdown: {
          usd: { convertFees: totalRevenueUsd },
          gold: { rocketNet: rocketNetGold, promoFees: promoFeesGold, convertFees: Math.round(ledgerGold * 100) / 100 }
        },
        pendingCount: pendingTxs.length
      },
      transactions: pendingTxs.map((t) => ({
        id: t.txId,
        type: t.type,
        userId: t.userId,
        amount: t.amount,
        currency: 'USD',
        status: t.status
      })),
      tasks: tasks.map((t) => ({
        id: t._id,
        creatorId: t.creatorId,
        title: t.title,
        current: t.current,
        targetUsers: t.target
      })),
      promos: promos.map((p) => ({
        code: p.code,
        amount: p.amount,
        maxUses: p.maxUses,
        usedCount: p.usedCount
      })),
      rocketConfig: publicRocketConfig()
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في جلب بيانات لوحة التحكم' });
  }
});

// قائمة المستخدمين للأدمن: الأرصدة والأرباح وكل النشاطات (آخر 100 نشاط لكل مستخدم).
// تعريف الأرباح:
// - أرباح الذهب = صافي الصاروخ (المكسوب - المراهَن، للرهانات المسوّاة) + مكافآت المهام + مكافآت الإعلانات + الرموز الترويجية بالذهب + مكافآت الإحالة المستلمة.
// - أرباح الدولار = ما حُوّل إلى USDT + الرموز الترويجية بالدولار (التحويلات المسجلة بعد تفعيل سجل الإيرادات فقط).
app.get('/api/admin/users', adminAuth, async (req, res) => {
  try {
    if (String(req.query.adminId) !== ADMIN_ID) {
      return res.status(403).json({ success: false, message: 'غير مصرح لك بالوصول' });
    }

    const limit = Math.min(1000, Math.max(1, Number.parseInt(req.query.limit, 10) || 500));
    const ACTIVITY_LIMIT_PER_USER = 100;
    const FETCH_CAP = 5000;

    const [totalUsers, users] = await Promise.all([
      User.countDocuments(),
      User.find().sort({ createdAt: -1 }).limit(limit).lean()
    ]);

    const ids = users.map((user) => String(user.telegramId));
    if (!ids.length) {
      return res.json({ success: true, total: totalUsers, users: [] });
    }
    const idSet = new Set(ids);

    const [
      transactions, bets, rocketAgg, tasksDone, taskCountAgg,
      monetagRows, monetagAgg, promosUsed, promoAgg, createdPromos,
      referredUsers, conversions, convertUsdAgg, ledgerRows
    ] = await Promise.all([
      Transaction.find({ userId: { $in: ids } }).sort({ createdAt: -1 }).limit(FETCH_CAP).lean(),
      RocketBet.find({ userId: { $in: ids } }).sort({ createdAt: -1 }).limit(FETCH_CAP).lean(),
      RocketBet.aggregate([
        { $match: { userId: { $in: ids }, status: { $ne: 'active' } } },
        { $group: { _id: '$userId', wagered: { $sum: '$betAmount' }, won: { $sum: '$wonAmount' } } }
      ]),
      Task.find({ completedBy: { $in: ids } }).select('title completedBy createdAt').limit(FETCH_CAP).lean(),
      Task.aggregate([
        { $match: { completedBy: { $in: ids } } },
        { $unwind: '$completedBy' },
        { $match: { completedBy: { $in: ids } } },
        { $group: { _id: '$completedBy', count: { $sum: 1 } } }
      ]),
      MonetagAttempt.find({ userId: { $in: ids }, status: 'rewarded' }).sort({ rewardedAt: -1 }).limit(FETCH_CAP).lean(),
      MonetagAttempt.aggregate([
        { $match: { userId: { $in: ids }, status: 'rewarded' } },
        { $group: { _id: '$userId', count: { $sum: 1 } } }
      ]),
      Promo.find({ usedBy: { $in: ids } }).select('code amount type usedBy').limit(FETCH_CAP).lean(),
      Promo.aggregate([
        { $match: { usedBy: { $in: ids } } },
        { $unwind: '$usedBy' },
        { $match: { usedBy: { $in: ids } } },
        { $group: { _id: { userId: '$usedBy', type: '$type' }, total: { $sum: '$amount' } } }
      ]),
      Promo.find({ creatorId: { $in: ids }, fundingStatus: 'funded' })
        .select('code creatorId fundedAmount feeAmount createdAt').sort({ createdAt: -1 }).limit(FETCH_CAP).lean(),
      User.find({ referredBy: { $in: ids } })
        .select('telegramId name referredBy referralQualified createdAt').sort({ createdAt: -1 }).limit(FETCH_CAP).lean(),
      PlatformRevenue.find({ userId: { $in: ids }, source: 'convert_fee' }).sort({ createdAt: -1 }).limit(FETCH_CAP).lean(),
      PlatformRevenue.aggregate([
        { $match: { userId: { $in: ids }, source: 'convert_fee', to: 'USDT' } },
        { $group: { _id: '$userId', received: { $sum: '$receivedAmount' } } }
      ]),
      LedgerEntry.find({ userId: { $in: ids } }).sort({ createdAt: -1 }).limit(FETCH_CAP).lean()
    ]);

    // ---- مجاميع الأرباح لكل مستخدم ----
    const rocketNetByUser = new Map(rocketAgg.map((row) => [row._id, (Number(row.won) || 0) - (Number(row.wagered) || 0)]));
    const taskCountByUser = new Map(taskCountAgg.map((row) => [row._id, Number(row.count) || 0]));
    const monetagCountByUser = new Map(monetagAgg.map((row) => [row._id, Number(row.count) || 0]));
    const promoGoldByUser = new Map();
    const promoUsdByUser = new Map();
    for (const row of promoAgg) {
      const type = row._id.type || 'gold';
      if (type === 'gold') promoGoldByUser.set(row._id.userId, Number(row.total) || 0);
      else if (type === 'balance') promoUsdByUser.set(row._id.userId, Number(row.total) || 0);
    }
    const convertedUsdtByUser = new Map(convertUsdAgg.map((row) => [row._id, Number(row.received) || 0]));

    // ---- النشاطات ----
    const activitiesByUser = new Map();
    const pushActivity = (userId, activity) => {
      if (!idSet.has(userId)) return;
      if (!activitiesByUser.has(userId)) activitiesByUser.set(userId, []);
      activitiesByUser.get(userId).push(activity);
    };

    for (const tx of transactions) {
      pushActivity(String(tx.userId), {
        id: `tx-${tx.txId}`,
        type: tx.type === 'إيداع' ? 'deposit' : tx.type === 'سحب' ? 'withdraw' : String(tx.type || ''),
        amount: tx.amount,
        currency: 'balance',
        description: [tx.method, tx.details].filter(Boolean).join(' - ').slice(0, 200),
        status: tx.status,
        createdAt: tx.createdAt
      });
    }

    for (const bet of bets) {
      const won = bet.status === 'cashed_out';
      const lost = bet.status === 'lost';
      pushActivity(String(bet.userId), {
        id: `bet-${bet._id}`,
        type: 'rocket',
        amount: won ? (Number(bet.wonAmount) || 0) - (Number(bet.betAmount) || 0) : lost ? -(Number(bet.betAmount) || 0) : null,
        currency: 'gold',
        description: `رهان ${bet.betAmount} ذهب${won && bet.cashOutMultiplier ? ` - سحب عند ${bet.cashOutMultiplier}x` : ''}`,
        status: won ? 'ربح' : lost ? 'خسارة' : 'جارٍ',
        createdAt: bet.createdAt
      });
    }

    for (const task of tasksDone) {
      for (const completedId of (task.completedBy || []).map(String)) {
        pushActivity(completedId, {
          id: `task-${task._id}-${completedId}`,
          type: 'task',
          amount: TASK_REWARD_GOLD,
          currency: 'gold',
          description: task.title || 'مهمة',
          status: '',
          createdAt: null
        });
      }
    }

    for (const attempt of monetagRows) {
      pushActivity(String(attempt.userId), {
        id: `monetag-${attempt._id}`,
        type: 'bonus',
        amount: MONETAG_REWARD_GOLD,
        currency: 'gold',
        description: 'مكافأة مشاهدة إعلان',
        status: '',
        createdAt: attempt.rewardedAt || attempt.createdAt
      });
    }

    for (const promo of promosUsed) {
      for (const usedId of (promo.usedBy || []).map(String)) {
        const promoType = promo.type || 'gold';
        pushActivity(usedId, {
          id: `promo-use-${promo._id}-${usedId}`,
          type: 'promo',
          amount: promoType === 'gold' || promoType === 'balance' ? promo.amount : null,
          currency: promoType === 'balance' ? 'balance' : 'gold',
          description: `تفعيل الرمز ${promo.code}${promoType === 'diamonds' ? ` (${promo.amount} GRAM)` : ''}`,
          status: '',
          createdAt: null
        });
      }
    }

    for (const promo of createdPromos) {
      pushActivity(String(promo.creatorId), {
        id: `promo-create-${promo._id}`,
        type: 'promo',
        amount: -((Number(promo.fundedAmount) || 0) + (Number(promo.feeAmount) || 0)),
        currency: 'gold',
        description: `إنشاء الرمز ${promo.code} (رسوم المنصة ${promo.feeAmount || 0} ذهب)`,
        status: '',
        createdAt: promo.createdAt
      });
    }

    for (const friend of referredUsers) {
      pushActivity(String(friend.referredBy), {
        id: `ref-${friend.telegramId}`,
        type: 'referral',
        // قيمة المكافأة تظهر عند استلامها كقيد في السجل المالي (referral_claim)، فلا نكررها هنا.
        amount: null,
        currency: 'gold',
        description: `إحالة صديق: ${friend.name || friend.telegramId}`,
        status: '',
        createdAt: friend.createdAt
      });
    }

    for (const conversion of conversions) {
      pushActivity(String(conversion.userId), {
        id: `convert-${conversion._id}`,
        type: 'convert',
        amount: null,
        currency: conversion.from === 'GOLD' ? 'gold' : 'balance',
        description: `تحويل ${conversion.sourceAmount} ${conversion.from} إلى ${conversion.receivedAmount} ${conversion.to}`,
        status: '',
        createdAt: conversion.createdAt
      });
    }

    // دمج السجل المالي: القيود الجديدة (بتاريخ دقيق) تحل محل النشاطات القديمة المشتقة لنفس العملية.
    // قيود الإيداع/السحب (tx:) تبقى في السجل للتدقيق لكن لا تُعرض هنا لأن صف المعاملة الأصلي يعرض حالتها.
    const legacyRefKey = (activityId) => {
      const text = String(activityId || '');
      let match = /^bet-(.+)$/.exec(text);
      if (match) return `bet:${match[1]}`;
      match = /^task-([^-]+)-.+$/.exec(text);
      if (match) return `task:${match[1]}`;
      match = /^monetag-(.+)$/.exec(text);
      if (match) return `monetag:${match[1]}`;
      match = /^promo-use-([^-]+)-.+$/.exec(text);
      if (match) return `promo-use:${match[1]}`;
      match = /^promo-create-(.+)$/.exec(text);
      if (match) return `promo-create:${match[1]}`;
      match = /^convert-(.+)$/.exec(text);
      if (match) return `convert:${match[1]}`;
      return null;
    };
    const ledgerKeysByUser = new Map();
    const ledgerActivitiesByUser = new Map();
    for (const entry of ledgerRows) {
      const entryUserId = String(entry.userId);
      if (!ledgerKeysByUser.has(entryUserId)) ledgerKeysByUser.set(entryUserId, new Set());
      if (entry.refKey) ledgerKeysByUser.get(entryUserId).add(entry.refKey);
      if (entry.refKey && entry.refKey.startsWith('tx:')) continue;
      if (!ledgerActivitiesByUser.has(entryUserId)) ledgerActivitiesByUser.set(entryUserId, []);
      ledgerActivitiesByUser.get(entryUserId).push({
        id: `ledger-${entry._id}`,
        type: entry.type,
        amount: entry.amount,
        currency: entry.currency,
        description: entry.description || '',
        status: '',
        createdAt: entry.createdAt
      });
    }

    const timeOf = (value) => (value ? new Date(value).getTime() || 0 : 0);

    res.json({
      success: true,
      total: totalUsers,
      users: users.map((user) => {
        const id = String(user.telegramId);
        const coveredKeys = ledgerKeysByUser.get(id) || new Set();
        const legacyActivities = (activitiesByUser.get(id) || []).filter((activity) => {
          const key = legacyRefKey(activity.id);
          return !(key && coveredKeys.has(key));
        });
        const activities = [...legacyActivities, ...(ledgerActivitiesByUser.get(id) || [])]
          .sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt))
          .slice(0, ACTIVITY_LIMIT_PER_USER)
          .map((activity) => ({
            ...activity,
            createdAt: activity.createdAt ? new Date(activity.createdAt).toISOString() : null
          }));

        const profitGold =
          (rocketNetByUser.get(id) || 0) +
          (taskCountByUser.get(id) || 0) * TASK_REWARD_GOLD +
          (monetagCountByUser.get(id) || 0) * MONETAG_REWARD_GOLD +
          (promoGoldByUser.get(id) || 0) +
          Math.max(0, Number(user.totalReferralGold) || 0);
        const profitUsd = (convertedUsdtByUser.get(id) || 0) + (promoUsdByUser.get(id) || 0);

        return {
          id,
          name: user.name || '',
          username: '',
          balance: Number(user.balance) || 0,
          gold: Number(user.gold) || 0,
          totalProfit: Math.round(profitUsd * 100) / 100,
          totalProfitGold: Math.round(profitGold),
          isBanned: Boolean(user.isBanned),
          createdAt: user.createdAt || null,
          lastActive: user.lastActiveAt || null,
          activities
        };
      })
    });
  } catch (err) {
    console.error('admin users error:', err);
    res.status(500).json({ success: false, message: 'تعذر جلب بيانات المستخدمين' });
  }
});

// السجل المالي الموحّد: قائمة القيود مع فلاتر وملخص مجاميع لكل (نوع، عملة).
app.get('/api/admin/ledger', adminAuth, async (req, res) => {
  try {
    if (String(req.query.adminId) !== ADMIN_ID) {
      return res.status(403).json({ success: false, message: 'غير مصرح لك بالوصول' });
    }

    const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
    const baseFilter = {};
    if (req.query.userId) baseFilter.userId = String(req.query.userId).trim();
    if (req.query.type) baseFilter.type = String(req.query.type).trim();
    if (req.query.currency) baseFilter.currency = String(req.query.currency).trim();

    const pageFilter = { ...baseFilter };
    if (req.query.before) {
      const beforeDate = new Date(String(req.query.before));
      if (!Number.isNaN(beforeDate.getTime())) pageFilter.createdAt = { $lt: beforeDate };
    }

    const [rows, total, summary] = await Promise.all([
      LedgerEntry.find(pageFilter).sort({ createdAt: -1 }).limit(limit + 1).lean(),
      LedgerEntry.countDocuments(baseFilter),
      LedgerEntry.aggregate([
        { $match: baseFilter },
        { $group: { _id: { type: '$type', currency: '$currency' }, total: { $sum: '$amount' }, count: { $sum: 1 } } },
        { $sort: { '_id.type': 1, '_id.currency': 1 } }
      ])
    ]);

    const hasMore = rows.length > limit;
    const entries = rows.slice(0, limit);
    res.json({
      success: true,
      total,
      hasMore,
      nextBefore: hasMore && entries.length ? new Date(entries[entries.length - 1].createdAt).toISOString() : null,
      entries: entries.map((entry) => ({
        id: String(entry._id),
        userId: entry.userId,
        type: entry.type,
        currency: entry.currency,
        amount: entry.amount,
        balanceAfter: entry.balanceAfter,
        description: entry.description || '',
        refKey: entry.refKey || null,
        createdAt: entry.createdAt ? new Date(entry.createdAt).toISOString() : null
      })),
      summary: summary.map((row) => ({ type: row._id.type, currency: row._id.currency, total: row.total, count: row.count }))
    });
  } catch (err) {
    console.error('admin ledger error:', err);
    res.status(500).json({ success: false, message: 'تعذر جلب السجل المالي' });
  }
});

// سجل تدقيق إجراءات الأدمن (آخر العمليات الحساسة).
app.get('/api/admin/audit', adminAuth, async (req, res) => {
  try {
    if (String(req.query.adminId) !== ADMIN_ID) {
      return res.status(403).json({ success: false, message: 'غير مصرح لك بالوصول' });
    }
    const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 100));
    const rows = await AdminAudit.find().sort({ createdAt: -1 }).limit(limit).lean();
    res.json({
      success: true,
      entries: rows.map((row) => ({
        id: String(row._id),
        adminId: row.adminId,
        action: row.action,
        target: row.target,
        details: row.details,
        createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null
      }))
    });
  } catch (err) {
    console.error('admin audit error:', err);
    res.status(500).json({ success: false, message: 'تعذر جلب سجل التدقيق' });
  }
});

app.post('/api/admin/process-transaction', adminAuth, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { adminId, txId, action } = req.body;
    // adminAuth already verifies the signed Telegram identity; retain this field check for API compatibility.
    if (String(adminId) !== ADMIN_ID) {
      return res.status(403).json({ success: false, message: 'غير مصرح' });
    }
    if (!txId || !['accept', 'reject'].includes(action)) {
      return res.status(400).json({ success: false, message: 'المعاملة أو الإجراء غير صالح' });
    }

    let processedType = '';
    await session.withTransaction(async () => {
      const tx = await Transaction.findOne({ txId, status: 'pending' }).session(session);
      if (!tx) {
        const existing = await Transaction.findOne({ txId }).select('status').session(session);
        const e = new Error(existing ? 'تمت معالجة المعاملة مسبقًا' : 'المعاملة غير موجودة');
        e.statusCode = existing ? 409 : 404;
        throw e;
      }

      if ((action === 'accept' && tx.type === 'إيداع') || (action === 'reject' && tx.type === 'سحب')) {
        const delta = tx.type === 'إيداع' && action === 'accept' ? tx.amount : tx.amount;
        const balanceUpdate = await User.updateOne(
          { telegramId: tx.userId },
          { $inc: { balance: delta } },
          { session }
        );
        if (!balanceUpdate.matchedCount) {
          const e = new Error('لم يتم العثور على حساب صاحب المعاملة؛ لم تُعتمد المعاملة');
          e.statusCode = 404;
          throw e;
        }
        await recordLedger({
          userId: String(tx.userId), type: action === 'accept' ? 'deposit' : 'withdraw_refund', currency: 'balance', amount: delta,
          refKey: `tx:${tx.txId}`, description: action === 'accept' ? 'قبول إيداع' : 'رفض سحب واسترجاع المبلغ'
        }, { session });
      }

      const updatedTx = await Transaction.findOneAndUpdate(
        { _id: tx._id, status: 'pending' },
        { $set: { status: action === 'accept' ? 'approved' : 'rejected' } },
        { new: true, session }
      );
      if (!updatedTx) {
        const e = new Error('تمت معالجة المعاملة مسبقًا');
        e.statusCode = 409;
        throw e;
      }
      processedType = tx.type;
    });

    await recordAdminAudit(req.telegramUser.id, 'process_transaction', txId, { action, type: processedType });
    return res.json({ success: true, message: `تم ${action === 'accept' ? 'قبول' : 'رفض'} المعاملة بنجاح`, type: processedType });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
    console.error('process transaction failed:', err);
    return res.status(500).json({ success: false, message: 'تعذر معالجة المعاملة بأمان. تأكد أن MongoDB يدعم المعاملات (Replica Set).' });
  } finally {
    await session.endSession();
  }
});

app.get('/api/admin/rocket', adminAuth, async (req, res) => {
  try {
    if (String(req.query.adminId) !== ADMIN_ID) {
      return res.status(403).json({ success: false, message: 'غير مصرح لك بالوصول' });
    }
    const activeRound = await PublicRocketRound.findOne({ status: { $in: ['betting', 'running'] } })
      .sort({ createdAt: -1 }).lean();
    const recentRounds = await PublicRocketRound.find().sort({ createdAt: -1 }).limit(20).lean();
    const roundIds = recentRounds.map((round) => round.roundId);
    const [betStats, recentBets] = await Promise.all([
      RocketBet.aggregate([
        { $match: { roundId: { $in: roundIds } } },
        { $group: {
          _id: '$roundId', totalBets: { $sum: 1 },
          totalWagered: { $sum: '$betAmount' },
          cashedOut: { $sum: { $cond: [{ $eq: ['$status', 'cashed_out'] }, 1, 0] } },
          lost: { $sum: { $cond: [{ $eq: ['$status', 'lost'] }, 1, 0] } },
          paidOut: { $sum: '$wonAmount' }
        } }
      ]),
      RocketBet.find({ roundId: { $in: roundIds } }).sort({ createdAt: -1 }).limit(100).lean()
    ]);
    const statsByRound = new Map(betStats.map((item) => [item._id, item]));
    res.json({
      success: true,
      config: { ...publicRocketConfig(), growthRate: ROCKET_GROWTH_RATE },
      activeRound: activeRound ? {
        roundId: activeRound.roundId, status: activeRound.status,
        bettingEndsAt: activeRound.bettingEndsAt, startedAt: activeRound.startedAt,
        crashedAt: activeRound.crashedAt,
        crashMultiplier: activeRound.status === 'crashed' ? activeRound.crashMultiplier : undefined
      } : null,
      recentRounds: recentRounds.map((round) => ({
        roundId: round.roundId, status: round.status, createdAt: round.createdAt,
        startedAt: round.startedAt, crashedAt: round.crashedAt,
        crashMultiplier: round.status === 'crashed' ? round.crashMultiplier : undefined,
        stats: statsByRound.get(round.roundId) || { totalBets: 0, totalWagered: 0, cashedOut: 0, lost: 0, paidOut: 0 }
      })),
      recentBets: recentBets.map((bet) => ({
        id: String(bet._id), roundId: bet.roundId, userId: publicTelegramId(bet.userId),
        betSlot: bet.betSlot, betAmount: bet.betAmount, status: bet.status,
        cashOutMultiplier: bet.cashOutMultiplier, wonAmount: bet.wonAmount, createdAt: bet.createdAt
      }))
    });
  } catch (err) {
    console.error('admin rocket error:', err);
    res.status(500).json({ success: false, message: 'تعذر جلب بيانات الصاروخ' });
  }
});

app.post('/api/admin/update-rocket', adminAuth, async (req, res) => {
  try {
    if (String(req.body.adminId) !== ADMIN_ID) {
      return res.status(403).json({ success: false, message: 'غير مصرح' });
    }

    // lossRate و winRate حقلان قديمان مشتقان ولا يُعدَّلان؛ المتحكم الفعلي هو هامش المنصة (houseEdgePercent).
    const parsed = parseRocketSettingsInput(req.body);
    if (parsed.error) {
      return res.status(400).json({ success: false, message: parsed.error, config: publicRocketConfig() });
    }
    if (!parsed.changed) {
      return res.json({ success: true, message: 'لم يتم إرسال أي تغيير؛ هذه هي الإعدادات الحالية.', config: publicRocketConfig() });
    }

    const before = publicRocketConfig();
    const now = new Date();
    const saved = await RocketSettings.findOneAndUpdate(
      { key: 'rocket' },
      { $set: { ...parsed.values, updatedBy: String(req.telegramUser.id), updatedAt: now } },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    ).lean();
    applyRocketConfig(saved);

    const after = publicRocketConfig();
    await recordAdminAudit(req.telegramUser.id, 'rocket_settings_update', 'rocket', { before, after });

    return res.json({
      success: true,
      message: 'تم حفظ إعدادات الصاروخ في قاعدة البيانات، وتسري على الجولات القادمة (الجولة الحالية لا تتغير).',
      config: after
    });
  } catch (err) {
    console.error('update rocket settings error:', err);
    res.status(500).json({ success: false, message: 'تعذر حفظ إعدادات الصاروخ' });
  }
});

app.post('/api/admin/user-ban', adminAuth, async (req, res) => {
  try {
    const { adminId, targetUserId, action } = req.body;

    if (String(adminId) !== ADMIN_ID) {
      return res.status(403).json({ success: false, message: 'غير مصرح' });
    }

    const user = await User.findOne({ telegramId: String(targetUserId) });
    if (!user) return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });

    user.isBanned = action === 'ban';
    await user.save();
    await recordAdminAudit(adminId, action === 'ban' ? 'ban_user' : 'unban_user', targetUserId, null);

    res.json({
      success: true,
      message: `تم ${action === 'ban' ? 'حظر' : 'فك حظر'} المستخدم بنجاح`
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في حظر المستخدم' });
  }
});

app.post('/api/admin/modify-balance', adminAuth, async (req, res) => {
  try {
    const { adminId, targetUserId, amount, type, action } = req.body;
    if (String(adminId) !== ADMIN_ID) return res.status(403).json({ success: false, message: 'غير مصرح' });

    const value = Number(amount);
    if (!targetUserId || !Number.isFinite(value) || value < 0 || !['add', 'subtract'].includes(action)) {
      return res.status(400).json({ success: false, message: 'بيانات غير صالحة' });
    }

    let balanceType = type || 'gold';
    if (balanceType === 'usd') balanceType = 'balance';
    if (!['gold', 'diamonds', 'balance'].includes(balanceType)) {
      return res.status(400).json({ success: false, message: 'نوع الرصيد غير صالح' });
    }
    if (['gold', 'diamonds'].includes(balanceType) && !Number.isSafeInteger(value)) {
      return res.status(400).json({ success: false, message: 'رصيد الذهب والألماس يجب أن يكون عددًا صحيحًا' });
    }

    let user;
    if (action === 'add') {
      user = await User.findOneAndUpdate(
        { telegramId: String(targetUserId) },
        { $inc: { [balanceType]: value }, $setOnInsert: { name: 'زائر كريم' } },
        { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
      );
    } else {
      user = await User.findOneAndUpdate(
        { telegramId: String(targetUserId), [balanceType]: { $gte: value } },
        { $inc: { [balanceType]: -value } },
        { new: true, runValidators: true }
      );
      if (!user) {
        const existing = await User.findOne({ telegramId: String(targetUserId) }).select('telegramId');
        return res.status(existing ? 400 : 404).json({ success: false, message: existing ? 'الرصيد لا يكفي للخصم' : 'المستخدم غير موجود' });
      }
    }

    await recordLedger({
      userId: String(targetUserId), type: 'admin_adjust', currency: balanceType, amount: action === 'add' ? value : -value,
      balanceAfter: user[balanceType], refKey: `admin:${Date.now()}`, description: 'تعديل من الإدارة', meta: { adminId: String(adminId) }
    });
    await recordAdminAudit(adminId, 'modify_balance', targetUserId, { action, currency: balanceType, amount: value });
    return res.json({ success: true, message: 'تم تعديل الرصيد بنجاح', user: publicUser(user) });
  } catch (err) {
    console.error('admin modify balance error:', err);
    return res.status(500).json({ success: false, message: 'خطأ في تعديل رصيد المستخدم' });
  }
});

app.post('/api/admin/delete-task', adminAuth, async (req, res) => {
  try {
    const { adminId, taskId } = req.body;

    if (String(adminId) !== ADMIN_ID) {
      return res.status(403).json({ success: false, message: 'غير مصرح' });
    }

    await Task.findByIdAndDelete(taskId);
    res.json({ success: true, message: 'تم حذف المهمة بنجاح' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ' });
  }
});

app.post('/api/admin/create-promo', adminAuth, async (req, res) => {
  try {
    const { adminId, code, maxUses, goldRewardPerPerson, amount, type } = req.body;

    if (String(adminId) !== ADMIN_ID) {
      return res.status(403).json({ success: false, message: 'غير مصرح' });
    }

    if (!code) {
      return res.status(400).json({ success: false, message: 'يرجى إدخال اسم الرمز' });
    }

    const cleanCode = String(code).trim().toUpperCase();

    if (await Promo.findOne({ code: cleanCode })) {
      return res.status(400).json({ success: false, message: 'هذا الكود موجود مسبقاً' });
    }

    const reward = Number(goldRewardPerPerson || amount || 1000);
    const uses = Number(maxUses || 100);

    if (!Number.isFinite(reward) || reward <= 0 || !Number.isInteger(uses) || uses <= 0) {
      return res.status(400).json({ success: false, message: 'قيمة المكافأة أو عدد الاستخدامات غير صالح' });
    }

    await new Promo({
      code: cleanCode,
      amount: reward,
      type: type || 'gold',
      maxUses: uses
    }).save();

    res.json({ success: true, message: 'تم إنشاء الكود الترويجي وإطلاقه بنجاح' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'فشل إنشاء الرمز' });
  }
});

app.post('/api/admin/delete-promo', adminAuth, async (req, res) => {
  try {
    const { adminId, code } = req.body;

    if (String(adminId) !== ADMIN_ID) {
      return res.status(403).json({ success: false, message: 'غير مصرح' });
    }

    if (!code) {
      return res.status(400).json({ success: false, message: 'الرمز مطلوب' });
    }

    await Promo.findOneAndDelete({ code: String(code).trim().toUpperCase() });
    res.json({ success: true, message: 'تم حذف الكود الترويجي بنجاح' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في حذف الكود' });
  }
});


// --------------------------------------------------
// رسالة /start الخاصة ببوت Money Slayer
// تعمل عبر Telegram long polling دون تغيير أي مسار من مسارات Express API.
// ملاحظة: يجب ألا يكون للبوت webhook أو نسخة polling أخرى تعمل بالتوكن نفسه.
// --------------------------------------------------
const START_BOT_TEXT =
  '👋 **Welcome to Money Slayer.**\n\n' +
  '📋 Complete simple tasks, play, farm, and withdraw TON and USDT!\n\n' +
  '🔥 Invite your friends and earn 100% of their earnings!\n\n' +
  '🚀 Click the button below to get started now';

const START_BOT_KEYBOARD = JSON.stringify({
  inline_keyboard: [
    [{ text: 'اضغط هنا للبدأ 💸', web_app: { url: 'https://boisterous-pithivier-f78928.netlify.app/' } }],
    [{ text: 'اشترك في قناتنا 💎', url: 'https://t.me/moneyslayerchannel' }],
    [{ text: 'انضم لمجموعتنا 💡', url: 'https://t.me/moneyslayergroup' }]
  ]
});

let telegramUpdateOffset = 0;
let telegramPollingStarted = false;

function telegramLongPollGetUpdates(offset) {
  return new Promise((resolve, reject) => {
    if (!TELEGRAM_BOT_TOKEN) return reject(new Error('TELEGRAM_BOT_TOKEN غير مضبوط'));
    const query = new URLSearchParams({
      offset: String(offset),
      timeout: '25',
      allowed_updates: JSON.stringify(['message'])
    }).toString();
    const req = https.get({
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_BOT_TOKEN}/getUpdates?${query}`,
      headers: { Accept: 'application/json' }
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > 1000000) req.destroy(new Error('Telegram response too large'));
      });
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          if (!data.ok) return reject(new Error(data.description || 'getUpdates failed'));
          resolve(data.result || []);
        } catch {
          reject(new Error('Invalid JSON from Telegram getUpdates'));
        }
      });
    });
    req.setTimeout(35000, () => req.destroy(new Error('Telegram long poll timeout')));
    req.on('error', (err) => reject(new Error(`Telegram polling failed: ${err.code || err.message}`)));
  });
}

async function handleTelegramStartUpdate(update) {
  const message = update && update.message;
  const text = message && typeof message.text === 'string' ? message.text.trim() : '';
  if (!message || !message.chat || !/^\/start(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text)) return;

  // رابط الإحالة عبر البوت: t.me/<bot>?start=ref_<id>. نحفظ الربط باستخدام message.from.id الموثوق.
  const payloadMatch = /^\/start(?:@[A-Za-z0-9_]+)?\s+(\S+)/i.exec(text);
  const referrerId = payloadMatch ? parseReferralParam(payloadMatch[1]) : null;
  const fromId = message.from && message.from.id != null ? String(message.from.id) : null;
  if (referrerId && fromId && fromId !== referrerId && mongoose.connection.readyState === 1) {
    try {
      const alreadyUser = await User.exists({ telegramId: fromId });
      if (!alreadyUser) {
        await PendingReferral.findOneAndUpdate(
          { telegramId: fromId },
          { $set: { referrerId, expiresAt: new Date(Date.now() + PENDING_REFERRAL_TTL_MS) } },
          { upsert: true }
        );
      }
    } catch (pendingErr) {
      console.error('pending referral save error:', pendingErr.message);
    }
  }

  const result = await telegramBotApi('sendMessage', {
    chat_id: String(message.chat.id),
    text: START_BOT_TEXT,
    parse_mode: 'Markdown',
    reply_markup: START_BOT_KEYBOARD,
    disable_web_page_preview: 'true'
  });
  if (!result || !result.ok) {
    throw new Error((result && result.description) || 'Telegram sendMessage failed');
  }
}

async function startTelegramStartPolling() {
  if (telegramPollingStarted || !TELEGRAM_BOT_TOKEN) return;
  telegramPollingStarted = true;
  console.log('🤖 تم تفعيل معالج /start لبوت Telegram عبر long polling');
  // وجود webhook مفعّل يمنع getUpdates تمامًا؛ نزيله دون حذف التحديثات المعلّقة.
  try {
    await telegramBotApi('deleteWebhook', { drop_pending_updates: 'false' });
  } catch (hookErr) {
    console.error('deleteWebhook error:', hookErr.message);
  }
  while (true) {
    try {
      const updates = await telegramLongPollGetUpdates(telegramUpdateOffset);
      for (const update of updates) {
        telegramUpdateOffset = Math.max(telegramUpdateOffset, Number(update.update_id) + 1);
        try {
          await handleTelegramStartUpdate(update);
        } catch (err) {
          console.error('Telegram /start handler error:', err.message);
        }
      }
    } catch (err) {
      console.error('Telegram polling error:', err.message);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

// --------------------------------------------------
// تشغيل السيرفر
// --------------------------------------------------

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 السيرفر يعمل على المنفذ ${PORT}`);
  startTelegramStartPolling();

  if (!TELEGRAM_BOT_TOKEN) {
    console.warn('⚠️ TELEGRAM_BOT_TOKEN غير مضبوط في Railway؛ ستُرفض طلبات الصاروخ بـ 401 حتى تضيف رمز البوت الصحيح من BotFather.');
  }
});
