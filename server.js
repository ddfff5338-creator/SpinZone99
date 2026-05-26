require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const http = require('http');
const { WebSocketServer } = require('ws');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'spinzone_secret_key';
const MM_SECRET = process.env.MIDDLEMAN_SECRET || 'middleman_admin_pass';
const MM_ROBLOX = 'SpinZone99';
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => { console.error('❌ MongoDB error:', err); process.exit(1); });

// ── SCHEMAS ──────────────────────────────────────────────
const User = mongoose.model('User', new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  robloxUsername: { type: String, default: null },
  createdAt: { type: Date, default: Date.now }
}));

// Each item in a player's site inventory
const Item = mongoose.model('Item', new mongoose.Schema({
  ownerId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  ownerName: { type: String, required: true },
  petName:   { type: String, required: true },
  petValue:  { type: Number, required: true },
  petImage:  { type: String, default: '' },
  // pending = waiting for middleman to confirm deposit
  // available = in inventory, can be used in flips
  // in_flip = currently in an active flip
  // withdraw_requested = player wants to withdraw
  // withdrawn = middleman sent it back
  status: { type: String, enum: ['pending','available','in_flip','withdraw_requested','withdrawn'], default: 'pending' },
  createdAt: { type: Date, default: Date.now }
}));

const Flip = mongoose.model('Flip', new mongoose.Schema({
  creatorId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  creatorName: { type: String, required: true },
  creatorItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'Item', required: true },
  creatorPetName:  { type: String, required: true },
  creatorPetValue: { type: Number, required: true },
  creatorPetImage: { type: String, default: '' },
  joinerId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  joinerName: { type: String, default: null },
  joinerItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'Item', default: null },
  joinerPetName:  { type: String, default: null },
  joinerPetValue: { type: Number, default: null },
  joinerPetImage: { type: String, default: '' },
  status: { type: String, enum: ['waiting','done','cancelled'], default: 'waiting' },
  winnerId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  winnerName: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  finishedAt: { type: Date, default: null }
}));

const Verification = mongoose.model('Verification', new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  code: String,
  robloxUsername: String,
  createdAt: { type: Date, default: Date.now, expires: 600 }
}));

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// ── RAP CACHE ────────────────────────────────────────────
let rapCache = null, rapCacheTime = 0;
async function getRAP() {
  if (rapCache && Date.now() - rapCacheTime < 4 * 3600 * 1000) return rapCache;
  try {
    const r = await fetch('https://ps99.biggamesapi.io/api/rap', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const d = await r.json();
    rapCache = d.data || []; rapCacheTime = Date.now();
    return rapCache;
  } catch { return rapCache || []; }
}
getRAP();

function findPet(rap, name) {
  const q = name.toLowerCase().replace(/[^a-z0-9]/g,'');
  return rap.find(p => {
    const id = p.configData?.id; if (!id) return false;
    return id.toLowerCase() === name.toLowerCase().trim() || id.toLowerCase().replace(/[^a-z0-9]/g,'') === q;
  });
}
function petImg(name) { return `https://biggamesapi.io/image/${encodeURIComponent(name)}`; }

// ── WEBSOCKET ─────────────────────────────────────────────
const clients = new Set();
wss.on('connection', async ws => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'init', flips: await publicFlips() }));
  ws.on('close', () => clients.delete(ws));
});
function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const c of clients) if (c.readyState === 1) c.send(msg);
}
async function publicFlips() {
  const cutoff = new Date(Date.now() - 12000);
  return Flip.find({
    $or: [{ status: 'waiting' }, { status: 'done', finishedAt: { $gte: cutoff } }]
  }).lean();
}

// ── AUTH MIDDLEWARE ───────────────────────────────────────
function auth(req, res, next) {
  const t = req.headers.authorization?.replace('Bearer ', '');
  if (!t) return res.status(401).json({ error: 'Not logged in' });
  try { req.user = jwt.verify(t, SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ── AUTH ROUTES ───────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Fill in all fields' });
  if (await User.findOne({ username })) return res.status(400).json({ error: 'Username taken' });
  const user = await User.create({ username, password: await bcrypt.hash(password, 10) });
  res.json({ message: 'Account created!' });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ username });
  if (!user || !await bcrypt.compare(password, user.password)) return res.status(400).json({ error: 'Wrong username or password' });
  const token = jwt.sign({ id: user._id.toString(), username: user.username }, SECRET, { expiresIn: '7d' });
  res.json({ token, username: user.username });
});

