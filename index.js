require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'retailreach_secret_key_2024';

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/retailreach')
  .then(() => console.log('MongoDB Connected'))
  .catch(err => console.log(err));

const userSchema = new mongoose.Schema({
  shopName: { type: String, required: true },
  ownerName: { type: String, required: true },
  phone: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  plan: { type: String, default: 'starter' },
  language: { type: String, default: 'hindi' },
  subscriptionStatus: { type: String, default: 'active' },
  subscriptionExpiry: { type: Date },
  createdAt: { type: Date, default: Date.now }
});

const customerSchema = new mongoose.Schema({
  shopId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true },
  phone: { type: String, required: true },
  tags: [String],
  birthday: Date,
  createdAt: { type: Date, default: Date.now }
});

const campaignSchema = new mongoose.Schema({
  shopId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true },
  message: { type: String, required: true },
  language: { type: String, default: 'hindi' },
  channels: [String],
  scheduledDate: Date,
  status: { type: String, default: 'draft' },
  totalSent: { type: Number, default: 0 },
  totalDelivered: { type: Number, default: 0 },
  totalFailed: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

const campaignLogSchema = new mongoose.Schema({
  campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', required: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
  customerPhone: String,
  channel: String,
  deliveryStatus: { type: String, default: 'pending' },
  timestamp: { type: Date, default: Date.now }
});

const paymentSchema = new mongoose.Schema({
  shopId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amount: Number,
  plan: String,
  paymentStatus: { type: String, default: 'pending' },
  paymentDate: { type: Date, default: Date.now },
  expiryDate: Date
});

const User = mongoose.model('User', userSchema);
const Customer = mongoose.model('Customer', customerSchema);
const Campaign = mongoose.model('Campaign', campaignSchema);
const CampaignLog = mongoose.model('CampaignLog', campaignLogSchema);
const Payment = mongoose.model('Payment', paymentSchema);

const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Unauthorized' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    res.status(401).json({ message: 'Invalid token' });
  }
};

app.post('/api/auth/register', async (req, res) => {
  try {
    const { shopName, ownerName, phone, email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ shopName, ownerName, phone, email, password: hashedPassword });
    await user.save();
    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user._id, shopName, ownerName, email, plan: user.plan } });
  } catch (err) {
    res.status(400).json({ message: 'Registration failed', error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: 'User not found' });
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Invalid credentials' });
    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user._id, shopName: user.shopName, ownerName: user.ownerName, email, plan: user.plan, language: user.language } });
  } catch (err) {
    res.status(400).json({ message: 'Login failed' });
  }
});

app.get('/api/auth/me', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password');
    res.json(user);
  } catch (err) {
    res.status(400).json({ message: 'Error fetching user' });
  }
});

app.put('/api/auth/me', authenticate, async (req, res) => {
  try {
    const { shopName, ownerName, language } = req.body;
    const user = await User.findByIdAndUpdate(req.userId, { shopName, ownerName, language }, { new: true }).select('-password');
    res.json(user);
  } catch (err) {
    res.status(400).json({ message: 'Update failed' });
  }
});

app.get('/api/customers', authenticate, async (req, res) => {
  try {
    const { search, tag, page = 1 } = req.query;
    const query = { shopId: req.userId };
    if (search) query.$or = [{ name: new RegExp(search, 'i') }, { phone: new RegExp(search, 'i') }];
    if (tag) query.tags = tag;
    const customers = await Customer.find(query).limit(50).skip((page - 1) * 50);
    const total = await Customer.countDocuments(query);
    res.json({ customers, total, page: parseInt(page) });
  } catch (err) {
    res.status(400).json({ message: 'Error fetching customers' });
  }
});

app.post('/api/customers', authenticate, async (req, res) => {
  try {
    const { name, phone, tags, birthday } = req.body;
    const customer = new Customer({ shopId: req.userId, name, phone, tags, birthday });
    await customer.save();
    res.json(customer);
  } catch (err) {
    res.status(400).json({ message: 'Error adding customer' });
  }
});

app.post('/api/customers/import', authenticate, async (req, res) => {
  try {
    const results = [];
    fs.createReadStream(req.body.filePath)
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', async () => {
        const customers = results.map(r => ({
          shopId: req.userId,
          name: r.name || r.Name || 'Unknown',
          phone: r.phone || r.Phone || r.mobile || r.Mobile,
          tags: r.tags ? r.tags.split(',') : []
        }));
        await Customer.insertMany(customers);
        res.json({ message: `Imported ${customers.length} customers` });
      });
  } catch (err) {
    res.status(400).json({ message: 'Import failed' });
  }
});

app.delete('/api/customers/:id', authenticate, async (req, res) => {
  try {
    await Customer.findOneAndDelete({ _id: req.params.id, shopId: req.userId });
    res.json({ message: 'Customer deleted' });
  } catch (err) {
    res.status(400).json({ message: 'Delete failed' });
  }
});

app.get('/api/campaigns', authenticate, async (req, res) => {
  try {
    const { status, page = 1 } = req.query;
    const query = { shopId: req.userId };
    if (status) query.status = status;
    const campaigns = await Campaign.find(query).sort({ createdAt: -1 }).limit(20).skip((page - 1) * 20);
    const total = await Campaign.countDocuments(query);
    res.json({ campaigns, total, page: parseInt(page) });
  } catch (err) {
    res.status(400).json({ message: 'Error fetching campaigns' });
  }
});

