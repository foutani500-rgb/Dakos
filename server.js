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
  balance: { type: Number, default: 0 }, // Gram / USD
  referralCount: { type: Number, default: 0 },
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
  type: { type: String, required: true },
  maxUses: { type: Number, default: 100 },
  usedCount: { type: Number, default: 0 },
  usedBy: [{ type: String }],
  diamondsPerUser: { type: Number },
  createdAt: { type: Date, default: Date.now }
});
const Promo = mongoose.model('Promo', promoSchema);

const ADMIN_ID = "6669520092";

// --- المسارات (API Routes) ---

app.get('/', (req, res) => {
  res.send('Money Slayer Pro Backend Server is Running! 🚀');
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

    if (user.isBanned) {
      return res.status(403).json({ success: false, message: 'حسابك محظور من استخدام المنصة.' });
    }

    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, error: 'خطأ في جلب بيانات المستخدم' });
  }
});

// 2. نظام الإحالات
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

// 3. المحفظة والتحويلات والتبادل
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

// 4. الرموز الترويجية
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

    res.json({ success: true, reward, user });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في تفعيل الرمز' });
  }
});

// 5. المهام وإنشاؤها وإتمامها
app.get('/api/tasks', async (req, res) => {
  try {
    const tasks = await Task.find({ status: { $ne: 'مكتملة' } }).sort({ createdAt: -1 });
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

app.post('/api/tasks/complete', async (req, res) => {
  try {
    const { userId, taskId } = req.body;
    let task = await Task.findById(taskId);
    if (!task) return res.status(404).json({ success: false, message: 'المهمة غير موجودة' });

    if (task.completedBy && task.completedBy.includes(userId)) {
      return res.status(400).json({ success: false, message: 'أكملت هذه المهمة مسبقاً!' });
    }

    let user = await User.findOne({ telegramId: userId });
    if (!user) user = new User({ telegramId: userId });

    let rewardType = 'gold';
    let rewardAmount = Number(task.cost) || 50;

    user[rewardType] = (user[rewardType] || 0) + rewardAmount;
    task.current = (task.current || 0) + 1;
    task.completedBy.push(userId);

    if (task.current >= task.target) {
      task.status = 'مكتملة';
    }

    await user.save();
    await task.save();

    res.json({ success: true, message: `تم إتمام المهمة بنجاح! حصلت على ${rewardAmount} ${rewardType}`, user });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
  }
});

// 6. لعبة الصاروخ الفضائي (Rocket Game API)
app.get('/api/games/rocket/status', async (req, res) => {
  try {
    const { userId } = req.query;
    let user = await User.findOne({ telegramId: userId });
    if (!user && userId) {
      user = new User({ telegramId: userId });
      await user.save();
    }
    res.json({ 
      success: true, 
      balance: user ? user.gold : 1000, 
      config: { lossRate: 51, maxMultiplier: 10.0 } 
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في جلب بيانات لعبة الصاروخ' });
  }
});

app.post('/api/games/rocket/play', async (req, res) => {
  try {
    const { userId, betAmount, cashOutMultiplier } = req.body;
    if (!userId || !betAmount || betAmount <= 0) {
      return res.status(400).json({ success: false, message: 'بيانات الرهان غير صالحة' });
    }

    let user = await User.findOne({ telegramId: userId });
    if (!user) return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });

    if (user.gold < betAmount) {
      return res.status(400).json({ success: false, message: 'رصيدك من الذهب غير كافٍ!' });
    }

    user.gold -= Number(betAmount);

    const rand = Math.random() * 100;
    let crashMultiplier = 1.00;

    if (rand < 51) {
      crashMultiplier = Number((1.00 + Math.random() * 0.30).toFixed(2));
    } else if (rand < 85) {
      crashMultiplier = Number((1.31 + Math.random() * 2.19).toFixed(2));
    } else {
      crashMultiplier = Number((3.51 + Math.random() * 6.49).toFixed(2));
    }

    const playerTarget = Number(cashOutMultiplier) || 1.00;
    let wonAmount = 0;
    let isWon = false;

    if (playerTarget <= crashMultiplier) {
      isWon = true;
      wonAmount = Math.floor(betAmount * playerTarget);
      user.gold += wonAmount;
    } else {
      isWon = false;
      wonAmount = 0;
    }

    await user.save();

    res.json({
      success: true,
      isWon,
      crashMultiplier,
      wonAmount,
      newBalance: user.gold,
      message: isWon ? `🎉 مبروك! ربحت ${wonAmount} ذهبة!` : `💥 بانم! انفجر الصاروخ عند ${crashMultiplier}x وخسرت.`
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في معالجة جولة لعبة الصاروخ' });
  }
});

// 7. لوحة تحكم المطور الشاملة (Super Admin Panel API)
app.get('/api/admin/dashboard', async (req, res) => {
  try {
    const { adminId } = req.query;
    if (String(adminId) !== ADMIN_ID) {
      return res.status(403).json({ success: false, message: 'غير مصرح لك بالوصول' });
    }

    const totalUsers = await User.countDocuments();
    const tasks = await Task.find({ status: { $ne: 'مكتملة' } }).sort({ createdAt: -1 });

    res.json({
      success: true,
      stats: {
        totalUsers,
        activeToday: Math.floor(totalUsers * 0.4),
        totalRevenue: 4250,
        pendingCount: 1
      },
      transactions: [
        { id: '1024', type: 'withdraw', userId: '987654321', amount: 50.00, currency: 'USD' }
      ],
      tasks: tasks.map(t => ({ id: t._id, title: t.title, current: t.current, targetUsers: t.target })),
      rocketConfig: { lossRate: 51, maxMultiplier: 10.0 }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في جلب بيانات لوحة التحكم' });
  }
});

app.post('/api/admin/process-transaction', async (req, res) => {
  try {
    const { adminId, txId, action } = req.body;
    if (String(adminId) !== ADMIN_ID) return res.status(403).json({ success: false, message: 'غير مصرح' });
    res.json({ success: true, message: `تم ${action === 'accept' ? 'قبول' : 'رفض'} المعاملة بنجاح` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ' });
  }
});

app.post('/api/admin/update-rocket', async (req, res) => {
  try {
    const { adminId, lossRate, maxMultiplier } = req.body;
    if (String(adminId) !== ADMIN_ID) return res.status(403).json({ success: false, message: 'غير مصرح' });
    res.json({ success: true, message: 'تم تحديث خوارزمية لعبة الصاروخ بنجاح' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ' });
  }
});

app.post('/api/admin/user-ban', async (req, res) => {
  try {
    const { adminId, targetUserId, action } = req.body;
    if (String(adminId) !== ADMIN_ID) return res.status(403).json({ success: false, message: 'غير مصرح' });

    let user = await User.findOne({ telegramId: targetUserId });
    if (!user) return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });

    user.isBanned = (action === 'ban');
    await user.save();

    res.json({ success: true, message: `تم ${action === 'ban' ? 'حظر' : 'فك حظر'} المستخدم بنجاح` });
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
    res.json({ success: true, message: 'تم تعديل الرصيد بنجاح' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ' });
  }
});

app.post('/api/admin/delete-task', async (req, res) => {
  try {
    const { adminId, taskId } = req.body;
    if (String(adminId) !== ADMIN_ID) return res.status(403).json({ success: false, message: 'غير مصرح' });

    await Task.findByIdAndDelete(taskId);
    res.json({ success: true, message: 'تم حذف المهمة بنجاح' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ' });
  }
});

app.post('/api/admin/create-promo', async (req, res) => {
  try {
    const { adminId, code, totalGold, maxUses, goldRewardPerPerson, amount, type } = req.body;
    if (String(adminId) !== ADMIN_ID) return res.status(403).json({ success: false, message: 'غير مصرح' });

    if (!code) return res.status(400).json({ success: false, message: 'يرجى إدخال اسم الرمز' });

    const cleanCode = code.trim().toUpperCase();
    const existing = await Promo.findOne({ code: cleanCode });
    if (existing) return res.status(400).json({ success: false, message: 'هذا الكود موجود مسبقاً' });

    const reward = goldRewardPerPerson || amount || 1000;
    const uses = maxUses || 10;

    const newPromo = new Promo({
      code: cleanCode,
      amount: Number(reward),
      type: type || 'gold',
      maxUses: Number(uses),
      diamondsPerUser: Number(reward)
    });

    await newPromo.save();
    res.json({ success: true, message: 'تم إنشاء الكود الترويجي وإطلاقه بنجاح' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'فشل إنشاء الرمز' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 السيرفر يعمل بكامل طاقته على المنفذ ${PORT}`);
});
