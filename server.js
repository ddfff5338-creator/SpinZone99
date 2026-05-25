require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const http = require('http');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'spinzone_secret_key';
const MIDDLEMAN_SECRET = process.env.MIDDLEMAN_SECRET || 'middleman_admin_pass';
const MIDDLEMAN_ROBLOX = 'SpinZone99';

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// ---- IN-MEMORY STORES ----
const users = [];
const pendingVerifications = {};

// deposits: { id, userId, username, petName, petValue, petImage, status: 'pending'|'confirmed'|'in_flip'|'won'|'returned', createdAt }
const deposits = [];

// flips: { id, creatorDepositId, joinerDepositId, status: 'waiting'|'active'|'done', winnerId, winnerUsername, finishedAt }
const flips = [];

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

// ---- PET NAME FUZZY MATCH ----
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
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'deposits', deposits: getPublicDeposits() }));
  ws.send(JSON.stringify({ type: 'flips', flips: getPublicFlips() }));
  ws.on('close', () => clients.delete(ws));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

function getPublicDeposits() {
  return deposits
    .filter(d => d.status === 'confirmed' || d.status === 'pending')
    .map(d => ({
      id: d.id,
      userId: d.userId,
      username: d.username,
      petName: d.petName,
      petValue: d.petValue,
      petImage: d.petImage,
      status: d.status,
      createdAt: d.createdAt,
    }));
}

function getPublicFlips() {
  return flips
    .filter(f => f.status !== 'done' || Date.now() - f.finishedAt < 15000)
    .map(f => {
      const cd = deposits.find(d => d.id === f.creatorDepositId);
      const jd = deposits.find(d => d.id === f.joinerDepositId);
      return {
        id: f.id,
        status: f.status,
        creator: cd ? { username: cd.username, petName: cd.petName, petValue: cd.petValue, petImage: cd.petImage } : null,
        joiner: jd ? { username: jd.username, petName: jd.petName, petValue: jd.petValue, petImage: jd.petImage } : null,
        winnerId: f.winnerId || null,
        winnerUsername: f.winnerUsername || null,
        finishedAt: f.finishedAt || null,
      };
    });
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

function authenticateMiddleman(req, res, next) {
  const { secret } = req.body;
  if (secret !== MIDDLEMAN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  next();
}

// ---- AUTH ROUTES ----
app.get('/api/test', (req, res) => res.json({ message: 'SpinZone server is running!' }));

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
  if (users.find(u => u.username === username)) return res.status(400).json({ error: 'Username already taken' });
  const hashedPassword = await bcrypt.hash(password, 10);
  users.push({ id: users.length + 1, username, password: hashedPassword });
  res.json({ message: 'Account created successfully!' });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
  const user = users.find(u => u.username === username);
  if (!user) return res.status(400).json({ error: 'User not found' });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(400).json({ error: 'Incorrect password' });
  const token = jwt.sign({ id: user.id, username: user.username }, SECRET, { expiresIn: '7d' });
  res.json({ token, username: user.username });
});

app.get('/api/profile', authenticateToken, (req, res) => {
  const user = users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const myDeposits = deposits.filter(d => d.userId === req.user.id);
  res.json({ username: user.username, deposits: myDeposits });
});

// ---- ROBLOX VERIFY ----
app.post('/api/roblox/generate-code', authenticateToken, (req, res) => {
  const { code, robloxUsername } = req.body;
  if (!code || !robloxUsername) return res.status(400).json({ error: 'Missing fields' });
  pendingVerifications[req.user.id] = { code, robloxUsername };
  res.json({ message: 'Code saved' });
});

