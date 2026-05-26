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
const MIDDLEMAN_SECRET = process.env.MIDDLEMAN_SECRET || 'middleman_admin_pass';
const MIDDLEMAN_ROBLOX = 'SpinZone99';
const MONGO_URI = process.env.MONGO_URI;

// ---- MONGODB CONNECTION ----
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => { console.error('❌ MongoDB connection error:', err); process.exit(1); });

// ---- SCHEMAS ----
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  robloxUsername: { type: String, default: null },
  robloxId: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
});

const depositSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  username: { type: String, required: true },
  petName: { type: String, required: true },
  petValue: { type: Number, required: true },
  petImage: { type: String },
  status: { type: String, enum: ['pending', 'confirmed', 'in_flip', 'won', 'returned', 'sent', 'cancelled'], default: 'pending' },
  createdAt: { type: Date, default: Date.now },
});

const flipSchema = new mongoose.Schema({
  creatorDepositId: { type: mongoose.Schema.Types.ObjectId, ref: 'Deposit', required: true },
  joinerDepositId: { type: mongoose.Schema.Types.ObjectId, ref: 'Deposit', default: null },
  status: { type: String, enum: ['waiting', 'active', 'done', 'cancelled'], default: 'waiting' },
  winnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  winnerUsername: { type: String, default: null },
  finishedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});

const verificationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  code: { type: String, required: true },
  robloxUsername: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, expires: 600 }, // auto-delete after 10 minutes
});

const User = mongoose.model('User', userSchema);
const Deposit = mongoose.model('Deposit', depositSchema);
const Flip = mongoose.model('Flip', flipSchema);
const Verification = mongoose.model('Verification', verificationSchema);

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// ---- RAP CACHE ----
let rapCache = null;
let rapCacheTime = 0;

async function getRAP() {
  const now = Date.now();
  if (rapCache && now - rapCacheTime < 4 * 60 * 60 * 1000) return rapCache;
  try {
    const res = await fetch('https://ps99.biggamesapi.io/api/rap', {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
    });
    const data = await res.json();
    rapCache = data.data || [];
    rapCacheTime = now;
    return rapCache;
  } catch (e) {
    console.error('Failed to fetch RAP:', e);
    return rapCache || [];
  }
}
getRAP();

// ---- PET HELPERS ----
function normalize(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}
function findPet(rap, name) {
  const exact = name.toLowerCase().trim();
  const fuzzy = normalize(name);
  return rap.find(p => {
    const id = p.configData?.id;
    if (!id) return false;
    return id.toLowerCase() === exact || normalize(id) === fuzzy;
  });
}
function petImageUrl(petName) {
  return `https://biggamesapi.io/image/${encodeURIComponent(petName)}`;
}

// ---- WEBSOCKET ----
const clients = new Set();
wss.on('connection', async (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'deposits', deposits: await getPublicDeposits() }));
  ws.send(JSON.stringify({ type: 'flips', flips: await getPublicFlips() }));
  ws.on('close', () => clients.delete(ws));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

async function getPublicDeposits() {
  const deps = await Deposit.find({ status: { $in: ['confirmed', 'pending'] } }).lean();
  return deps.map(d => ({
    id: d._id.toString(),
    userId: d.userId.toString(),
    username: d.username,
    petName: d.petName,
    petValue: d.petValue,
    petImage: d.petImage,
    status: d.status,
    createdAt: d.createdAt,
  }));
}

async function getPublicFlips() {
  const cutoff = new Date(Date.now() - 15000);
  const flips = await Flip.find({
    $or: [
      { status: { $ne: 'done' } },
      { status: 'done', finishedAt: { $gte: cutoff } }
    ]
  }).lean();

  return await Promise.all(flips.map(async f => {
    const cd = f.creatorDepositId ? await Deposit.findById(f.creatorDepositId).lean() : null;
    const jd = f.joinerDepositId ? await Deposit.findById(f.joinerDepositId).lean() : null;
    return {
      id: f._id.toString(),
      status: f.status,
      creator: cd ? { username: cd.username, petName: cd.petName, petValue: cd.petValue, petImage: cd.petImage } : null,
      joiner: jd ? { username: jd.username, petName: jd.petName, petValue: jd.petValue, petImage: jd.petImage } : null,
      winnerId: f.winnerId?.toString() || null,
      winnerUsername: f.winnerUsername || null,
      finishedAt: f.finishedAt || null,
    };
  }));
}