// ── ROBLOX VERIFY ─────────────────────────────────────────
app.post('/api/roblox/generate-code', auth, async (req, res) => {
  const { code, robloxUsername } = req.body;
  await Verification.findOneAndUpdate({ userId: req.user.id }, { userId: req.user.id, code, robloxUsername }, { upsert: true });
  res.json({ message: 'Code saved' });
});

app.post('/api/roblox/verify', auth, async (req, res) => {
  const { robloxUsername, code } = req.body;
  const pending = await Verification.findOne({ userId: req.user.id });
  if (!pending || pending.code !== code) return res.status(400).json({ error: 'Invalid or expired code' });
  try {
    const sr = await fetch('https://users.roblox.com/v1/usernames/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usernames: [robloxUsername], excludeBannedUsers: true })
    });
    const sd = await sr.json();
    if (!sd.data?.length) return res.status(400).json({ error: 'Roblox username not found' });
    const rid = sd.data[0].id;
    const pr = await fetch(`https://users.roblox.com/v1/users/${rid}`);
    const pd = await pr.json();
    if (!(pd.description || '').includes(code)) return res.status(400).json({ error: 'Code not found in your Roblox profile description' });
    await User.findByIdAndUpdate(req.user.id, { robloxUsername });
    await Verification.deleteOne({ userId: req.user.id });
    res.json({ message: 'Verified!', robloxUsername });
  } catch { res.status(500).json({ error: 'Could not reach Roblox API' }); }
});

// ── INVENTORY ─────────────────────────────────────────────
// Get my inventory
app.get('/api/inventory', auth, async (req, res) => {
  const items = await Item.find({ ownerId: req.user.id, status: { $ne: 'withdrawn' } }).lean();
  res.json(items.map(i => ({ ...i, id: i._id.toString() })));
});

// Request deposit (no pet name — middleman fills it in)
app.post('/api/inventory/deposit', auth, async (req, res) => {
  const existing = await Item.findOne({ ownerId: req.user.id, status: 'pending' });
  if (existing) return res.status(400).json({ error: 'You already have a pending deposit. Wait for it to be confirmed.' });
  const item = await Item.create({ ownerId: req.user.id, ownerName: req.user.username, petName: 'Pending...', petValue: 0, status: 'pending' });
  broadcast({ type: 'inventory_update' });
  res.json({ message: `Trade your pet to ${MM_ROBLOX} in PS99. The middleman will confirm it shortly!`, item: { ...item.toObject(), id: item._id.toString() } });
});

// Request withdrawal
app.post('/api/inventory/withdraw', auth, async (req, res) => {
  const { itemId } = req.body;
  const item = await Item.findOne({ _id: itemId, ownerId: req.user.id, status: 'available' });
  if (!item) return res.status(404).json({ error: 'Item not found or not available' });
  item.status = 'withdraw_requested';
  await item.save();
  broadcast({ type: 'inventory_update' });
  res.json({ message: `Withdrawal requested! ${MM_ROBLOX} will trade your ${item.petName} back to you in PS99.` });
});

// ── FLIP ROUTES ───────────────────────────────────────────
// Create a flip with one of your items
app.post('/api/flips/create', auth, async (req, res) => {
  const { itemId } = req.body;
  const item = await Item.findOne({ _id: itemId, ownerId: req.user.id, status: 'available' });
  if (!item) return res.status(404).json({ error: 'Item not found or not available' });
  item.status = 'in_flip';
  await item.save();
  const flip = await Flip.create({
    creatorId: req.user.id, creatorName: req.user.username,
    creatorItemId: item._id, creatorPetName: item.petName,
    creatorPetValue: item.petValue, creatorPetImage: item.petImage
  });
  broadcast({ type: 'flips', flips: await publicFlips() });
  res.json({ message: 'Flip created!', flip: { ...flip.toObject(), id: flip._id.toString() } });
});

