const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const crypto = require('crypto');
const https = require('https');
require('dotenv').config();

const app = express();
app.disable('x-powered-by');

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

// لا تضع بيانات MongoDB السرية مباشرة في الكود.
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error('❌ يجب ضبط MONGO_URI في متغيرات البيئة');
}

mongoose.connect(MONGO_URI || 'mongodb://127.0.0.1:27017/moneyslayer')
  .then(() => {
    console.log('✅ تم الاتصال بقاعدة بيانات MongoDB');
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
// الصديق يُعد "نشطًا" إذا فتح التطبيق خلال آخر 7 أيام.
const FRIEND_ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// مكافأة المهام: 1000 Gold لكل مهمة، لكن فقط بعد التحقق الفعلي من الانضمام عبر Telegram Bot API.
const TASK_REWARD_GOLD = 1000;
// سقف يومي (بتوقيت UTC) لعدد المهام التي يُكافأ عليها المستخدم؛ الافتراضي 100 وقابل للضبط عبر DAILY_TASK_REWARD_LIMIT.
const DAILY_TASK_REWARD_LIMIT = Math.max(1, Number.parseInt(process.env.DAILY_TASK_REWARD_LIMIT, 10) || 100);
// للمهام التي لا يمكن التحقق منها عبر تلغرام: أقل مدة بين فتح الرابط وطلب المكافأة (ضع 0 لإلغائها).
const UNVERIFIABLE_TASK_MIN_WAIT_MS = 10 * 1000;
// أقل فاصل بين محاولتي تحقق لنفس المستخدم لحماية حصة Bot API من الإغراق.
const TASK_VERIFY_COOLDOWN_MS = 3000;

// إعدادات الصاروخ
// هامش نظري مستهدف للعبة: 5% على المدى الطويل وفق نموذج الاحتمالات أدناه؛
// ليس ضمانًا لربح المنصة في كل جولة أو فترة قصيرة.
const ROCKET_HOUSE_EDGE = 0.05;
// حقول توافق قديمة للواجهة؛ ليست نسبة فوز مضمونة لكل لاعب.
const ROCKET_LOSS_RATE = 65;
const ROCKET_WIN_RATE = 35;
const ROCKET_MAX_MULTIPLIER = 30;
const ROCKET_MIN_BET = 1;
const ROCKET_MAX_BET = 1000000;
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
  // مكافآت الإحالة المعلّقة (تنتظر ضغط زر الاستلام) والمستلمة سابقًا.
  pendingReferralGold: { type: Number, default: 0 },
  totalReferralGold: { type: Number, default: 0 },
  lastActiveAt: { type: Date, default: Date.now },
  isBanned: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

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

// يولّد نقطة الانهيار بتوزيع ذي هامش نظري مستهدف 5% عند السحب على مضاعف ثابت.
// توجد احتمالية لانهيار فوري تحت 1.00x؛ وهذا مقصود في نموذج Crash القياسي.
// سقف 30x يعني أن احتمال تجاوز السقف يُجمع عند 30x، ولا يضمن وصول كل جولة إليه.
// النتيجة مستقلة عن هوية اللاعب وحجم رهانه، ولا تُعد نسبة فوز ثابتة لكل لاعب.
function generateCrashMultiplier() {
  // rand في المجال (0, 1] لتجنب القسمة على صفر.
  const rand = (crypto.randomInt(0, 1000000) + 1) / 1000000;
  const rawMultiplier = (1 - ROCKET_HOUSE_EDGE) / rand;
  const cappedMultiplier = Math.min(ROCKET_MAX_MULTIPLIER, rawMultiplier);
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
    const referrerFromLink = parseReferralParam(verifiedTelegramUser?.start_param);
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
      .select('telegramId name createdAt referralRewardedAt')
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      referralCount: referrals.length,
      referrals: referrals.map((item) => ({
        userId: item.telegramId,
        name: item.name,
        createdAt: item.createdAt,
        rewarded: Boolean(item.referralRewardedAt)
      })),
      rewardPerReferral: REFERRAL_REWARD_GOLD,
      totalReferralGold: referrals.filter((item) => item.referralRewardedAt).length * REFERRAL_REWARD_GOLD,
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

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const [referredUser, referrer] = await Promise.all([
        User.findOne({ telegramId: referredUserId }).session(session),
        User.findOne({ telegramId: ownerId }).session(session)
      ]);

      if (!referredUser) { const e = new Error('يجب إنشاء حساب المستخدم أولاً'); e.statusCode = 404; throw e; }
      if (!referrer || referrer.isBanned) { const e = new Error('المُحيل غير موجود أو محظور'); e.statusCode = 404; throw e; }
      if (referredUser.isBanned) { const e = new Error('المستخدم محظور'); e.statusCode = 403; throw e; }
      if (referredUser.referredBy || referredUser.referralRewardedAt) {
        const e = new Error('تم تسجيل إحالة هذا المستخدم مسبقًا'); e.statusCode = 409; throw e;
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
        { $set: { referredBy: ownerId, referralRewardedAt: new Date() } },
        { new: true, session }
      );
      if (!claimedUser) { const e = new Error('تم تسجيل إحالة هذا المستخدم مسبقًا'); e.statusCode = 409; throw e; }

      const updatedReferrer = await User.findOneAndUpdate(
        { telegramId: ownerId, isBanned: { $ne: true } },
        { $inc: { referralCount: 1, pendingReferralGold: REFERRAL_REWARD_GOLD } },
        { new: true, session }
      );
      if (!updatedReferrer) { const e = new Error('تعذر تحديث حساب المُحيل'); e.statusCode = 404; throw e; }

      result = {
        success: true,
        status: 200,
        message: 'تم تسجيل الإحالة وإضافة المكافأة إلى رصيدك المعلّق',
        reward: REFERRAL_REWARD_GOLD,
        referralCount: updatedReferrer.referralCount,
        pendingReward: updatedReferrer.pendingReferralGold
      };
    });
    return result;
  } catch (err) {
    if (err.statusCode) return { success: false, status: err.statusCode, message: err.message };
    console.error('referral transaction failed:', err);
    throw err;
  } finally {
    await session.endSession();
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
      .select('telegramId name createdAt lastActiveAt')
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();

    const now = Date.now();
    res.json({
      success: true,
      friends: friends.map((friend) => ({
        telegramId: friend.telegramId,
        name: friend.name,
        earnedGold: REFERRAL_REWARD_GOLD,
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
// الحد الأدنى لقيمة أي عملية تحويل بالدولار (200 ذهب = 0.01$).
const MIN_CONVERT_USD = 0.01;
// رسوم التحويل بين العملات (0 = بدون رسوم، 0.01 = 1%). يمكن ضبطها من WALLET_CONVERT_FEE_RATE.
const WALLET_CONVERT_FEE_RATE = Math.min(
  0.5,
  Math.max(0, Number(process.env.WALLET_CONVERT_FEE_RATE) || 0)
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
    if (!['http:', 'https:'].includes(destination.protocol)) return res.status(410).send('رابط المهمة غير صالح');
    res.set('Cache-Control', 'no-store');
    return res.redirect(302, destination.href);
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
    });
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
      houseEdge: ROCKET_HOUSE_EDGE, maxMultiplier: ROCKET_MAX_MULTIPLIER, minBet: ROCKET_MIN_BET,
      maxBet: ROCKET_MAX_BET, bettingSeconds: ROCKET_BETTING_SECONDS
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
    if (!Number.isSafeInteger(betAmount) || betAmount < ROCKET_MIN_BET || betAmount > ROCKET_MAX_BET) {
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

    res.json({
      success: true,
      stats: {
        totalUsers,
        activeToday: Math.floor(totalUsers * 0.4),
        totalRevenue: await RocketBet.aggregate([
          { $group: { _id: null, wagered: { $sum: '$betAmount' }, paidOut: { $sum: '$wonAmount' } } },
          { $project: { _id: 0, net: { $subtract: ['$wagered', '$paidOut'] } } }
        ]).then((rows) => rows[0]?.net || 0),
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
      rocketConfig: {
        lossRate: ROCKET_LOSS_RATE,
        winRate: ROCKET_WIN_RATE,
        houseEdge: ROCKET_HOUSE_EDGE,
        maxMultiplier: ROCKET_MAX_MULTIPLIER
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في جلب بيانات لوحة التحكم' });
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
      config: { lossRate: ROCKET_LOSS_RATE, winRate: ROCKET_WIN_RATE, houseEdge: ROCKET_HOUSE_EDGE, maxMultiplier: ROCKET_MAX_MULTIPLIER, growthRate: ROCKET_GROWTH_RATE },
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
    const requestedKeys = ['lossRate', 'winRate', 'maxMultiplier'];
    const hasChanges = requestedKeys.some((key) => req.body[key] !== undefined);
    const config = {
      lossRate: ROCKET_LOSS_RATE,
      winRate: ROCKET_WIN_RATE,
      houseEdge: ROCKET_HOUSE_EDGE,
      maxMultiplier: ROCKET_MAX_MULTIPLIER
    };
    if (hasChanges) {
      return res.status(400).json({
        success: false,
        message: 'تعديل إعدادات الصاروخ غير مدعوم حاليًا لأن الإعدادات ليست مخزنة في قاعدة البيانات. لم يتم حفظ أي تغيير.',
        config
      });
    }
    return res.json({ success: true, message: 'هذه هي الإعدادات الحالية؛ لم يتم إجراء أي تعديل.', config });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ' });
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