app.post('/api/roblox/verify', authenticateToken, async (req, res) => {
  const { robloxUsername, code } = req.body;
  const pending = pendingVerifications[req.user.id];
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
    const user = users.find(u => u.id === req.user.id);
    user.robloxUsername = robloxUsername;
    user.robloxId = robloxId;
    delete pendingVerifications[req.user.id];
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

// Player requests a deposit (creates pending deposit with instructions)
app.post('/api/deposits/request', authenticateToken, async (req, res) => {
  const { petName } = req.body;
  if (!petName) return res.status(400).json({ error: 'Pet name required' });

  const rap = await getRAP();
  const match = findPet(rap, petName);
  if (!match) return res.status(404).json({ error: `Pet "${petName}" not found in PS99 RAP data.` });
  if (!match.value || match.value === 0) return res.status(400).json({ error: 'This pet has no RAP value.' });

  // Check if user already has a pending/confirmed deposit for this pet
  const existing = deposits.find(d => d.userId === req.user.id && (d.status === 'pending' || d.status === 'confirmed' || d.status === 'in_flip'));
  if (existing) return res.status(400).json({ error: 'You already have an active deposit. Wait for it to be resolved first.' });

  const deposit = {
    id: Date.now().toString(),
    userId: req.user.id,
    username: req.user.username,
    petName: match.configData.id,
    petValue: match.value,
    petImage: petImageUrl(match.configData.id),
    status: 'pending',
    createdAt: Date.now(),
  };

  deposits.push(deposit);
  broadcast({ type: 'deposits', deposits: getPublicDeposits() });
  res.json({
    message: 'Deposit request created!',
    deposit,
    instructions: `Trade "${match.configData.id}" to the Roblox user "${MIDDLEMAN_ROBLOX}" in PS99. Once received, your pet will appear in the lobby.`
  });
});

// Get user's own deposits
app.get('/api/deposits/mine', authenticateToken, (req, res) => {
  const mine = deposits.filter(d => d.userId === req.user.id);
  res.json(mine);
});

// Cancel a pending deposit (before middleman confirms)
app.post('/api/deposits/cancel', authenticateToken, (req, res) => {
  const { depositId } = req.body;
  const deposit = deposits.find(d => d.id === depositId && d.userId === req.user.id);
  if (!deposit) return res.status(404).json({ error: 'Deposit not found.' });
  if (deposit.status !== 'pending') return res.status(400).json({ error: 'Can only cancel pending deposits.' });
  deposit.status = 'returned';
  broadcast({ type: 'deposits', deposits: getPublicDeposits() });
  res.json({ message: 'Deposit cancelled.' });
});

// ---- FLIP ROUTES ----

// Create flip from a confirmed deposit
app.post('/api/flips/create', authenticateToken, (req, res) => {
  const { depositId } = req.body;
  const deposit = deposits.find(d => d.id === depositId && d.userId === req.user.id && d.status === 'confirmed');
  if (!deposit) return res.status(404).json({ error: 'Confirmed deposit not found.' });

  const existingFlip = flips.find(f => f.creatorDepositId === depositId && f.status === 'waiting');
  if (existingFlip) return res.status(400).json({ error: 'This deposit is already in a flip.' });

  const flip = {
    id: Date.now().toString(),
    creatorDepositId: depositId,
    joinerDepositId: null,
    status: 'waiting',
    createdAt: Date.now(),
  };

  deposit.status = 'in_flip';
  flips.push(flip);
  broadcast({ type: 'deposits', deposits: getPublicDeposits() });
  broadcast({ type: 'flips', flips: getPublicFlips() });
  res.json({ message: 'Flip created!', flip });
});

// Join a flip with your own confirmed deposit
app.post('/api/flips/join', authenticateToken, (req, res) => {
  const { flipId, depositId } = req.body;

  const flip = flips.find(f => f.id === flipId);
  if (!flip) return res.status(404).json({ error: 'Flip not found.' });
  if (flip.status !== 'waiting') return res.status(400).json({ error: 'Flip no longer available.' });

  const creatorDeposit = deposits.find(d => d.id === flip.creatorDepositId);
  if (creatorDeposit?.userId === req.user.id) return res.status(400).json({ error: 'Cannot join your own flip.' });

  const joinerDeposit = deposits.find(d => d.id === depositId && d.userId === req.user.id && d.status === 'confirmed');
  if (!joinerDeposit) return res.status(404).json({ error: 'Confirmed deposit not found.' });

  // Value check within 10%
  const minValue = creatorDeposit.petValue * 0.9;
  const maxValue = creatorDeposit.petValue * 1.1;
  if (joinerDeposit.petValue < minValue || joinerDeposit.petValue > maxValue) {
    return res.status(400).json({
      error: `Your pet value (${joinerDeposit.petValue.toLocaleString()}) must be within 10% of ${creatorDeposit.petValue.toLocaleString()}. Range: ${Math.floor(minValue).toLocaleString()} – ${Math.ceil(maxValue).toLocaleString()}.`
    });
  }

  const creatorWins = Math.random() < 0.5;
  flip.status = 'done';
  flip.joinerDepositId = depositId;
  flip.winnerId = creatorWins ? creatorDeposit.userId : joinerDeposit.userId;
  flip.winnerUsername = creatorWins ? creatorDeposit.username : joinerDeposit.username;
  flip.finishedAt = Date.now();

  joinerDeposit.status = 'in_flip';
  creatorDeposit.status = creatorWins ? 'won' : 'returned';
  joinerDeposit.status = creatorWins ? 'returned' : 'won';

  broadcast({ type: 'deposits', deposits: getPublicDeposits() });
  broadcast({ type: 'flips', flips: getPublicFlips() });
  broadcast({ type: 'flip_result', flipId: flip.id, winnerUsername: flip.winnerUsername, winnerId: flip.winnerId });

  res.json({ message: 'Flip complete!', winnerUsername: flip.winnerUsername });

  setTimeout(() => {
    const idx = flips.indexOf(flip);
    if (idx !== -1) flips.splice(idx, 1);
    broadcast({ type: 'flips', flips: getPublicFlips() });
  }, 15000);
});

// Cancel a waiting flip (return deposit to confirmed)
app.post('/api/flips/cancel', authenticateToken, (req, res) => {
  const { flipId } = req.body;
  const flip = flips.find(f => f.id === flipId && f.status === 'waiting');
  if (!flip) return res.status(404).json({ error: 'Flip not found.' });
  const deposit = deposits.find(d => d.id === flip.creatorDepositId && d.userId === req.user.id);
  if (!deposit) return res.status(403).json({ error: 'Not your flip.' });

  flip.status = 'cancelled';
  deposit.status = 'confirmed';
  const idx = flips.indexOf(flip);
  if (idx !== -1) flips.splice(idx, 1);

  broadcast({ type: 'deposits', deposits: getPublicDeposits() });
  broadcast({ type: 'flips', flips: getPublicFlips() });
  res.json({ message: 'Flip cancelled.' });
});

// ---- MIDDLEMAN DASHBOARD ROUTES ----

// Middleman creates a deposit on behalf of a player (after receiving the trade in-game)
app.post('/api/admin/deposits/create', async (req, res) => {
  const { secret, username: targetUsername, petName } = req.body;
  if (secret !== MIDDLEMAN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  if (!targetUsername || !petName) return res.status(400).json({ error: 'Username and pet name required' });

  // Find the user account
  const user = users.find(u => u.username.toLowerCase() === targetUsername.toLowerCase());
  if (!user) return res.status(404).json({ error: `No SpinZone account found for "${targetUsername}". They must sign up first.` });

  // Check for existing active deposit
  const existing = deposits.find(d => d.userId === user.id && ['pending', 'confirmed', 'in_flip'].includes(d.status));
  if (existing) return res.status(400).json({ error: `${targetUsername} already has an active deposit (${existing.petName}).` });

  // Look up pet RAP value
  const rap = await getRAP();
  const match = findPet(rap, petName);
  if (!match) return res.status(404).json({ error: `Pet "${petName}" not found in PS99 RAP data.` });
  if (!match.value || match.value === 0) return res.status(400).json({ error: 'This pet has no RAP value.' });

  const deposit = {
    id: Date.now().toString(),
    userId: user.id,
    username: user.username,
    petName: match.configData.id,
    petValue: match.value,
    petImage: petImageUrl(match.configData.id),
    status: 'confirmed', // Already confirmed — middleman has the pet in hand
    createdAt: Date.now(),
  };

  deposits.push(deposit);
  broadcast({ type: 'deposits', deposits: getPublicDeposits() });
  broadcast({ type: 'deposit_confirmed', depositId: deposit.id, username: deposit.username, petName: deposit.petName });
  res.json({ message: `Deposit created and confirmed for ${user.username} — ${deposit.petName} (${deposit.petValue.toLocaleString()} RAP)`, deposit });
});

// Get all pending deposits (for middleman to confirm)
app.post('/api/admin/deposits', (req, res) => {
  const { secret } = req.body;
  if (secret !== MIDDLEMAN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  res.json(deposits);
});

// Confirm a deposit (middleman received the pet in-game)
app.post('/api/admin/deposits/confirm', (req, res) => {
  const { secret, depositId } = req.body;
  if (secret !== MIDDLEMAN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const deposit = deposits.find(d => d.id === depositId);
  if (!deposit) return res.status(404).json({ error: 'Deposit not found.' });
  if (deposit.status !== 'pending') return res.status(400).json({ error: 'Deposit is not pending.' });
  deposit.status = 'confirmed';
  broadcast({ type: 'deposits', deposits: getPublicDeposits() });
  broadcast({ type: 'deposit_confirmed', depositId, username: deposit.username, petName: deposit.petName });
  res.json({ message: `Confirmed deposit for ${deposit.username} — ${deposit.petName}` });
});

// Return a deposit (middleman trades pet back)
app.post('/api/admin/deposits/return', (req, res) => {
  const { secret, depositId } = req.body;
  if (secret !== MIDDLEMAN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const deposit = deposits.find(d => d.id === depositId);
  if (!deposit) return res.status(404).json({ error: 'Deposit not found.' });
  deposit.status = 'returned';
  broadcast({ type: 'deposits', deposits: getPublicDeposits() });
  res.json({ message: `Deposit marked as returned for ${deposit.username}` });
});

// Mark a won deposit as sent (middleman traded pet to winner)
app.post('/api/admin/deposits/sent', (req, res) => {
  const { secret, depositId } = req.body;
  if (secret !== MIDDLEMAN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const deposit = deposits.find(d => d.id === depositId);
  if (!deposit) return res.status(404).json({ error: 'Deposit not found.' });
  deposit.status = 'sent';
  broadcast({ type: 'deposits', deposits: getPublicDeposits() });
  res.json({ message: `Deposit marked as sent to ${deposit.username}` });
});

server.listen(PORT, () => {
  console.log(`SpinZone server running at http://localhost:${PORT}`);
});
