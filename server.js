const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://mohamedfoutani10k_db_user:dakos2004@moneybuxdb.q4kojcz.mongodb.net/?retryWrites=true&w=majority';

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ تم الاتصال بقاعدة بيانات MongoDB Atlas بنجاح'))
  .catch((err) => console.error('❌ خطأ في الاتصال بقاعدة البيانات:', err));

// --- النماذج (Schemas) ---
const userSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true },
  name: { type: String, default: 'زائر كريم' },
  gold: { type: Number, default: 1000 },
  diamonds: { type: Number, default: 10 },
  balance: { type: Number, default: 0 }, // Gram (TON)
  referralCount: { type: Number, default: 0 },
  wheelSpinsLeft: { type: Number, default: 3 },
  lastWheelSpinDate: { type: String }, // لتجديد المحاولات يومياً
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const taskSchema = new mongoose.Schema({
  title: { type: String, required: true },
  platform: { type: String, required: true },
  link: { type: String, required: true },
  current: { type: Number, default: 0 },
  target: { type: Number, required: true },
  cost: { type: String, required: true }, // قيمة المكافأة للمهمة (مثلاً ذهب أو ألماس)
  creatorId: { type: String, required: true },
  completedBy: [{ type: String }], // تتبع المستخدمين الذين أكملوا المهمة
  status: { type: String, default: 'جارٍ التنفيذ' },
  createdAt: { type: Date, default: Date.now }
});
const Task = mongoose.model('Task', taskSchema);

const promoSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  amount: { type: Number, required: true },
  type: { type: String, required: true },
  maxUses: { type: Number, default: 100 },
  usedCount: { type: Number, default: 0 },
  usedBy: [{ type: String }],
  diamondsPerUser: { type: Number },
  createdAt: { type: Date, default: Date.now }
});
const Promo = mongoose.model('Promo', promoSchema);


// --- المسارات (API Routes) ---

app.get('/', (req, res) => {
  res.send('Money Bux Backend Server is Running! 🚀');
});

// 1. بروفايل المستخدم
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

// 2. حالة العجلة والألعاب (مع التجديد التلقائي للمحاولات يومياً - الخطوة 3)
app.get('/api/games/status', async (req, res) => {
  try {
    const { userId } = req.query;
    let user = await User.findOne({ telegramId: userId });
    if (!user && userId) {
      user = new User({ telegramId: userId });
      await user.save();
    }

    if (user) {
      const todayStr = new Date().toISOString().split('T')[0]; // تاريخ اليوم YYYY-MM-DD
      if (user.lastWheelSpinDate !== todayStr) {
        user.wheelSpinsLeft = 3; // تجديد المحاولات إلى 3 يومياً
        user.lastWheelSpinDate = todayStr;
        await user.save();
      }
    }

    res.json({ success: true, spinsLeft: user ? user.wheelSpinsLeft : 3 });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في جلب حالة الألعاب' });
  }
});

// 3. تدوير العجلة
const handleSpin = async (req, res) => {
  try {
    const telegramId = req.body.userId || req.body.telegramId || req.query.userId;
    if (!telegramId) return res.status(400).json({ success: false, message: 'Missing userId' });

    let user = await User.findOne({ telegramId });
    if (!user) user = new User({ telegramId });

    // التحقق من تاريخ اليوم لتجديد المحاولات تلقائياً
    const todayStr = new Date().toISOString().split('T')[0];
    if (user.lastWheelSpinDate !== todayStr) {
      user.wheelSpinsLeft = 3;
      user.lastWheelSpinDate = todayStr;
    }

    if (user.wheelSpinsLeft <= 0) {
      return res.status(400).json({ success: false, message: 'انتهت محاولات اليوم!' });
    }

    user.wheelSpinsLeft -= 1;

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
      message: `مبروك! ربحت ${won.amount} ${won.type}`,
      reward: won,
      user,
      spinsLeft: user.wheelSpinsLeft
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في تشغيل العجلة' });
  }
};

app.post('/api/games/spin', handleSpin);
app.post('/api/wheel/spin', handleSpin);

