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

// تعريف نموذج المستخدم (User Schema) لحفظ الأرصدة والبيانات
const userSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true },
  name: { type: String, default: 'زائر كريم' },
  gold: { type: Number, default: 531600 },
  diamonds: { type: Number, default: 288 },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// تعريف نموذج المهام (Task Schema) لحفظ المهام والمنشئين
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

// --- المسارات (API Routes) ---

// 1. اختبار السيرفر
app.get('/', (req, res) => {
  res.send('Money Bux Backend Server is Running! 🚀');
});

// 2. جلب جميع المهام النشطة
app.get('/api/tasks', async (req, res) => {
  try {
    const tasks = await Task.find().sort({ createdAt: -1 });
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: 'خطأ في جلب المهام' });
  }
});

// 3. إنشاء مهمة جديدة (خصم TON أو تسجيلها)
app.post('/api/tasks', async (req, res) => {
  try {
    const { title, platform, link, target, cost, creatorId } = req.body;
    const newTask = new Task({
      title,
      platform,
      link,
      target,
      cost,
      creatorId
    });
    await newTask.save();
    res.status(201).json({ message: 'تم إنشاء المهمة بنجاح', task: newTask });
  } catch (err) {
    res.status(500).json({ error: 'فشل إنشاء المهمة' });
  }
});

// تشغيل السيرفر على المنفذ المحلي أو السحابي
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 السيرفر يعمل على المنفذ ${PORT}`);
});
