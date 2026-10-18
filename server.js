const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();

// إعدادات الأمان والتواصل مع الواجهة الأمامية (Netlify)
app.use(cors());
app.use(express.json());

// الاتصال بقاعدة بيانات MongoDB Atlas
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://mohamedfoutani10k_db_user:dakos2004@moneybuxdb.q4kojcz.mongodb.net/?retryWrites=true&w=majority';

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ تم الاتصال بقاعدة بيانات MongoDB Atlas بنجاح'))
  .catch((err) => console.error('❌ خطأ في الاتصال بقاعدة البيانات:', err));

// --- النماذج (Schemas) ---

// 1. نموذج المستخدم
const userSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true },
  name: { type: String, default: 'زائر كريم' },
  gold: { type: Number, default: 1000 },
  diamonds: { type: Number, default: 10 },
  balance: { type: Number, default: 0 },
  referralCount: { type: Number, default: 0 },
  lastWheelSpin: { type: Date },
  wheelSpinsLeft: { type: Number, default: 3 },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// 2. نموذج المهام
const taskSchema = new mongoose.Schema({
  title: { type: String, required: true },
  platform: { type: String, required: true },
  link: { type: String, required: true },
  current: { type: Number, default: 0 },
  target: { type: Number, required: true },
  cost: { type: String, required: true },
  creatorId: { type: String, required: true },
  status: { type: String, default: 'جارٍ التنفيذ' },
  createdAt: { type: Date, default: Date.now }
});
const Task = mongoose.model('Task', taskSchema);

// 3. نموذج الرموز الترويجية (Promo Codes)
const promoSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  amount: { type: Number, required: true },
  type: { type: String, required: true }, // gold, diamonds, balance
  maxUses: { type: Number, default: 100 },
  usedCount: { type: Number, default: 0 },
  usedBy: [{ type: String }],
  createdAt: { type: Date, default: Date.now }
});
const Promo = mongoose.model('Promo', promoSchema);


// --- المسارات (API Routes) ---

// 1. اختبار السيرفر
app.get('/', (req, res) => {
  res.send('Money Bux Backend Server is Running! 🚀');
});

// 2. جلب بروفايل المستخدم
app.get('/api/user/profile', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ success: false, message: 'Missing userId' });

    let user = await User.findOne({ telegramId: userId });
    if (!user) {
      user = new User({ telegramId: userId, gold: 1000, diamonds: 10, balance: 0 });
      await user.save();
    }
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, error: 'خطأ في جلب بيانات المستخدم' });
  }
});

// 3. مسار تفعيل الرمز الترويجي (Promo Code Redeem) - لحل مشكلة الخطأ الأخيرة
app.post('/api/promo/redeem', async (req, res) => {
  try {
    const { userId, code } = req.body;
    if (!userId || !code) {
      return res.status(400).json({ success: false, message: 'الرجاء إدخال الرمز' });
    }

    let promo = await Promo.findOne({ code: code.trim() });
    if (!promo) {
      return res.status(400).json({ success: false, message: 'الرمز الترويجي غير صحيح' });
    }

    if (promo.usedBy && promo.usedBy.includes(userId)) {
      return res.status(400).json({ success: false, message: 'لقد قمت باستخدام هذا الرمز مسبقاً' });
    }

    if (promo.usedCount >= promo.maxUses) {
      return res.status(400).json({ success: false, message: 'لقد انتهت صلاحية هذا الرمز' });
    }

    let user = await User.findOne({ telegramId: userId });
    if (!user) {
      user = new User({ telegramId: userId });
    }

    const rewardType = promo.type || 'gold';
    user[rewardType] = (user[rewardType] || 0) + promo.amount;
    
    promo.usedCount += 1;
    promo.usedBy.push(userId);

    await user.save();
    await promo.save();

    res.json({ success: true, message: `تم تفعيل الرمز بنجاح! حصلت على ${promo.amount} من ${rewardType}`, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر أثناء تفعيل الرمز' });
  }
});

// 4. مسار تسجيل الإحالات (Referrals)
app.post('/api/user/referral', async (req, res) => {
  try {
    const { userId, referrerId } = req.body;
    if (!userId || !referrerId || userId === referrerId) {
      return res.status(400).json({ success: false, message: 'بيانات الإحالة غير صالحة' });
    }

    let referrer = await User.findOne({ telegramId: referrerId });
    if (referrer) {
      referrer.referralCount = (referrer.referralCount || 0) + 1;
      referrer.gold = (referrer.gold || 0) + 100;
      await referrer.save();
    }

    res.json({ success: true, message: 'تم احتساب الإحالة بنجاح' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'خطأ في تسجيل الإحالة' });
  }
});

// 5. مسارات الألعاب وعجلة الحظ (Wheel / Games)
app.post('/api/wheel/spin', async (req, res) => {
  try {
    const telegramId = req.body.userId || req.body.telegramId;
    
    if (!telegramId) return res.status(400).json({ success: false, message: 'Missing userId' });

    let user = await User.findOne({ telegramId });
    if (!user) {
      user = new User({ telegramId });
    }

    const rewards = [
      { type: 'gold', amount: 50 },
      { type: 'gold', amount: 100 },
      { type: 'diamonds', amount: 2 },
      { type: 'balance', amount: 1 }
    ];
    const won = rewards[Math.floor(Math.random() * rewards.length)];

    user[won.type] = (user[won.type] || 0) + won.amount;
    await user.save();

    res.json({
      success: true,
      message: `مبروك! لقد ربحت ${won.amount} من ${won.type}`,
      reward: won,
      user
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'خطأ في تشغيل عجلة الحظ' });
  }
});

// 6. مسار صالة التداول (Trading)
app.post('/api/trading/trade', async (req, res) => {
  try {
    const { userId, amount } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: 'Missing userId' });

    let user = await User.findOne({ telegramId: userId });
    if (!user) return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });

    const tradeAmount = Number(amount) || 10;
    if (user.gold < tradeAmount) {
      return res.status(400).json({ success: false, message: 'رصيدك من الذهب لا يكفي للتداول' });
    }

    const isWin = Math.random() >= 0.5;
    if (isWin) {
      user.gold += tradeAmount * 0.5;
      await user.save();
      return res.json({ success: true, message: 'صفقة ناجحة! ربحت أرباح إضافية', user, profit: tradeAmount * 0.5 });
    } else {
      user.gold -= tradeAmount;
      await user.save();
      return res.json({ success: true, message: 'للأسف خسرت الصفقة', user, loss: tradeAmount });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'خطأ في تنفيذ عملية التداول' });
  }
});