// 4. الإحالات
app.get('/api/referrals/stats', async (req, res) => {
  try {
    const { userId } = req.query;
    let user = await User.findOne({ telegramId: userId });
    res.json({ success: true, referralCount: user ? user.referralCount : 0, referrals: [] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ' });
  }
});

app.post('/api/user/referral', async (req, res) => {
  try {
    const { userId, referrerId } = req.body;
    if (!userId || !referrerId || userId === referrerId) {
      return res.status(400).json({ success: false, message: 'خطأ' });
    }
    let referrer = await User.findOne({ telegramId: referrerId });
    if (referrer) {
      referrer.referralCount = (referrer.referralCount || 0) + 1;
      referrer.gold = (referrer.gold || 0) + 100;
      await referrer.save();
    }
    res.json({ success: true, message: 'تم' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ' });
  }
});

// 5. تبادل العملات الداخلية
app.post('/api/wallet/exchange', async (req, res) => {
  try {
    const { userId, type, amount } = req.body;
    let user = await User.findOne({ telegramId: userId });
    if (!user) return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });

    const val = Number(amount);
    if (type === 'diamonds_to_gram') {
      if (user.diamonds < val) return res.status(400).json({ success: false, message: 'رصيد الألماس غير كافٍ' });
      user.diamonds -= val;
      user.balance = (user.balance || 0) + (val / 500);
    } else if (type === 'gold_to_diamonds') {
      if (user.gold < val) return res.status(400).json({ success: false, message: 'رصيد الذهب غير كافٍ' });
      user.gold -= val;
      user.diamonds = (user.diamonds || 0) + Math.floor(val / 200);
    }

    await user.save();
    res.json({ success: true, message: 'تم التحويل بنجاح', user });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في التحويل' });
  }
});

// 6. التحويل بين المستخدمين
const handleTransfer = async (req, res) => {
  try {
    const { userId, recipientId, amount, type } = req.body;
    let sender = await User.findOne({ telegramId: userId });
    if (!sender) return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });

    const transferAmount = Number(amount);
    const transferType = type || 'gold';

    if (sender[transferType] < transferAmount) {
      return res.status(400).json({ success: false, message: 'رصيدك غير كافي' });
    }

    const targetId = recipientId || req.body.toUserId;
    if (!targetId || targetId === userId) {
      return res.status(400).json({ success: false, message: 'معرف المستلم غير صالح' });
    }

    let recipient = await User.findOne({ telegramId: targetId });
    if (!recipient) recipient = new User({ telegramId: targetId });

    sender[transferType] -= transferAmount;
    recipient[transferType] = (recipient[transferType] || 0) + transferAmount;

    await sender.save();
    await recipient.save();

    res.json({ success: true, message: 'تم التحويل بنجاح', sender });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في عملية التحويل' });
  }
};

app.post('/api/user/transfer', handleTransfer);
app.post('/api/transfer', handleTransfer);
app.post('/api/wallet/transfer', handleTransfer);

// 7. الإيداع والسحب
app.post('/api/wallet/deposit', async (req, res) => {
  try {
    const { userId, amount } = req.body;
    let user = await User.findOne({ telegramId: userId });
    if (!user) user = new User({ telegramId: userId });
    user.balance = (user.balance || 0) + Number(amount);
    await user.save();
    res.json({ success: true, message: 'تم الإيداع', user });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ' });
  }
});

app.post('/api/wallet/withdraw', async (req, res) => {
  try {
    const { userId, amount } = req.body;
    let user = await User.findOne({ telegramId: userId });
    if (!user || user.balance < Number(amount)) {
      return res.status(400).json({ success: false, message: 'الرصيد غير كافٍ' });
    }
    user.balance -= Number(amount);
    await user.save();
    res.json({ success: true, message: 'تم السحب', user });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ' });
  }
});

// 8. الرموز الترويجية
app.post('/api/promo/redeem', async (req, res) => {
  try {
    const { userId, code } = req.body;
    if (!code) return res.status(400).json({ success: false, message: 'الرجاء إدخال الرمز' });

    let promo = await Promo.findOne({ code: code.trim().toUpperCase() });
    if (!promo) return res.status(400).json({ success: false, message: 'الرمز غير صحيح' });

    if (promo.usedBy && promo.usedBy.includes(userId)) {
      return res.status(400).json({ success: false, message: 'استخدمت هذا الرمز مسبقاً' });
    }

    if (promo.usedCount >= promo.maxUses) {
      return res.status(400).json({ success: false, message: 'انتهت صلاحية الرمز' });
    }

    let user = await User.findOne({ telegramId: userId });
    if (!user) user = new User({ telegramId: userId });

    const reward = promo.diamondsPerUser || promo.amount;
    user[promo.type] = (user[promo.type] || 0) + reward;

    promo.usedCount += 1;
    promo.usedBy.push(userId);

    await user.save();
    await promo.save();

    res.json({ success: true, rewardDiamonds: reward, user });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في تفعيل الرمز' });
  }
});