// Join a flip
app.post('/api/flips/join', auth, async (req, res) => {
  const { flipId, itemId } = req.body;
  const flip = await Flip.findById(flipId);
  if (!flip || flip.status !== 'waiting') return res.status(400).json({ error: 'Flip not available' });
  if (flip.creatorId.toString() === req.user.id) return res.status(400).json({ error: 'Cannot join your own flip' });

  const item = await Item.findOne({ _id: itemId, ownerId: req.user.id, status: 'available' });
  if (!item) return res.status(404).json({ error: 'Item not found or not available' });

  const min = flip.creatorPetValue * 0.9, max = flip.creatorPetValue * 1.1;
  if (item.petValue < min || item.petValue > max) return res.status(400).json({
    error: `Your pet value must be within 10% of ${flip.creatorPetValue.toLocaleString()} RAP (${Math.floor(min).toLocaleString()} – ${Math.ceil(max).toLocaleString()})`
  });

  item.status = 'in_flip';
  await item.save();

  const creatorWins = Math.random() < 0.5;
  const winnerId = creatorWins ? flip.creatorId : req.user.id;
  const winnerName = creatorWins ? flip.creatorName : req.user.username;
  const loserId = creatorWins ? req.user.id : flip.creatorId;

  flip.joinerId = req.user.id; flip.joinerName = req.user.username;
  flip.joinerItemId = item._id; flip.joinerPetName = item.petName;
  flip.joinerPetValue = item.petValue; flip.joinerPetImage = item.petImage;
  flip.status = 'done'; flip.winnerId = winnerId; flip.winnerName = winnerName;
  flip.finishedAt = new Date();
  await flip.save();

  // Both items go to winner as available
  await Item.updateMany(
    { _id: { $in: [flip.creatorItemId, item._id] } },
    { $set: { ownerId: winnerId, ownerName: winnerName, status: 'available' } }
  );

  broadcast({ type: 'flips', flips: await publicFlips() });
  broadcast({ type: 'flip_result', flipId: flip._id.toString(), winnerName, winnerId: winnerId.toString() });

  res.json({ message: 'Flip done!', winnerName });

  setTimeout(async () => broadcast({ type: 'flips', flips: await publicFlips() }), 12000);
});

// Cancel a flip (creator only, while waiting)
app.post('/api/flips/cancel', auth, async (req, res) => {
  const { flipId } = req.body;
  const flip = await Flip.findOne({ _id: flipId, creatorId: req.user.id, status: 'waiting' });
  if (!flip) return res.status(404).json({ error: 'Flip not found or already started' });
  flip.status = 'cancelled';
  await flip.save();
  await Item.findByIdAndUpdate(flip.creatorItemId, { status: 'available' });
  broadcast({ type: 'flips', flips: await publicFlips() });
  res.json({ message: 'Flip cancelled' });
});

// ── MIDDLEMAN ROUTES ──────────────────────────────────────
function mmAuth(req, res, next) {
  if (req.body.secret !== MM_SECRET) return res.status(403).json({ error: 'Forbidden' });
  next();
}

// Get all pending deposits
app.post('/api/mm/pending', mmAuth, async (req, res) => {
  const items = await Item.find({ status: 'pending' }).lean();
  res.json(items.map(i => ({ ...i, id: i._id.toString() })));
});

// Get all withdrawal requests
app.post('/api/mm/withdrawals', mmAuth, async (req, res) => {
  const items = await Item.find({ status: 'withdraw_requested' }).lean();
  res.json(items.map(i => ({ ...i, id: i._id.toString() })));
});

// Confirm deposit — middleman fills in pet name after receiving trade
app.post('/api/mm/confirm', mmAuth, async (req, res) => {
  const { itemId, petName } = req.body;
  if (!petName) return res.status(400).json({ error: 'Pet name required' });
  const rap = await getRAP();
  const match = findPet(rap, petName);
  if (!match) return res.status(404).json({ error: `Pet "${petName}" not found in RAP data` });
  const item = await Item.findById(itemId);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  item.petName = match.configData.id;
  item.petValue = match.value || 0;
  item.petImage = petImg(match.configData.id);
  item.status = 'available';
  await item.save();
  broadcast({ type: 'inventory_update', userId: item.ownerId.toString() });
  res.json({ message: `✅ Confirmed ${item.petName} (${item.petValue.toLocaleString()} RAP) for ${item.ownerName}` });
});

// Reject a pending deposit
app.post('/api/mm/reject', mmAuth, async (req, res) => {
  const { itemId } = req.body;
  await Item.findByIdAndDelete(itemId);
  res.json({ message: 'Deposit rejected and removed' });
});

// Mark withdrawal as sent (pet traded back in PS99)
app.post('/api/mm/sent', mmAuth, async (req, res) => {
  const { itemId } = req.body;
  const item = await Item.findByIdAndUpdate(itemId, { status: 'withdrawn' }, { new: true });
  if (!item) return res.status(404).json({ error: 'Item not found' });
  broadcast({ type: 'inventory_update', userId: item.ownerId.toString() });
  res.json({ message: `✅ Marked as sent to ${item.ownerName}` });
});

// Pet value lookup
app.get('/api/pet-value', async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const rap = await getRAP();
  const match = findPet(rap, name);
  if (!match) return res.status(404).json({ error: 'Pet not found' });
  res.json({ name: match.configData.id, value: match.value || 0, image: petImg(match.configData.id) });
});

server.listen(PORT, () => console.log(`SpinZone running on port ${PORT}`));