// ---- JWT MIDDLEWARE ----
function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ---- AUTH ROUTES ----
app.get('/api/test', (req, res) => res.json({ message: 'SpinZone server is running!' }));

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
  const existing = await User.findOne({ username });
  if (existing) return res.status(400).json({ error: 'Username already taken' });
  const hashedPassword = await bcrypt.hash(password, 10);
  const user = await User.create({ username, password: hashedPassword });
  res.json({ message: 'Account created successfully!' });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
  const user = await User.findOne({ username });
  if (!user) return res.status(400).json({ error: 'User not found' });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(400).json({ error: 'Incorrect password' });
  const token = jwt.sign({ id: user._id.toString(), username: user.username }, SECRET, { expiresIn: '7d' });
  res.json({ token, username: user.username });
});

app.get('/api/profile', authenticateToken, async (req, res) => {
  const user = await User.findById(req.user.id).lean();
  if (!user) return res.status(404).json({ error: 'User not found' });
  const myDeposits = await Deposit.find({ userId: req.user.id }).lean();
  res.json({
    username: user.username,
    robloxUsername: user.robloxUsername || null,
    robloxId: user.robloxId || null,
    deposits: myDeposits,
  });
});

// ---- ROBLOX VERIFY ----
app.post('/api/roblox/generate-code', authenticateToken, async (req, res) => {
  const { code, robloxUsername } = req.body;
  if (!code || !robloxUsername) return res.status(400).json({ error: 'Missing fields' });
  await Verification.findOneAndUpdate(
    { userId: req.user.id },
    { userId: req.user.id, code, robloxUsername },
    { upsert: true, new: true }
  );
  res.json({ message: 'Code saved' });
});

app.post('/api/roblox/verify', authenticateToken, async (req, res) => {
  const { robloxUsername, code } = req.body;
  const pending = await Verification.findOne({ userId: req.user.id });
  if (!pending || pending.code !== code) return res.status(400).json({ error: 'Invalid or expired code.' });
  try {
    const searchRes = await fetch('https://users.roblox.com/v1/usernames/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify({ usernames: [robloxUsername], excludeBannedUsers: true })
    });
    const searchData = await searchRes.json();
    if (!searchData.data || searchData.data.length === 0) return res.status(400).json({ error: 'Roblox username not found.' });
    const robloxId = searchData.data[0].id;
    const profileRes = await fetch(`https://users.roblox.com/v1/users/${robloxId}`, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
    });
    const profileData = await profileRes.json();
    if (!(profileData.description || '').includes(code)) return res.status(400).json({ error: 'Code not found in your Roblox profile description.' });
    await User.findByIdAndUpdate(req.user.id, { robloxUsername, robloxId: robloxId.toString() });
    await Verification.deleteOne({ userId: req.user.id });
    res.json({ message: 'Roblox account verified!', robloxUsername, robloxId });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reach Roblox API.' });
  }
});

// ---- PET VALUE LOOKUP ----
app.get('/api/pet-value', async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'Pet name required' });
  const rap = await getRAP();
  const match = findPet(rap, name);
  if (!match) return res.status(404).json({ error: 'Pet not found. Check the name and try again.' });
  res.json({ name: match.configData.id, value: match.value || 0, image: petImageUrl(match.configData.id) });
});

// ---- DEPOSIT ROUTES ----

// Player just clicks "Request Deposit" — no pet name needed yet
app.post('/api/deposits/request', authenticateToken, async (req, res) => {
  const existing = await Deposit.findOne({ userId: req.user.id, status: { $in: ['pending', 'confirmed', 'in_flip'] } });
  if (existing) return res.status(400).json({ error: 'You already have an active deposit. Wait for it to be resolved first.' });

  const deposit = await Deposit.create({
    userId: req.user.id,
    username: req.user.username,
    petName: 'Pending',
    petValue: 0,
    petImage: '',
    status: 'pending',
  });

  broadcast({ type: 'deposits', deposits: await getPublicDeposits() });
  res.json({
    message: 'Deposit request created!',
    deposit: { ...deposit.toObject(), id: deposit._id.toString() },
    instructions: `Now trade your pet to "${MIDDLEMAN_ROBLOX}" in PS99. The middleman will confirm and fill in your pet details.`
  });
});