const ADMIN_ID = "6669520092";

const handleCreatePromo = async (req, res) => {
  try {
    const { adminId, userId, code, amount, type, maxUses, totalDiamonds, totalUsers, diamondsPerUser } = req.body;
    if (adminId && String(adminId) !== ADMIN_ID) {
      return res.status(403).json({ success: false, message: 'غير مصرح لك' });
    }

    if (!code) return res.status(400).json({ success: false, message: 'يرجى إدخال اسم الرمز' });

    const cleanCode = code.trim().toUpperCase();
    const existingPromo = await Promo.findOne({ code: cleanCode });
    if (existingPromo) return res.status(400).json({ success: false, message: 'هذا الكود موجود مسبقاً' });

    const promoAmount = amount || diamondsPerUser || 10;
    const promoType = type || 'diamonds';
    const uses = maxUses || totalUsers || 10;

    const newPromo = new Promo({
      code: cleanCode,
      amount: Number(promoAmount),
      type: promoType,
      maxUses: Number(uses),
      diamondsPerUser: Number(promoAmount)
    });

    await newPromo.save();
    res.json({ success: true, message: 'تم إنشاء الكود بنجاح' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'فشل إنشاء الرمز' });
  }
};

app.post('/api/admin/create-promo', handleCreatePromo);
app.post('/api/promo/create', handleCreatePromo);

// 9. مسارات المهام وإتمامها (الخطوة 1 الجديدة)
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

// مسار إتمام المهمة ومنح المكافأة للمستخدم
app.post('/api/tasks/complete', async (req, res) => {
  try {
    const { userId, taskId } = req.body;
    if (!userId || !taskId) {
      return res.status(400).json({ success: false, message: 'بيانات غير مكتملة' });
    }

    let task = await Task.findById(taskId);
    if (!task) {
      return res.status(404).json({ success: false, message: 'المهمة غير موجودة' });
    }

    if (task.completedBy && task.completedBy.includes(userId)) {
      return res.status(400).json({ success: false, message: 'لقد أكملت هذه المهمة مسبقاً!' });
    }

    let user = await User.findOne({ telegramId: userId });
    if (!user) user = new User({ telegramId: userId });

    // تحديد نوع المكافأة وقيمتها من حقل cost (مثلاً: "50 gold" أو افتراضياً ذهب)
    let rewardType = 'gold';
    let rewardAmount = Number(task.cost) || 50;
    
    if (task.cost && task.cost.includes('diamond')) rewardType = 'diamonds';

    user[rewardType] = (user[rewardType] || 0) + rewardAmount;
    task.current = (task.current || 0) + 1;
    task.completedBy.push(userId);

    if (task.current >= task.target) {
      task.status = 'مكتملة';
    }

    await user.save();
    await task.save();

    res.json({ 
      success: true, 
      message: `تم إتمام المهمة بنجاح! حصلت على ${rewardAmount} ${rewardType}`, 
      user 
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر أثناء إتمام المهمة' });
  }
});

// 10. أدوات لوحة تحكم الأدمين
app.get('/api/admin/stats', async (req, res) => {
  try {
    const { adminId } = req.query;
    if (String(adminId) !== ADMIN_ID) return res.status(403).json({ success: false, message: 'غير مصرح' });
    const totalUsers = await User.countDocuments();
    res.json({ success: true, stats: { totalUsers, activeToday: totalUsers } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ' });
  }
});

app.post('/api/admin/modify-balance', async (req, res) => {
  try {
    const { adminId, targetUserId, amount, type, action } = req.body;
    if (String(adminId) !== ADMIN_ID) return res.status(403).json({ success: false, message: 'غير مصرح' });

    let user = await User.findOne({ telegramId: targetUserId });
    if (!user) user = new User({ telegramId: targetUserId });

    const value = Number(amount);
    if (action === 'add') user[type] = (user[type] || 0) + value;
    else if (action === 'subtract') user[type] = Math.max(0, (user[type] || 0) - value);

    await user.save();
    res.json({ success: true, message: 'تم التعديل' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 السيرفر يعمل على المنفذ ${PORT}`);
});