app.post('/api/campaigns', authenticate, async (req, res) => {
  try {
    const { title, message, language, channels, scheduledDate, customerIds } = req.body;
    const campaign = new Campaign({
      shopId: req.userId,
      title,
      message,
      language,
      channels,
      scheduledDate: scheduledDate || null,
      status: scheduledDate ? 'scheduled' : 'draft'
    });
    await campaign.save();
    res.json(campaign);
  } catch (err) {
    res.status(400).json({ message: 'Error creating campaign' });
  }
});

app.post('/api/campaigns/:id/send', authenticate, async (req, res) => {
  try {
    const campaign = await Campaign.findOne({ _id: req.params.id, shopId: req.userId });
    if (!campaign) return res.status(404).json({ message: 'Campaign not found' });
    
    const customers = await Customer.find({ shopId: req.userId });
    const logs = customers.map(c => ({
      campaignId: campaign._id,
      customerId: c._id,
      customerPhone: c.phone,
      channel: campaign.channels[0],
      deliveryStatus: 'sent'
    }));
    
    await CampaignLog.insertMany(logs);
    campaign.status = 'sent';
    campaign.totalSent = customers.length;
    campaign.totalDelivered = Math.floor(customers.length * 0.85);
    campaign.totalFailed = Math.floor(customers.length * 0.15);
    await campaign.save();
    
    res.json({ message: 'Campaign sent', campaign });
  } catch (err) {
    res.status(400).json({ message: 'Send failed' });
  }
});

app.get('/api/campaigns/:id', authenticate, async (req, res) => {
  try {
    const campaign = await Campaign.findOne({ _id: req.params.id, shopId: req.userId });
    const logs = await CampaignLog.find({ campaignId: campaign._id }).limit(100);
    res.json({ campaign, logs });
  } catch (err) {
    res.status(400).json({ message: 'Error fetching campaign' });
  }
});

app.delete('/api/campaigns/:id', authenticate, async (req, res) => {
  try {
    await Campaign.findOneAndDelete({ _id: req.params.id, shopId: req.userId });
    await CampaignLog.deleteMany({ campaignId: req.params.id });
    res.json({ message: 'Campaign deleted' });
  } catch (err) {
    res.status(400).json({ message: 'Delete failed' });
  }
});

app.get('/api/analytics', authenticate, async (req, res) => {
  try {
    const totalCustomers = await Customer.countDocuments({ shopId: req.userId });
    const totalCampaigns = await Campaign.countDocuments({ shopId: req.userId });
    const sentCampaigns = await Campaign.find({ shopId: req.userId, status: 'sent' });
    const totalSent = sentCampaigns.reduce((sum, c) => sum + c.totalSent, 0);
    const totalDelivered = sentCampaigns.reduce((sum, c) => sum + c.totalDelivered, 0);
    const deliveryRate = totalSent > 0 ? Math.round((totalDelivered / totalSent) * 100) : 0;
    
    res.json({
      totalCustomers,
      totalCampaigns,
      totalSent,
      totalDelivered,
      deliveryRate,
      recentCampaigns: sentCampaigns.slice(0, 5)
    });
  } catch (err) {
    res.status(400).json({ message: 'Error fetching analytics' });
  }
});

app.get('/api/billing', authenticate, async (req, res) => {
  try {
    const payments = await Payment.find({ shopId: req.userId }).sort({ paymentDate: -1 });
    const user = await User.findById(req.userId);
    res.json({ plan: user.plan, payments, subscriptionExpiry: user.subscriptionExpiry });
  } catch (err) {
    res.status(400).json({ message: 'Error fetching billing' });
  }
});

app.post('/api/billing/subscribe', authenticate, async (req, res) => {
  try {
    const { plan, amount } = req.body;
    const expiryDate = new Date();
    expiryDate.setMonth(expiryDate.getMonth() + 1);
    
    await User.findByIdAndUpdate(req.userId, { 
      plan, 
      subscriptionStatus: 'active',
      subscriptionExpiry: expiryDate 
    });
    
    const payment = new Payment({
      shopId: req.userId,
      amount,
      plan,
      paymentStatus: 'success',
      expiryDate
    });
    await payment.save();
    
    res.json({ message: 'Subscription updated', plan, expiryDate });
  } catch (err) {
    res.status(400).json({ message: 'Subscription failed' });
  }
});

app.get('/api/templates', authenticate, async (req, res) => {
  const templates = {
    hindi: [
      { title: 'Sunday Special', message: 'Namaste! {shopName} se special offer. Is Sunday flat {discount}% OFF on all products. Jaldi visit karein!' },
      { title: 'Festival Offer', message: 'Namaste! {shopName} ke saath Diwali celebration. Get {discount}% extra discount on your purchase!' },
      { title: 'New Arrival', message: 'Namaste! {shopName} me naye products aaye hain. First 100 customers ko {discount}% discount!' }
    ],
    marathi: [
      { title: 'Sunday Special', message: 'Namaskar! {shopName} kadun special offer. Ya Sunday sarva products var {discount}% OFF. Jaldi visit kara!' },
      { title: 'Festival Offer', message: 'Namaskar! {shopName} sangla Diwali celebration. Tumchya purchase var {discount}% extra discount!' },
      { title: 'New Arrival', message: 'Namaskar! {shopName} madhe naye products aalay. First 100 customers la {discount}% discount!' }
    ],
    english: [
      { title: 'Sunday Special', message: 'Hello! Special offer from {shopName}. Flat {discount}% OFF on all products this Sunday. Visit today!' },
      { title: 'Festival Offer', message: 'Hello! Celebrate Diwali with {shopName}. Get {discount}% extra discount on your purchase!' },
      { title: 'New Arrival', message: 'Hello! New arrivals at {shopName}. First 100 customers get {discount}% discount!' }
    ]
  };
  res.json(templates);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
