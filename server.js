const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();

// إعدادات الأمان والتواصل مع الواجهة الأمامية (Netlify)
app.use(cors());
app.use(express.json());

// الاتصال بقاعدة بيانات MongoDB Atlas
const MONGO_URI = process.env.MONGO_URI || 'ضع_رابط_قاعدة_البيانات_هنا';

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ تم الاتصال بقاعدة بيانات MongoDB Atlas بنجاح'))
  .catch((err) => console.error('❌ خطأ في الاتصال بقاعدة البيانات:', err));

// --- النماذج (Schemas) ---

// 1. نموذج المستخدم
const userSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true },
  name: { type: String, default: 'زائر كريم' },
  gold: { type: Number, default: 0 },
  diamonds: { type: Number, default: 0 },
  balance: { type: Number, default: 0 },
  referralCount: { type: Number, default: 0 },
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

// 2. جلب بروفایل المستخدم
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

// 3. مسارات الأدمين (Admin Endpoints)
const ADMIN_ID = "6669520092";

// أ) إحصائيات لوحة التحكم
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
        activeToday: totalUsers // افتراضي أو حسب آخر نشاط
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في جلب الإحصائيات' });
  }
});

// ب) تعديل أرصدة المستخدمين (إضافة أو خصم)
app.post('/api/admin/modify-balance', async (req, res) => {
  try {
    const { adminId, targetUserId, amount, type, action } = req.body;

    if (String(adminId) !== ADMIN_ID) {
      return res.status(403).json({ success: false, message: 'غير مصرح لك بالقيام بهذا الاجراء' });
    }

    let user = await User.findOne({ telegramId: targetUserId });
    if (!user) {
      // إذا لم يكن المستخدم مسجلاً بعد، نقوم بإنشائه تلقائياً
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

// ج) إنشاء رمز ترويجي جديد (Promo Code)
app.post('/api/admin/create-promo', async (req, res) => {
  try {
    const { adminId, code, amount, type, maxUses } = req.body;

    if (String(adminId) !== ADMIN_ID) {
      return res.status(403).json({ success: false, message: 'غير مصرح لك' });
    }

    const existingPromo = await Promo.findOne({ code });
    if (existingPromo) {
      return.status(400).json({ success: false, message: 'هذا الكود موجود مسبقاً' });
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

// --- مسارات المهام التقليدية ---
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
