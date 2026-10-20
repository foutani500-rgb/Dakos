const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();

const app = express();

app.use(cors());
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
  gold: { type: Number, default: 1000 },
  diamonds: { type: Number, default: 10 },
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

const promoSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  amount: { type: Number, required: true },
  type: { type: String, required: true, default: 'gold' },
  maxUses: { type: Number, default: 100 },
  usedCount: { type: Number, default: 0 },
  usedBy: [{ type: String }],
  createdAt: { type: Date, default: Date.now }
});
const Promo = mongoose.model('Promo', promoSchema);

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

app.get('/api/user/profile', async (req, res) => {
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
    const isNewUser = !user;

    if (!user) {
      user = new User({
        telegramId: userId,
        name: verifiedTelegramUser?.first_name || 'زائر كريم',
        gold: 1000,
        diamonds: 10,
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
    await user.save();

    // تسجيل الإحالة تلقائيًا عند أول دخول عبر رابط ?startapp=ref_<id>.
    const referrerFromLink = parseReferralParam(verifiedTelegramUser?.start_param);
    if (isNewUser && referrerFromLink) {
      try {
        await registerReferral(user.telegramId, referrerFromLink);
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

app.post('/api/user/update-currency', async (req, res) => {
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

app.get('/api/referrals/stats', async (req, res) => {
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

  // مطالبة ذرية تمنع احتساب الإحالة مرتين عند وصول طلبات متزامنة.
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
    { new: true }
  );
  if (!claimedUser) return { success: false, status: 409, message: 'تم تسجيل إحالة هذا المستخدم مسبقًا' };

  const updatedReferrer = await User.findOneAndUpdate(
    { telegramId: ownerId, isBanned: { $ne: true } },
    { $inc: { referralCount: 1, pendingReferralGold: REFERRAL_REWARD_GOLD } },
    { new: true }
  );

  if (!updatedReferrer) {
    await User.updateOne(
      { telegramId: referredUserId, referredBy: ownerId },
      { $set: { referredBy: null, referralRewardedAt: null } }
    );
    return { success: false, status: 404, message: 'تعذر تحديث حساب المُحيل؛ حاول مجددًا' };
  }

  return {
    success: true,
    status: 200,
    message: 'تم تسجيل الإحالة وإضافة المكافأة إلى رصيدك المعلّق',
    reward: REFERRAL_REWARD_GOLD,
    referralCount: updatedReferrer.referralCount,
    pendingReward: updatedReferrer.pendingReferralGold
  };
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

app.get('/api/wallet/details', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ success: false, message: 'Missing userId' });

    const user = await User.findOne({ telegramId: String(userId) });

    if (user && user.isBanned) {
      return res.status(403).json({ success: false, message: 'حساب محظور' });
    }

    const transactions = await Transaction.find({ userId: String(userId) }).sort({ createdAt: -1 });

    res.json({
      success: true,
      balance: user ? user.balance : 0,
      gold: user ? user.gold : 0,
      assets: [
        { symbol: 'USDT', name: 'TetherUS', logo: '₮', color: '#26a69a', amount: user ? user.balance : 0, rate: 1 },
        { symbol: 'GRAM', name: 'Gram Token', logo: '💎', color: '#00d2ff', amount: user ? user.diamonds : 0, rate: 1.2 },
        { symbol: 'TRX', name: 'Tron', logo: 'TRX', color: '#ff0000', amount: 0, rate: 0.12 },
        { symbol: 'BTC', name: 'Bitcoin', logo: '₿', color: '#f7931a', amount: 0, rate: 68000 },
        { symbol: 'ETH', name: 'Ethereum', logo: 'Ξ', color: '#627eea', amount: 0, rate: 3400 },
        { symbol: 'SOL', name: 'Solana', logo: '◎', color: '#14f195', amount: 0, rate: 145 }
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

app.post('/api/wallet/exchange', async (req, res) => {
  try {
    const { userId, type, amount } = req.body;

    if (!userId || !isValidPositiveNumber(amount)) {
      return res.status(400).json({ success: false, message: 'بيانات غير صالحة' });
    }

    const user = await User.findOne({ telegramId: String(userId) });
    if (!user) return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
    if (user.isBanned) return res.status(403).json({ success: false, message: 'حساب محظور' });

    const val = Number(amount);

    if (type === 'diamonds_to_gram') {
      if (user.diamonds < val) {
        return res.status(400).json({ success: false, message: 'رصيد الألماس غير كافٍ' });
      }
      user.diamonds -= val;
      user.balance = (user.balance || 0) + val / 500;
    } else if (type === 'gold_to_diamonds') {
      if (user.gold < val) {
        return res.status(400).json({ success: false, message: 'رصيد الذهب غير كافٍ' });
      }
      user.gold -= val;
      user.diamonds = (user.diamonds || 0) + Math.floor(val / 200);
    } else {
      return res.status(400).json({ success: false, message: 'نوع التحويل غير صالح' });
    }

    await user.save();
    res.json({ success: true, message: 'تم التحويل بنجاح', user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في التحويل' });
  }
});

app.post('/api/wallet/convert', async (req, res) => {
  try {
    const { userId, amount } = req.body;

    if (!userId || !isValidPositiveNumber(amount)) {
      return res.status(400).json({ success: false, message: 'بيانات غير صالحة' });
    }

    const user = await User.findOne({ telegramId: String(userId) });
    if (!user) return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
    if (user.isBanned) return res.status(403).json({ success: false, message: 'حساب محظور' });

    res.json({ success: true, message: 'تم التحويل بنجاح' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في التحويل الفوري' });
  }
});

const handleTransfer = async (req, res) => {
  try {
    const { userId, recipientId, amount, type } = req.body;

    if (!userId || !isValidPositiveNumber(amount)) {
      return res.status(400).json({ success: false, message: 'بيانات غير صالحة' });
    }

    const sender = await User.findOne({ telegramId: String(userId) });
    if (!sender || sender.isBanned) {
      return res.status(404).json({ success: false, message: 'المستخدم غير موجود أو محظور' });
    }

    const transferAmount = Number(amount);
    const transferType = type || 'gold';

    if (!['gold', 'diamonds', 'balance'].includes(transferType)) {
      return res.status(400).json({ success: false, message: 'نوع الرصيد غير صالح' });
    }

    if ((sender[transferType] || 0) < transferAmount) {
      return res.status(400).json({ success: false, message: 'رصيدك غير كافٍ' });
    }

    const targetId = recipientId || req.body.toUserId;
    if (!targetId || String(targetId) === String(userId)) {
      return res.status(400).json({ success: false, message: 'معرف المستلم غير صالح' });
    }

    let recipient = await User.findOne({ telegramId: String(targetId) });
    if (!recipient) recipient = new User({ telegramId: String(targetId) });

    if (recipient.isBanned) {
      return res.status(400).json({ success: false, message: 'المستلم محظور' });
    }

    sender[transferType] -= transferAmount;
    recipient[transferType] = (recipient[transferType] || 0) + transferAmount;

    await sender.save();
    await recipient.save();

    res.json({ success: true, message: 'تم التحويل بنجاح', sender: publicUser(sender) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في عملية التحويل' });
  }
};

app.post('/api/user/transfer', handleTransfer);
app.post('/api/transfer', handleTransfer);
app.post('/api/wallet/transfer', handleTransfer);

app.post('/api/wallet/deposit', async (req, res) => {
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
      txId: txId || `DEP-${crypto.randomInt(100000, 1000000)}`,
      userId: String(userId),
      type: 'إيداع',
      amount: Number(amount),
      method: (method || 'BINANCE').toUpperCase(),
      details: `TxID: ${txId || 'N/A'}`,
      status: 'pending'
    });

    await newTx.save();
    res.json({ success: true, message: 'تم استلام طلب الإيداع وهو قيد المراجعة' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في إرسال طلب الإيداع' });
  }
});

app.post('/api/admin/deposit-notify', async (req, res) => {
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

app.post('/api/admin/withdraw-notify', async (req, res) => {
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

app.post('/api/wallet/withdraw', async (req, res) => {
  try {
    const { userId, amount, method, details } = req.body;

    if (!userId || !isValidPositiveNumber(amount) || Number(amount) < 10) {
      return res.status(400).json({ success: false, message: 'الحد الأدنى للسحب هو 10$' });
    }

    const user = await User.findOne({ telegramId: String(userId) });

    if (!user || user.isBanned || user.balance < Number(amount)) {
      return res.status(400).json({ success: false, message: 'الرصيد غير كافٍ أو الحساب محظور' });
    }

    const newTx = new Transaction({
      txId: `WIT-${crypto.randomInt(100000, 1000000)}`,
      userId: String(userId),
      type: 'سحب',
      amount: Number(amount),
      method: (method || 'BANK').toUpperCase(),
      details: details || 'طلب سحب',
      status: 'pending'
    });

    await newTx.save();
    res.json({ success: true, message: 'تم إرسال طلب السحب بنجاح للمراجعة' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في عملية السحب' });
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

    user[rewardType] = (user[rewardType] || 0) + reward;
    await user.save();

    res.json({
      success: true,
      [responseKey]: reward,
      reward,
      user: publicUser(user),
      message: `تم تفعيل الكود بنجاح! حصلت على ${reward}`
    });
  } catch (err) {
    console.error('redeem promo error:', err);
    res.status(500).json({ success: false, message: 'خطأ في تفعيل الرمز' });
  }
}

app.post('/api/promo/redeem', (req, res) => redeemPromo(req, res, 'reward'));
app.post('/api/promo/apply', (req, res) => redeemPromo(req, res, 'goldReward'));

app.post('/api/promo/create', async (req, res) => {
  try {
    const { userId, code, maxUses, goldRewardPerPerson } = req.body;

    if (!userId || !code) {
      return res.status(400).json({ success: false, message: 'بيانات غير صالحة' });
    }

    const user = await User.findOne({ telegramId: String(userId) });
    if (!user || user.isBanned) {
      return res.status(403).json({ success: false, message: 'حساب محظور أو غير موجود' });
    }

    const cleanCode = String(code).trim().toUpperCase();
    if (await Promo.findOne({ code: cleanCode })) {
      return res.status(400).json({ success: false, message: 'هذا الكود موجود مسبقاً' });
    }

    await new Promo({
      code: cleanCode,
      amount: Number(goldRewardPerPerson || 1000),
      type: 'gold',
      maxUses: Number(maxUses || 5)
    }).save();

    res.json({ success: true, message: 'تم إنشاء الكود بنجاح' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'فشل إنشاء الرمز' });
  }
});

// --------------------------------------------------
// 5. المهام
// --------------------------------------------------

app.get('/api/tasks', async (req, res) => {
  try {
    const tasks = await Task.find({ status: { $ne: 'مكتملة' } }).sort({ createdAt: -1 });
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: 'خطأ في جلب المهام' });
  }
});

app.get('/api/tasks/list', async (req, res) => {
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
        rewardGold: 1000,
        completedBy: t.completedBy
      }))
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'خطأ في جلب المهام' });
  }
});

app.post('/api/tasks', async (req, res) => {
  try {
    const { title, platform, link, target, cost, creatorId } = req.body;

    const newTask = new Task({
      title,
      platform,
      link,
      target: target || 50,
      cost: cost || '1',
      creatorId
    });

    await newTask.save();
    res.status(201).json({ message: 'تم إنشاء المهمة بنجاح', task: newTask });
  } catch (err) {
    res.status(500).json({ error: 'فشل إنشاء المهمة' });
  }
});

app.post('/api/tasks/create', async (req, res) => {
  try {
    const { userId, title, platform, link, targetUsers, cost } = req.body;

    if (!userId || !title || !link) {
      return res.status(400).json({ success: false, message: 'بيانات غير صالحة' });
    }

    const user = await User.findOne({ telegramId: String(userId) });
    if (!user || user.isBanned) {
      return res.status(403).json({ success: false, message: 'حساب محظور أو غير موجود' });
    }

    const totalCost = Number(cost) || 1;
    if (totalCost <= 0 || user.balance < totalCost) {
      return res.status(400).json({ success: false, message: 'رصيد USD غير كافٍ لإنشاء المهمة' });
    }

    user.balance -= totalCost;
    await user.save();

    const newTask = new Task({
      title,
      platform: platform || 'Telegram',
      link,
      target: Number(targetUsers) || 50,
      cost: String(totalCost),
      creatorId: String(userId)
    });

    await newTask.save();
    res.json({ success: true, message: 'تم إنشاء المهمة بنجاح', task: newTask });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في إنشاء المهمة' });
  }
});

app.post('/api/tasks/complete', async (req, res) => {
  try {
    const { userId, taskId, wasVisited } = req.body;

    if (!userId || !taskId) {
      return res.status(400).json({ success: false, message: 'بيانات غير صالحة' });
    }

    if (!wasVisited) {
      return res.status(400).json({
        success: false,
        message: 'يجب الضغط على ابدأ التنفيذ وزيارة الرابط أولاً قبل استلام المكافأة'
      });
    }

    const user = await User.findOne({ telegramId: String(userId) });
    if (!user || user.isBanned) {
      return res.status(403).json({ success: false, message: 'حساب محظور أو غير موجود' });
    }

    const task = await Task.findById(taskId);
    if (!task) return res.status(404).json({ success: false, message: 'المهمة غير موجودة' });

    if (task.completedBy.includes(String(userId))) {
      return res.status(400).json({ success: false, message: 'لقد أتممت هذه المهمة مسبقاً' });
    }

    // تحديث شرطي يمنع إتمام المهمة نفسها مرتين من طلبين متزامنين.
    const updatedTask = await Task.findOneAndUpdate(
      { _id: task._id, completedBy: { $ne: String(userId) }, status: { $ne: 'مكتملة' } },
      {
        $addToSet: { completedBy: String(userId) },
        $inc: { current: 1 }
      },
      { new: true }
    );

    if (!updatedTask) {
      return res.status(400).json({ success: false, message: 'المهمة مكتملة أو سبق لك إتمامها' });
    }

    if (updatedTask.current >= updatedTask.target) {
      updatedTask.status = 'مكتملة';
      await updatedTask.save();
    }

    user.gold = (user.gold || 0) + 1000;
    await user.save();

    res.json({
      success: true,
      rewardGold: 1000,
      message: 'تم إتمام المهمة بنجاح! حصلت على 1000 ذهبة',
      user: publicUser(user)
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
  }
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

    const user = await User.findOne({ telegramId: userId });
    if (!user) return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
    if (user.isBanned) return res.status(403).json({ success: false, message: 'حساب محظور' });

    const round = await ensurePublicRocketRound();
    if (round.status !== 'betting' || Date.now() >= new Date(round.bettingEndsAt).getTime()) {
      return res.status(409).json({ success: false, message: 'بدأ صعود الصاروخ؛ انتظر الجولة التالية', roundId: round.roundId });
    }
    if (await RocketBet.findOne({ roundId: round.roundId, userId, betSlot })) {
      return res.status(409).json({ success: false, message: 'وضعت رهانًا بالفعل في هذه الخانة لهذه الجولة' });
    }

    const updatedUser = await User.findOneAndUpdate(
      { telegramId: userId, isBanned: false, gold: { $gte: betAmount } },
      { $inc: { gold: -betAmount } },
      { new: true }
    );
    if (!updatedUser) return res.status(400).json({ success: false, message: 'رصيدك من الذهب غير كافٍ' });

    let bet;
    try {
      bet = await new RocketBet({ roundId: round.roundId, userId, betSlot, betAmount, status: 'active' }).save();
    } catch (err) {
      await User.updateOne({ telegramId: userId }, { $inc: { gold: betAmount } });
      if (err.code === 11000) return res.status(409).json({ success: false, message: 'وضعت رهانًا بالفعل في هذه الخانة لهذه الجولة' });
      throw err;
    }

    const payload = await rocketRoundPayload(round, userId);
    return res.status(201).json({
      success: true, message: 'تم تسجيل رهانك في الجولة المشتركة', balance: updatedUser.gold,
      round: payload.round, bets: payload.bets, bet: {
        betId: String(bet._id), roundId: bet.roundId, betSlot: bet.betSlot, betAmount: bet.betAmount, status: bet.status
      }
    });
  } catch (err) {
    console.error('rocket start error:', err);
    return res.status(500).json({ success: false, message: 'تعذر تسجيل رهان الصاروخ' });
  }
});

app.post('/api/games/rocket/cashout', rocketAuth, async (req, res) => {
  try {
    const userId = req.telegramUser.id;
    const { roundId, betId, betSlot } = req.body;
    if (!roundId || typeof roundId !== 'string') {
      return res.status(400).json({ success: false, message: 'معرف الجولة غير صالح' });
    }

    const round = await PublicRocketRound.findOne({ roundId });
    if (!round) return res.status(404).json({ success: false, message: 'الجولة غير موجودة' });
    await ensurePublicRocketRound();
    const now = new Date();
    if (round.status !== 'running' || !round.crashAt || now >= round.crashAt) {
      return res.status(409).json({ success: false, crashed: true, message: 'انفجر الصاروخ أو انتهت الجولة قبل السحب', crashMultiplier: round.status === 'crashed' ? round.crashMultiplier : undefined });
    }

    const filter = { roundId, userId, status: 'active' };
    if (betId) filter._id = betId;
    else if (betSlot != null) filter.betSlot = Number(betSlot);
    const bet = await RocketBet.findOne(filter);
    if (!bet) return res.status(404).json({ success: false, message: 'لا يوجد رهان نشط لك في هذه الخانة' });

    const multiplier = Math.min(calculateMultiplier(round.startedAt, now.getTime()), round.crashMultiplier);
    const wonAmount = Math.floor(bet.betAmount * multiplier);
    const claimedBet = await RocketBet.findOneAndUpdate(
      { _id: bet._id, status: 'active' },
      { $set: { status: 'cashed_out', cashOutMultiplier: multiplier, wonAmount, cashedOutAt: now } },
      { new: true }
    );
    if (!claimedBet) return res.status(409).json({ success: false, message: 'تمت تسوية هذا الرهان مسبقًا' });

    const updatedUser = await User.findOneAndUpdate(
      { telegramId: userId, isBanned: false },
      { $inc: { gold: wonAmount } },
      { new: true }
    );
    if (!updatedUser) {
      console.error('CRITICAL: rocket bet cashed out but balance update failed', bet._id);
      return res.status(500).json({ success: false, message: 'سُجل السحب لكن تعذر تحديث الرصيد؛ تواصل مع الدعم' });
    }

    const payload = await rocketRoundPayload(round, userId);
    return res.json({
      success: true, message: `نجح السحب عند ${multiplier}x`, roundId,
      betId: String(claimedBet._id), betSlot: claimedBet.betSlot,
      cashOutMultiplier: multiplier, wonAmount, balance: updatedUser.gold,
      roundStatus: 'cashed_out', round: payload.round, bets: payload.bets
    });
  } catch (err) {
    console.error('rocket cashout error:', err);
    return res.status(500).json({ success: false, message: 'تعذر تنفيذ السحب' });
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

app.get('/api/admin/dashboard', async (req, res) => {
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

app.post('/api/admin/process-transaction', async (req, res) => {
  try {
    const { adminId, txId, action } = req.body;

    if (String(adminId) !== ADMIN_ID) {
      return res.status(403).json({ success: false, message: 'غير مصرح' });
    }

    if (!['accept', 'reject'].includes(action)) {
      return res.status(400).json({ success: false, message: 'الإجراء غير صالح' });
    }

    const tx = await Transaction.findOne({ txId });
    if (!tx) return res.status(404).json({ success: false, message: 'المعاملة غير موجودة' });
    if (tx.status !== 'pending') {
      return res.status(409).json({ success: false, message: 'تمت معالجة المعاملة مسبقًا' });
    }

    const updatedTx = await Transaction.findOneAndUpdate(
      { _id: tx._id, status: 'pending' },
      { $set: { status: action === 'accept' ? 'approved' : 'rejected' } },
      { new: true }
    );

    if (!updatedTx) {
      return res.status(409).json({ success: false, message: 'تمت معالجة المعاملة مسبقًا' });
    }

    if (action === 'accept' && tx.type === 'إيداع') {
      await User.updateOne(
        { telegramId: tx.userId },
        { $inc: { balance: tx.amount } }
      );
    }

    res.json({
      success: true,
      message: `تم ${action === 'accept' ? 'قبول' : 'رفض'} المعاملة بنجاح`
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في معالجة المعاملة' });
  }
});

app.get('/api/admin/rocket', async (req, res) => {
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

app.post('/api/admin/update-rocket', async (req, res) => {
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

app.post('/api/admin/user-ban', async (req, res) => {
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

app.post('/api/admin/modify-balance', async (req, res) => {
  try {
    const { adminId, targetUserId, amount, type, action } = req.body;

    if (String(adminId) !== ADMIN_ID) {
      return res.status(403).json({ success: false, message: 'غير مصرح' });
    }

    const value = Number(amount);
    if (!targetUserId || !Number.isFinite(value) || value < 0) {
      return res.status(400).json({ success: false, message: 'بيانات غير صالحة' });
    }

    let user = await User.findOne({ telegramId: String(targetUserId) });
    if (!user) user = new User({ telegramId: String(targetUserId) });

    let balanceType = type || 'gold';
    if (balanceType === 'usd') balanceType = 'balance';

    if (!['gold', 'diamonds', 'balance'].includes(balanceType)) {
      return res.status(400).json({ success: false, message: 'نوع الرصيد غير صالح' });
    }

    if (action === 'add') {
      user[balanceType] = (user[balanceType] || 0) + value;
    } else if (action === 'subtract') {
      user[balanceType] = Math.max(0, (user[balanceType] || 0) - value);
    } else {
      return res.status(400).json({ success: false, message: 'الإجراء غير صالح' });
    }

    await user.save();
    res.json({ success: true, message: 'تم تعديل الرصيد بنجاح', user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في تعديل رصيد المستخدم' });
  }
});

app.post('/api/admin/delete-task', async (req, res) => {
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

app.post('/api/admin/create-promo', async (req, res) => {
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

app.post('/api/admin/delete-promo', async (req, res) => {
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
// تشغيل السيرفر
// --------------------------------------------------

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 السيرفر يعمل على المنفذ ${PORT}`);

  if (!TELEGRAM_BOT_TOKEN) {
    console.warn('⚠️ TELEGRAM_BOT_TOKEN غير مضبوط في Railway؛ ستُرفض طلبات الصاروخ بـ 401 حتى تضيف رمز البوت الصحيح من BotFather.');
  }
});
