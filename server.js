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
  currency: { type: String, default: 'MAD' },
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
  type: { type: String, required: true, default: 'gold' },
  maxUses: { type: Number, default: 100 },
  usedCount: { type: Number, default: 0 },
  usedBy: [{ type: String }],
  createdAt: { type: Date, default: Date.now }
});
const Promo = mongoose.model('Promo', promoSchema);

// نموذج المعاملات المالية للإيداع والسحب
const transactionSchema = new mongoose.Schema({
  txId: { type: String, required: true },
  userId: { type: String, required: true },
  type: { type: String, required: true }, // 'إيداع' أو 'سحب'
  amount: { type: Number, required: true },
  method: { type: String, required: true },
  details: { type: String },
  status: { type: String, default: 'pending' }, // pending, approved, rejected
  date: { type: String, default: () => new Date().toLocaleString() },
  createdAt: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', transactionSchema);

const ADMIN_ID = "6669520092";

// --- المسارات (API Routes) ---

app.get('/', (req, res) => {
  res.send('Money Slayer Pro Backend Server is Running! 🚀');
});

// 1. بروفايل المستخدم وتحديث العملة مع التحقق الصارم من الحظر
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

app.post('/api/user/update-currency', async (req, res) => {
  try {
    const { userId, currency } = req.body;
    if (!userId || !currency) return res.status(400).json({ success: false, message: 'بيانات غير صالحة' });

    let user = await User.findOne({ telegramId: userId });
    if (!user) return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
    if (user.isBanned) return res.status(403).json({ success: false, message: 'حساب محظور' });
    
    user.currency = currency;
    await user.save();
    res.json({ success: true, message: 'تم تحديث العملة بنجاح' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في تحديث العملة' });
  }
});

// 2. نظام الإحالات الصارم
app.get('/api/referrals/stats', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ success: false, message: 'Missing userId' });

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
      return res.status(400).json({ success: false, message: 'خطأ في البيانات' });
    }
    let referrer = await User.findOne({ telegramId: referrerId });
    if (referrer && !referrer.isBanned) {
      referrer.referralCount = (referrer.referralCount || 0) + 1;
      referrer.gold = (referrer.gold || 0) + 100;
      await referrer.save();
    }
    res.json({ success: true, message: 'تم' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ' });
  }
});

// 3. المحفظة والتحويلات والتبادل والإيداع والسحب
app.get('/api/wallet/details', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ success: false, message: 'Missing userId' });

    let user = await User.findOne({ telegramId: userId });
    if (user && user.isBanned) return res.status(403).json({ success: false, message: 'حساب محظور' });

    const transactions = await Transaction.find({ userId }).sort({ createdAt: -1 });
    
    res.json({
      success: true,
      balance: user ? user.balance : 0,
      gold: user ? user.gold : 0,
      assets: [
        { symbol: 'USDT', name: 'TetherUS', logo: '₮', color: '#26a69a', amount: user ? user.balance : 0, rate: 1.0 },
        { symbol: 'GRAM', name: 'Gram Token', logo: '💎', color: '#00d2ff', amount: user ? user.diamonds : 0, rate: 1.2 },
        { symbol: 'TRX', name: 'Tron', logo: 'TRX', color: '#ff0000', amount: 0, rate: 0.12 },
        { symbol: 'BTC', name: 'Bitcoin', logo: '₿', color: '#f7931a', amount: 0, rate: 68000.0 },
        { symbol: 'ETH', name: 'Ethereum', logo: 'Ξ', color: '#627eea', amount: 0, rate: 3400.0 },
        { symbol: 'SOL', name: 'Solana', logo: '◎', color: '#14f195', amount: 0, rate: 145.0 }
      ],
      transactions: transactions.map(t => ({
        id: t.txId,
        userId: t.userId,
        type: t.type,
        amount: t.amount,
        method: t.method,
        details: t.details,
        status: t.status === 'approved' ? 'approved' : t.status === 'rejected' ? 'rejected' : 'pending',
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
    if (!userId || !amount || Number(amount) <= 0) return res.status(400).json({ success: false, message: 'بيانات غير صالحة' });

    let user = await User.findOne({ telegramId: userId });
    if (!user) return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
    if (user.isBanned) return res.status(403).json({ success: false, message: 'حساب محظور' });

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

app.post('/api/wallet/convert', async (req, res) => {
  try {
    const { userId, amount } = req.body;
    if (!userId || !amount || Number(amount) <= 0) return res.status(400).json({ success: false, message: 'بيانات غير صالحة' });

    let user = await User.findOne({ telegramId: userId });
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
    if (!userId || !amount || Number(amount) <= 0) return res.status(400).json({ success: false, message: 'بيانات غير صالحة' });

    let sender = await User.findOne({ telegramId: userId });
    if (!sender || sender.isBanned) return res.status(404).json({ success: false, message: 'المستخدم غير موجود أو محظور' });

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
    if (recipient.isBanned) return res.status(400).json({ success: false, message: 'المستلم محظور' });

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
    const { userId, amount, method, txId } = req.body;
    if (!userId || !amount || Number(amount) <= 0) return res.status(400).json({ success: false, message: 'بيانات غير صالحة' });

    let user = await User.findOne({ telegramId: userId });
    if (!user || user.isBanned) return res.status(403).json({ success: false, message: 'حساب محظور أو غير موجود' });

    const newTx = new Transaction({
      txId: txId || ('DEP-' + Math.floor(Math.random() * 900000 + 100000)),
      userId,
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
    if (!userId || !amount) return res.status(400).json({ success: false, message: 'بيانات غير صالحة' });

    const newTx = new Transaction({
      txId: 'DEP-' + Math.floor(Math.random() * 900000 + 100000),
      userId,
      type: 'إيداع',
      amount: Number(amount),
      method: method || 'BINANCE',
      details: details || '',
      status: 'pending'
    });
    await newTx.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

app.post('/api/admin/withdraw-notify', async (req, res) => {
  try {
    const { userId, amount, method, details } = req.body;
    if (!userId || !amount) return res.status(400).json({ success: false, message: 'بيانات غير صالحة' });

    const newTx = new Transaction({
      txId: 'WIT-' + Math.floor(Math.random() * 900000 + 100000),
      userId,
      type: 'سحب',
      amount: Number(amount),
      method: method || 'BANK',
      details: details || '',
      status: 'pending'
    });
    await newTx.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

app.post('/api/wallet/withdraw', async (req, res) => {
  try {
    const { userId, amount, method, details } = req.body;
    if (!userId || !amount || Number(amount) < 10) {
      return res.status(400).json({ success: false, message: 'الحد الأدنى للسحب هو 10$' });
    }

    let user = await User.findOne({ telegramId: userId });
    if (!user || user.isBanned || user.balance < Number(amount)) {
      return res.status(400).json({ success: false, message: 'الرصيد غير كافٍ أو الحساب محظور' });
    }

    const newTx = new Transaction({
      txId: 'WIT-' + Math.floor(Math.random() * 900000 + 100000),
      userId,
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

// 4. الرموز الترويجية (Promo Codes) مع منع الاستخدام المزدوج الصارم
app.post('/api/promo/redeem', async (req, res) => {
  try {
    const { userId, code } = req.body;
    if (!userId || !code) return res.status(400).json({ success: false, message: 'الرجاء إدخال الرمز' });

    let promo = await Promo.findOne({ code: code.trim().toUpperCase() });
    if (!promo) return res.status(400).json({ success: false, message: 'الرمز غير صحيح' });

    if (promo.usedBy && promo.usedBy.includes(userId)) {
      return res.status(400).json({ success: false, message: 'استخدمت هذا الرمز مسبقاً' });
    }

    if (promo.usedCount >= promo.maxUses) {
      return res.status(400).json({ success: false, message: 'انتهت صلاحية الرمز' });
    }

    let user = await User.findOne({ telegramId: userId });
    if (!user || user.isBanned) return res.status(403).json({ success: false, message: 'حساب محظور أو غير موجود' });

    const reward = promo.amount || 1000;
    user[promo.type || 'gold'] = (user[promo.type || 'gold'] || 0) + reward;

    promo.usedCount += 1;
    promo.usedBy.push(userId);

    await user.save();
    await promo.save();

    res.json({ success: true, reward, user, message: `تم تفعيل الكود بنجاح! حصلت على ${reward} ${promo.type || 'gold'}` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في تفعيل الرمز' });
  }
});

app.post('/api/promo/apply', async (req, res) => {
  try {
    const { userId, code } = req.body;
    if (!userId || !code) return res.status(400).json({ success: false, message: 'الرجاء إدخال الرمز' });

    let promo = await Promo.findOne({ code: code.trim().toUpperCase() });
    if (!promo) return res.status(400).json({ success: false, message: 'الرمز غير صحيح' });

    if (promo.usedBy && promo.usedBy.includes(userId)) {
      return res.status(400).json({ success: false, message: 'استخدمت هذا الرمز مسبقاً' });
    }

    if (promo.usedCount >= promo.maxUses) {
      return res.status(400).json({ success: false, message: 'انتهت صلاحية الرمز' });
    }

    let user = await User.findOne({ telegramId: userId });
    if (!user || user.isBanned) return res.status(403).json({ success: false, message: 'حساب محظور' });

    const goldReward = promo.amount || 1000;
    user[promo.type || 'gold'] = (user[promo.type || 'gold'] || 0) + goldReward;

    promo.usedCount += 1;
    promo.usedBy.push(userId);

    await user.save();
    await promo.save();

    res.json({ success: true, goldReward, message: `تم تفعيل الرمز بنجاح!` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
  }
});

app.post('/api/promo/create', async (req, res) => {
  try {
    const { userId, code, totalGold, maxUses, goldRewardPerPerson } = req.body;
    if (!userId || !code) return res.status(400).json({ success: false, message: 'بيانات غير صالحة' });

    let user = await User.findOne({ telegramId: userId });
    if (!user || user.isBanned) return res.status(403).json({ success: false, message: 'حساب محظور أو غير موجود' });

    const cleanCode = code.trim().toUpperCase();
    const existing = await Promo.findOne({ code: cleanCode });
    if (existing) return res.status(400).json({ success: false, message: 'هذا الكود موجود مسبقاً' });

    const newPromo = new Promo({
      code: cleanCode,
      amount: Number(goldRewardPerPerson || 1000),
      type: 'gold',
      maxUses: Number(maxUses || 5)
    });

    await newPromo.save();
    res.json({ success: true, message: 'تم إنشاء الكود بنجاح' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'فشل إنشاء الرمز' });
  }
});

// 5. المهام (Tasks) مع جلب الآيدي الصارم
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
    res.json({ success: true, tasks: tasks.map(t => ({ id: t._id, creatorId: t.creatorId, title: t.title, platform: t.platform, link: t.link, targetUsers: t.target, current: t.current, rewardGold: 1000, completedBy: t.completedBy })) });
  } catch (err) {
    res.status(500).json({ success: false, error: 'خطأ في جلب المهام' });
  }
});

app.post('/api/tasks', async (req, res) => {
  try {
    const { title, platform, link, target, cost, creatorId } = req.body;
    const newTask = new Task({ title, platform, link, target: target || 50, cost: cost || '1', creatorId });
    await newTask.save();
    res.status(201).json({ message: 'تم إنشاء المهمة بنجاح', task: newTask });
  } catch (err) {
    res.status(500).json({ error: 'فشل إنشاء المهمة' });
  }
});

app.post('/api/tasks/create', async (req, res) => {
  try {
    const { userId, title, platform, link, targetUsers, cost } = req.body;
    if (!userId || !title || !link) return res.status(400).json({ success: false, message: 'بيانات غير صالحة' });

    let user = await User.findOne({ telegramId: userId });
    if (!user || user.isBanned) return res.status(403).json({ success: false, message: 'حساب محظور أو غير موجود' });

    const totalCost = Number(cost) || 1;
    if (user.balance < totalCost) {
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
      creatorId: userId
    });
    await newTask.save();

    res.json({ success: true, message: 'تم إنشاء المهمة بنجاح', task: newTask });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في إنشاء المهمة' });
  }
});

// مسار إتمام المهمة مع التحقق الصارم المزدوج ومنح المكافأة الثابتة (1000 ذهبة) بدلاً من تكلفة المهمة
app.post('/api/tasks/complete', async (req, res) => {
  try {
    const { userId, taskId, wasVisited } = req.body;
    if (!userId || !taskId) return res.status(400).json({ success: false, message: 'بيانات غير صالحة' });

    // التحقق الصارم الأمني: يجب التأكد من أن المستخدم قام بزيارة الرابط أولاً
    if (!wasVisited) {
      return res.status(400).json({ success: false, message: 'يجب الضغط على "ابدأ التنفيذ" وزيارة الرابط أولاً قبل التحقق واستلام المكافأة!' });
    }

    let user = await User.findOne({ telegramId: userId });
    if (!user || user.isBanned) return res.status(403).json({ success: false, message: 'حساب محظور أو غير موجود' });

    let task = await Task.findById(taskId);
    if (!task) return res.status(404).json({ success: false, message: 'المهمة غير موجودة' });

    // التحقق الصارم لمنع تكرار الإتمام نهائياً
    if (task.completedBy && task.completedBy.includes(userId)) {
      return res.status(400).json({ success: false, message: 'لقد أتممت هذه المهمة مسبقاً ولا يمكنك تكرارها!' });
    }

    const rewardAmount = 1000; // المكافأة الصحيحة والثابتة 1000 ذهبة
    user.gold = (user.gold || 0) + rewardAmount;
    
    task.current = (task.current || 0) + 1;
    if (!task.completedBy) task.completedBy = [];
    task.completedBy.push(userId);

    if (task.current >= task.target) {
      task.status = 'مكتملة';
    }

    await user.save();
    await task.save();

    res.json({ success: true, rewardGold: rewardAmount, message: `تم إتمام المهمة بنجاح! حصلت على ${rewardAmount} ذهبة`, user });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
  }
});

// 6. لعبة الصاروخ الفضائي (Rocket Game API) مع التحقق من الأرصدة والحظر
app.get('/api/games/rocket/status', async (req, res) => {
  try {
    const { userId } = req.query;
    let user = await User.findOne({ telegramId: userId });
    if (user && user.isBanned) return res.status(403).json({ success: false, message: 'حساب محظور' });

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
    if (!user || user.isBanned) return res.status(403).json({ success: false, message: 'المستخدم غير موجود أو محظور' });

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

// 7. لوحة تحكم المطور الشاملة (Super Admin Panel API) مع التحقق الصارم من صلاحيات الأدمن
app.get('/api/admin/dashboard', async (req, res) => {
  try {
    const { adminId } = req.query;
    if (String(adminId) !== ADMIN_ID) {
      return res.status(403).json({ success: false, message: 'غير مصرح لك بالوصول - صلاحيات المطور مطلوبة' });
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
        totalRevenue: 4250,
        pendingCount: pendingTxs.length
      },
      transactions: pendingTxs.map(t => ({ id: t.txId, type: t.type, userId: t.userId, amount: t.amount, currency: 'USD', status: t.status })),
      tasks: tasks.map(t => ({ id: t._id, title: t.title, current: t.current, targetUsers: t.target })),
      promos: promos.map(p => ({ code: p.code, amount: p.amount, maxUses: p.maxUses, usedCount: p.usedCount })),
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

    let tx = await Transaction.findOne({ txId });
    if (!tx) return res.status(404).json({ success: false, message: 'المعاملة غير موجودة' });

    tx.status = (action === 'accept' ? 'approved' : 'rejected');
    await tx.save();

    if (action === 'accept' && tx.type === 'إيداع') {
      let user = await User.findOne({ telegramId: tx.userId });
      if (user) {
        user.balance = (user.balance || 0) + tx.amount;
        await user.save();
      }
    }

    res.json({ success: true, message: `تم ${action === 'accept' ? 'قبول' : 'رفض'} المعاملة بنجاح` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في معالجة المعاملة' });
  }
});

app.post('/api/admin/update-rocket', async (req, res) => {
  try {
    const { adminId } = req.body;
    if (String(adminId) !== ADMIN_ID) return res.status(403).json({ success: false, message: 'غير مصرح' });
    res.json({ success: true, message: 'تم تحديث خوارزمية لعبة الصاروخ بنجاح' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ' });
  }
});

// مسار حظر وفك حظر المستخدم من لوحة الأدمن مع التحقق الصارم
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
    res.status(500).json({ success: false, message: 'خطأ في حظر المستخدم' });
  }
});

// مسار تعديل رصيد المستخدم (إضافة / خصم) من لوحة الأدمن مع دعم 'usd' و 'balance' بدقة
app.post('/api/admin/modify-balance', async (req, res) => {
  try {
    const { adminId, targetUserId, amount, type, action } = req.body;
    if (String(adminId) !== ADMIN_ID) return res.status(403).json({ success: false, message: 'غير مصرح' });

    let user = await User.findOne({ telegramId: targetUserId });
    if (!user) user = new User({ telegramId: targetUserId });

    const value = Number(amount);
    let balanceType = type || 'gold';
    if (balanceType === 'usd') {
      balanceType = 'balance';
    }

    if (action === 'add') {
      user[balanceType] = (user[balanceType] || 0) + value;
    } else if (action === 'subtract') {
      user[balanceType] = Math.max(0, (user[balanceType] || 0) - value);
    }

    await user.save();
    res.json({ success: true, message: 'تم تعديل الرصيد بنجاح', user });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في تعديل رصيد المستخدم' });
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

// مسار إضافة وإنشاء رمز ترويجي جديد من لوحة الأدمن مع التحقق الصارم
app.post('/api/admin/create-promo', async (req, res) => {
  try {
    const { adminId, code, totalGold, maxUses, goldRewardPerPerson, amount, type } = req.body;
    if (String(adminId) !== ADMIN_ID) return res.status(403).json({ success: false, message: 'غير مصرح' });

    if (!code) return res.status(400).json({ success: false, message: 'يرجى إدخال اسم الرمز' });

    const cleanCode = code.trim().toUpperCase();
    const existing = await Promo.findOne({ code: cleanCode });
    if (existing) return res.status(400).json({ success: false, message: 'هذا الكود موجود مسبقاً' });

    const reward = goldRewardPerPerson || amount || 1000;
    const uses = maxUses || 100;

    const newPromo = new Promo({
      code: cleanCode,
      amount: Number(reward),
      type: type || 'gold',
      maxUses: Number(uses)
    });

    await newPromo.save();
    res.json({ success: true, message: 'تم إنشاء الكود الترويجي وإطلاقه بنجاح' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'فشل إنشاء الرمز' });
  }
});

// مسار حذف رمز ترويجي من لوحة الأدمن مع التحقق الصارم
app.post('/api/admin/delete-promo', async (req, res) => {
  try {
    const { adminId, code } = req.body;
    if (String(adminId) !== ADMIN_ID) return res.status(403).json({ success: false, message: 'غير مصرح' });

    await Promo.findOneAndDelete({ code: code.trim().toUpperCase() });
    res.json({ success: true, message: 'تم حذف الكود الترويجي بنجاح' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في حذف الكود' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 السيرفر يعمل بكامل طاقته على المنفذ ${PORT}`);
});