// 7. مسار تحويل الرصيد (Transfer)
app.post('/api/user/transfer', async (req, res) => {
  try {
    const { userId, recipientId, amount, type } = req.body;
    if (!userId || !recipientId || !amount) {
      return res.status(400).json({ success: false, message: 'بيانات التحويل غير مكتملة' });
    }

    let sender = await User.findOne({ telegramId: userId });
    let recipient = await User.findOne({ telegramId: recipientId });

    if (!sender || sender[type] < Number(amount)) {
      return res.status(400).json({ success: false, message: 'رصيدك غير كافي للتحويل' });
    }

    if (!recipient) {
      recipient = new User({ telegramId: recipientId });
    }

    sender[type] -= Number(amount);
    recipient[type] = (recipient[type] || 0) + Number(amount);

    await sender.save();
    await recipient.save();

    res.json({ success: true, message: 'تم التحويل بنجاح', sender });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'خطأ في عملية التحويل' });
  }
});

// 8. مسارات الأدمين (Admin Endpoints)
const ADMIN_ID = "6669520092";

app.get('/api/admin/stats', async (req, res) => {
  try {
    const { adminId } = req.query;
    if (String(adminId) !== ADMIN_ID) {
      return res.status(403).json({ success: false, message: 'غير مصرح لك بالدخول' });
    }

    const totalUsers = await User.countDocuments();
    res.json({
      success: true,
      stats: {
        totalUsers: totalUsers,
        activeToday: totalUsers
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في جلب الإحصائيات' });
  }
});

app.post('/api/admin/modify-balance', async (req, res) => {
  try {
    const { adminId, targetUserId, amount, type, action } = req.body;

    if (String(adminId) !== ADMIN_ID) {
      return res.status(403).json({ success: false, message: 'غير مصرح لك بالقيام بهذا الاجراء' });
    }

    let user = await User.findOne({ telegramId: targetUserId });
    if (!user) {
      user = new User({ telegramId: targetUserId });
    }

    const value = Number(amount);
    if (action === 'add') {
      user[type] = (user[type] || 0) + value;
    } else if (action === 'subtract') {
      user[type] = Math.max(0, (user[type] || 0) - value);
    }

    await user.save();
    res.json({ success: true, message: 'تم تعديل الرصيد بنجاح' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر أثناء تعديل الرصيد' });
  }
});

app.post('/api/admin/create-promo', async (req, res) => {
  try {
    const { adminId, code, amount, type, maxUses } = req.body;

    if (String(adminId) !== ADMIN_ID) {
      return res.status(403).json({ success: false, message: 'غير مصرح لك' });
    }

    const existingPromo = await Promo.findOne({ code });
    if (existingPromo) {
      return res.status(400).json({ success: false, message: 'هذا الكود موجود مسبقاً' });
    }

    const newPromo = new Promo({
      code,
      amount,
      type,
      maxUses: maxUses || 100
    });

    await newPromo.save();
    res.json({ success: true, message: 'تم إنشاء الكود بنجاح' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'فشل إنشاء الكود' });
  }
});

// --- مسارات المهام ---
app.get('/api/tasks', async (req, res) => {
  try {
    const tasks = await Task.find().sort({ createdAt: -1 });
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: 'خطأ في جلب المهام' });
  }
});

app.post('/api/tasks', async (req, res) => {
  try {
    const { title, platform, link, target, cost, creatorId } = req.body;
    const newTask = new Task({ title, platform, link, target, cost, creatorId });
    await newTask.save();
    res.status(201).json({ message: 'تم إنشاء المهمة بنجاح', task: newTask });
  } catch (err) {
    res.status(500).json({ error: 'فشل إنشاء المهمة' });
  }
});

// تشغيل السيرفر
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 السيرفر يعمل على المنفذ ${PORT}`);
});