// Middleman fills in the pet for a pending deposit
app.post('/api/admin/deposits/fill', async (req, res) => {
  const { secret, depositId, petName } = req.body;
  if (secret !== MIDDLEMAN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  if (!depositId || !petName) return res.status(400).json({ error: 'depositId and petName required' });

  const deposit = await Deposit.findById(depositId);
  if (!deposit) return res.status(404).json({ error: 'Deposit not found.' });
  if (deposit.status !== 'pending') return res.status(400).json({ error: 'Deposit is not pending.' });

  const rap = await getRAP();
  const match = findPet(rap, petName);
  if (!match) return res.status(404).json({ error: `Pet "${petName}" not found in PS99 RAP data.` });
  if (!match.value || match.value === 0) return res.status(400).json({ error: 'This pet has no RAP value.' });

  deposit.petName = match.configData.id;
  deposit.petValue = match.value;
  deposit.petImage = petImageUrl(match.configData.id);
  deposit.status = 'confirmed';
  await deposit.save();

  broadcast({ type: 'deposits', deposits: await getPublicDeposits() });
  broadcast({ type: 'deposit_confirmed', depositId: deposit._id.toString(), username: deposit.username, petName: deposit.petName });
  res.json({ message: `Confirmed deposit for ${deposit.username} — ${deposit.petName} (${deposit.petValue.toLocaleString()} RAP)`, deposit: { ...deposit.toObject(), id: deposit._id.toString() } });
});

app.get('/api/deposits/mine', authenticateToken, async (req, res) => {
  const mine = await Deposit.find({ userId: req.user.id }).lean();
  res.json(mine.map(d => ({ ...d, id: d._id.toString() })));
});

app.post('/api/deposits/cancel', authenticateToken, async (req, res) => {
  const { depositId } = req.body;
  const deposit = await Deposit.findOne({ _id: depositId, userId: req.user.id });
  if (!deposit) return res.status(404).json({ error: 'Deposit not found.' });
  if (deposit.status !== 'pending') return res.status(400).json({ error: 'Can only cancel pending deposits.' });
  deposit.status = 'returned';
  await deposit.save();
  broadcast({ type: 'deposits', deposits: await getPublicDeposits() });
  res.json({ message: 'Deposit cancelled.' });
});

// ---- FLIP ROUTES ----
app.post('/api/flips/create', authenticateToken, async (req, res) => {
  const { depositId } = req.body;
  const deposit = await Deposit.findOne({ _id: depositId, userId: req.user.id, status: 'confirmed' });
  if (!deposit) return res.status(404).json({ error: 'Confirmed deposit not found.' });

  const existingFlip = await Flip.findOne({ creatorDepositId: depositId, status: 'waiting' });
  if (existingFlip) return res.status(400).json({ error: 'This deposit is already in a flip.' });

  const flip = await Flip.create({ creatorDepositId: depositId, status: 'waiting' });
  deposit.status = 'in_flip';
  await deposit.save();

  broadcast({ type: 'deposits', deposits: await getPublicDeposits() });
  broadcast({ type: 'flips', flips: await getPublicFlips() });
  res.json({ message: 'Flip created!', flip: { ...flip.toObject(), id: flip._id.toString() } });
});

app.post('/api/flips/join', authenticateToken, async (req, res) => {
  const { flipId, depositId } = req.body;

  const flip = await Flip.findById(flipId);
  if (!flip) return res.status(404).json({ error: 'Flip not found.' });
  if (flip.status !== 'waiting') return res.status(400).json({ error: 'Flip no longer available.' });

  const creatorDeposit = await Deposit.findById(flip.creatorDepositId);
  if (creatorDeposit?.userId.toString() === req.user.id) return res.status(400).json({ error: 'Cannot join your own flip.' });

  const joinerDeposit = await Deposit.findOne({ _id: depositId, userId: req.user.id, status: 'confirmed' });
  if (!joinerDeposit) return res.status(404).json({ error: 'Confirmed deposit not found.' });

  const minValue = creatorDeposit.petValue * 0.9;
  const maxValue = creatorDeposit.petValue * 1.1;
  if (joinerDeposit.petValue < minValue || joinerDeposit.petValue > maxValue) {
    return res.status(400).json({
      error: `Your pet value (${joinerDeposit.petValue.toLocaleString()}) must be within 10% of ${creatorDeposit.petValue.toLocaleString()}. Range: ${Math.floor(minValue).toLocaleString()} – ${Math.ceil(maxValue).toLocaleString()}.`
    });
  }

  const creatorWins = Math.random() < 0.5;
  const winnerDeposit = creatorWins ? creatorDeposit : joinerDeposit;
  const loserDeposit = creatorWins ? joinerDeposit : creatorDeposit;

  flip.status = 'done';
  flip.joinerDepositId = depositId;
  flip.winnerId = winnerDeposit.userId;
  flip.winnerUsername = winnerDeposit.username;
  flip.finishedAt = new Date();
  await flip.save();

  // Both pets transfer to the winner as confirmed deposits (ready to flip again)
  creatorDeposit.status = 'confirmed';
  creatorDeposit.userId = winnerDeposit.userId;
  creatorDeposit.username = winnerDeposit.username;
  await creatorDeposit.save();

  joinerDeposit.status = 'confirmed';
  joinerDeposit.userId = winnerDeposit.userId;
  joinerDeposit.username = winnerDeposit.username;
  await joinerDeposit.save();

  broadcast({ type: 'deposits', deposits: await getPublicDeposits() });
  broadcast({ type: 'flips', flips: await getPublicFlips() });
  broadcast({ type: 'flip_result', flipId: flip._id.toString(), winnerUsername: flip.winnerUsername, winnerId: flip.winnerId?.toString() });

  res.json({ message: 'Flip complete!', winnerUsername: flip.winnerUsername });

  setTimeout(async () => {
    broadcast({ type: 'flips', flips: await getPublicFlips() });
  }, 15000);
});

app.post('/api/flips/cancel', authenticateToken, async (req, res) => {
  const { flipId } = req.body;
  const flip = await Flip.findOne({ _id: flipId, status: 'waiting' });
  if (!flip) return res.status(404).json({ error: 'Flip not found.' });

  const deposit = await Deposit.findOne({ _id: flip.creatorDepositId, userId: req.user.id });
  if (!deposit) return res.status(403).json({ error: 'Not your flip.' });

  flip.status = 'cancelled';
  deposit.status = 'confirmed';
  await flip.save();
  await deposit.save();

  broadcast({ type: 'deposits', deposits: await getPublicDeposits() });
  broadcast({ type: 'flips', flips: await getPublicFlips() });
  res.json({ message: 'Flip cancelled.' });
});

// ---- MIDDLEMAN ROUTES ----
app.post('/api/admin/deposits/create', async (req, res) => {
  const { secret, username: targetUsername, petName } = req.body;
  if (secret !== MIDDLEMAN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  if (!targetUsername || !petName) return res.status(400).json({ error: 'Username and pet name required' });

  const user = await User.findOne({ username: { $regex: new RegExp(`^${targetUsername}$`, 'i') } });
  if (!user) return res.status(404).json({ error: `No SpinZone account found for "${targetUsername}". They must sign up first.` });

  const existing = await Deposit.findOne({ userId: user._id, status: { $in: ['pending', 'confirmed', 'in_flip'] } });
  if (existing) return res.status(400).json({ error: `${targetUsername} already has an active deposit (${existing.petName}).` });

  const rap = await getRAP();
  const match = findPet(rap, petName);
  if (!match) return res.status(404).json({ error: `Pet "${petName}" not found in PS99 RAP data.` });
  if (!match.value || match.value === 0) return res.status(400).json({ error: 'This pet has no RAP value.' });

  const deposit = await Deposit.create({
    userId: user._id,
    username: user.username,
    petName: match.configData.id,
    petValue: match.value,
    petImage: petImageUrl(match.configData.id),
    status: 'confirmed',
  });

  broadcast({ type: 'deposits', deposits: await getPublicDeposits() });
  broadcast({ type: 'deposit_confirmed', depositId: deposit._id.toString(), username: deposit.username, petName: deposit.petName });
  res.json({ message: `Deposit created and confirmed for ${user.username} — ${deposit.petName} (${deposit.petValue.toLocaleString()} RAP)`, deposit: { ...deposit.toObject(), id: deposit._id.toString() } });
});

app.post('/api/admin/deposits', async (req, res) => {
  const { secret } = req.body;
  if (secret !== MIDDLEMAN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const all = await Deposit.find().lean();
  res.json(all.map(d => ({ ...d, id: d._id.toString() })));
});

app.post('/api/admin/deposits/confirm', async (req, res) => {
  const { secret, depositId } = req.body;
  if (secret !== MIDDLEMAN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const deposit = await Deposit.findById(depositId);
  if (!deposit) return res.status(404).json({ error: 'Deposit not found.' });
  if (deposit.status !== 'pending') return res.status(400).json({ error: 'Deposit is not pending.' });
  deposit.status = 'confirmed';
  await deposit.save();
  broadcast({ type: 'deposits', deposits: await getPublicDeposits() });
  broadcast({ type: 'deposit_confirmed', depositId, username: deposit.username, petName: deposit.petName });
  res.json({ message: `Confirmed deposit for ${deposit.username} — ${deposit.petName}` });
});

app.post('/api/admin/deposits/return', async (req, res) => {
  const { secret, depositId } = req.body;
  if (secret !== MIDDLEMAN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const deposit = await Deposit.findById(depositId);
  if (!deposit) return res.status(404).json({ error: 'Deposit not found.' });
  deposit.status = 'returned';
  await deposit.save();
  broadcast({ type: 'deposits', deposits: await getPublicDeposits() });
  res.json({ message: `Deposit marked as returned for ${deposit.username}` });
});

app.post('/api/admin/deposits/sent', async (req, res) => {
  const { secret, depositId } = req.body;
  if (secret !== MIDDLEMAN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const deposit = await Deposit.findById(depositId);
  if (!deposit) return res.status(404).json({ error: 'Deposit not found.' });
  deposit.status = 'sent';
  await deposit.save();
  broadcast({ type: 'deposits', deposits: await getPublicDeposits() });
  res.json({ message: `Deposit marked as sent to ${deposit.username}` });
});

server.listen(PORT, () => {
  console.log(`SpinZone server running at http://localhost:${PORT}`);
});
