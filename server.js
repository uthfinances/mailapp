// MailApp — serveur unique (Express + SQLite + node-cron + nodemailer)
// Toute la logique backend est volontairement regroupée dans ce seul fichier
// pour simplifier le déploiement (moins de fichiers à créer manuellement).
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const nodemailer = require('nodemailer');
const cron = require('node-cron');

// ---------------------------------------------------------------------------
// BASE DE DONNEES
// ---------------------------------------------------------------------------
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS recipients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  unsubscribed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS list_recipients (
  list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  recipient_id INTEGER NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
  PRIMARY KEY (list_id, recipient_id)
);
CREATE TABLE IF NOT EXISTS email_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  from_email TEXT NOT NULL,
  config_json TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  connection_id INTEGER REFERENCES email_connections(id),
  list_id INTEGER REFERENCES lists(id),
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  use_bcc INTEGER NOT NULL DEFAULT 1,
  batch_size INTEGER NOT NULL DEFAULT 20,
  delay_between_batches_seconds INTEGER NOT NULL DEFAULT 30,
  schedule_type TEXT NOT NULL DEFAULT 'once',
  schedule_time TEXT,
  schedule_date TEXT,
  schedule_days TEXT,
  schedule_cron TEXT,
  timezone TEXT NOT NULL DEFAULT 'Europe/Paris',
  end_date TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  next_run_at TEXT,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
  campaign_name TEXT,
  batch_label TEXT,
  recipients_count INTEGER,
  status TEXT NOT NULL,
  error TEXT,
  executed_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// Création automatique du compte administrateur au démarrage si absent
(function ensureAdmin() {
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@example.com';
  const adminPassword = process.env.ADMIN_PASSWORD || 'ChangeMoi123!';
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);
  if (!existing) {
    const hash = bcrypt.hashSync(adminPassword, 12);
    db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(adminEmail, hash);
    console.log(`✅ Compte administrateur créé : ${adminEmail}`);
  }
})();

// ---------------------------------------------------------------------------
// SERVICE E-MAIL
// ---------------------------------------------------------------------------
function createSmtpTransport() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = process.env.SMTP_SECURE === 'true';
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    throw new Error('Configuration SMTP incomplète. Renseignez SMTP_HOST, SMTP_USER et SMTP_PASS.');
  }
  return nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
}

async function sendEmail(transport, { fromEmail, fromName, to, bcc, subject, html }) {
  try {
    const info = await transport.sendMail({
      from: fromName ? `"${fromName}" <${fromEmail}>` : fromEmail,
      to: to && to.length > 0 ? to : fromEmail,
      bcc: bcc && bcc.length > 0 ? bcc : undefined,
      subject,
      html,
    });
    return { success: true, messageId: info.messageId };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
}

// ---------------------------------------------------------------------------
// PLANIFICATEUR / EXECUTION DES CAMPAGNES (groupes + CCI)
// ---------------------------------------------------------------------------
let emailsSentThisHour = 0;
let hourWindowStart = Date.now();
function withinHourlyLimit() {
  const maxPerHour = Number(process.env.MAX_EMAILS_PER_HOUR || 200);
  const now = Date.now();
  if (now - hourWindowStart > 60 * 60 * 1000) {
    hourWindowStart = now;
    emailsSentThisHour = 0;
  }
  return emailsSentThisHour < maxPerHour;
}
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function logHistory(entry) {
  db.prepare(
    `INSERT INTO history (campaign_id, campaign_name, batch_label, recipients_count, status, error)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(entry.campaign_id, entry.campaign_name, entry.batch_label, entry.recipients_count, entry.status, entry.error || null);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCampaign(campaignId, manualTest = false) {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
  if (!campaign) return;
  if (!campaign.is_active && !manualTest) return;

  const connection = campaign.connection_id
    ? db.prepare('SELECT * FROM email_connections WHERE id = ?').get(campaign.connection_id)
    : null;

  const recipients = campaign.list_id
    ? db
        .prepare(
          `SELECT r.email FROM recipients r
           JOIN list_recipients lr ON lr.recipient_id = r.id
           WHERE lr.list_id = ? AND r.unsubscribed = 0`
        )
        .all(campaign.list_id)
    : [];

  if (recipients.length === 0) {
    logHistory({
      campaign_id: campaign.id, campaign_name: campaign.name, batch_label: 'N/A',
      recipients_count: 0, status: 'echec', error: 'Aucun destinataire actif dans la liste associée.',
    });
    return;
  }

  let transport;
  try {
    transport = createSmtpTransport();
  } catch (err) {
    logHistory({
      campaign_id: campaign.id, campaign_name: campaign.name, batch_label: 'N/A',
      recipients_count: recipients.length, status: 'echec', error: err.message,
    });
    return;
  }

  const batchSize = campaign.batch_size || Number(process.env.MAX_RECIPIENTS_PER_BATCH || 20);
  const delaySeconds = campaign.delay_between_batches_seconds ?? Number(process.env.MIN_DELAY_BETWEEN_BATCHES_SECONDS || 30);
  const groups = chunk(recipients.map((r) => r.email), batchSize);
  const fromEmail = (connection && connection.from_email) || process.env.SMTP_USER || '';

  let sentTotal = 0, failedTotal = 0;

  for (let i = 0; i < groups.length; i++) {
    if (!withinHourlyLimit()) {
      logHistory({
        campaign_id: campaign.id, campaign_name: campaign.name,
        batch_label: `Groupe ${i + 1}/${groups.length}`, recipients_count: groups[i].length,
        status: 'annule', error: "Limite horaire d'envoi atteinte (MAX_EMAILS_PER_HOUR).",
      });
      continue;
    }
    const group = groups[i];
    const result = await sendEmail(transport, {
      fromEmail,
      to: campaign.use_bcc ? [] : group,
      bcc: campaign.use_bcc ? group : [],
      subject: campaign.subject,
      html: campaign.body_html,
    });
    emailsSentThisHour += group.length;

    if (result.success) {
      sentTotal += group.length;
      logHistory({
        campaign_id: campaign.id, campaign_name: campaign.name,
        batch_label: `Groupe ${i + 1}/${groups.length}`, recipients_count: group.length, status: 'envoye',
      });
    } else {
      failedTotal += group.length;
      logHistory({
        campaign_id: campaign.id, campaign_name: campaign.name,
        batch_label: `Groupe ${i + 1}/${groups.length}`, recipients_count: group.length,
        status: 'echec', error: result.error,
      });
    }
    if (i < groups.length - 1 && delaySeconds > 0) await sleep(delaySeconds * 1000);
  }

  db.prepare(
    `UPDATE campaigns SET last_run_at = datetime('now'), sent_count = sent_count + ?, failed_count = failed_count + ? WHERE id = ?`
  ).run(sentTotal, failedTotal, campaign.id);
}

function startScheduler() {
  cron.schedule('* * * * *', async () => {
    const now = new Date();
    const campaigns = db.prepare('SELECT * FROM campaigns WHERE is_active = 1').all();

    for (const campaign of campaigns) {
      if (campaign.end_date) {
        const end = new Date(campaign.end_date + 'T23:59:59');
        if (now > end) continue;
      }
      const tz = campaign.timezone || 'Europe/Paris';
      const localNow = new Date(now.toLocaleString('en-US', { timeZone: tz }));
      const currentHHMM = `${String(localNow.getHours()).padStart(2, '0')}:${String(localNow.getMinutes()).padStart(2, '0')}`;
      const dayCodes = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
      const todayCode = dayCodes[localNow.getDay()];
      const todayDate = `${localNow.getFullYear()}-${String(localNow.getMonth() + 1).padStart(2, '0')}-${String(localNow.getDate()).padStart(2, '0')}`;

      if (campaign.schedule_time !== currentHHMM) continue;

      let shouldRun = false;
      if (campaign.schedule_type === 'daily') shouldRun = true;
      else if (campaign.schedule_type === 'weekly') {
        const days = (campaign.schedule_days || '').split(',').map((d) => d.trim());
        shouldRun = days.includes(todayCode);
      } else if (campaign.schedule_type === 'once') {
        shouldRun = campaign.schedule_date === todayDate;
      }

      if (shouldRun && campaign.last_run_at) {
        const lastRun = new Date(campaign.last_run_at + 'Z');
        if (now.getTime() - lastRun.getTime() < 55000) shouldRun = false;
      }

      if (shouldRun) {
        runCampaign(campaign.id).catch((err) => console.error(`Erreur campagne ${campaign.id} :`, err));
        if (campaign.schedule_type === 'once') {
          db.prepare('UPDATE campaigns SET is_active = 0 WHERE id = ?').run(campaign.id);
        }
      }
    }
  });
  console.log('✅ Planificateur démarré (vérification toutes les minutes).');
}

// ---------------------------------------------------------------------------
// APPLICATION EXPRESS
// ---------------------------------------------------------------------------
const app = express();
const PORT = Number(process.env.PORT || 3000);
app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
      },
    },
  })
);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
app.use('/api/', apiLimiter);
app.use('/api/auth/login', loginLimiter);

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev_secret_change_me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 8,
    },
  })
);

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Non authentifié. Veuillez vous connecter.' });
  return res.redirect('/login.html');
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isValidEmail = (e) => EMAIL_REGEX.test((e || '').trim());
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ---- AUTH ----
const authRouter = express.Router();
authRouter.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'E-mail et mot de passe requis.' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Identifiants incorrects.' });
  }
  req.session.userId = user.id;
  req.session.userEmail = user.email;
  res.json({ ok: true });
});
authRouter.post('/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
authRouter.get('/me', (req, res) => {
  if (req.session.userId) res.json({ authenticated: true, email: req.session.userEmail });
  else res.json({ authenticated: false });
});
authRouter.post('/change-password', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Non authentifié.' });
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'Le nouveau mot de passe doit contenir au moins 8 caractères.' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(401).json({ error: 'Mot de passe actuel incorrect.' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 12), user.id);
  res.json({ ok: true });
});
app.use('/api/auth', authRouter);

// ---- DESTINATAIRES / LISTES ----
const recipientsRouter = express.Router();
recipientsRouter.get('/lists', (req, res) => {
  const lists = db.prepare(
    `SELECT l.id, l.name, l.created_at,
      (SELECT COUNT(*) FROM list_recipients lr WHERE lr.list_id = l.id) AS recipient_count
     FROM lists l ORDER BY l.created_at DESC`
  ).all();
  res.json(lists);
});
recipientsRouter.post('/lists', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Le nom de la liste est requis.' });
  const info = db.prepare('INSERT INTO lists (name) VALUES (?)').run(name);
  res.json({ id: info.lastInsertRowid });
});
recipientsRouter.delete('/lists/:id', (req, res) => {
  db.prepare('DELETE FROM lists WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});
recipientsRouter.get('/', (req, res) => {
  const listId = req.query.list_id;
  const rows = listId
    ? db.prepare(`SELECT r.* FROM recipients r JOIN list_recipients lr ON lr.recipient_id = r.id WHERE lr.list_id = ? ORDER BY r.created_at DESC`).all(listId)
    : db.prepare('SELECT * FROM recipients ORDER BY created_at DESC').all();
  res.json(rows);
});
recipientsRouter.post('/', (req, res) => {
  const emails = (req.body.emails || '').split(/[\n,;]+/).map((e) => e.trim()).filter(Boolean);
  const listId = req.body.list_id || null;
  let added = 0, duplicates = 0, invalid = [];
  const insertStmt = db.prepare('INSERT INTO recipients (email, name) VALUES (?, ?)');
  const findStmt = db.prepare('SELECT id FROM recipients WHERE email = ?');
  const linkStmt = db.prepare('INSERT OR IGNORE INTO list_recipients (list_id, recipient_id) VALUES (?, ?)');
  for (const email of emails) {
    if (!isValidEmail(email)) { invalid.push(email); continue; }
    const existing = findStmt.get(email);
    let recipientId;
    if (existing) { duplicates++; recipientId = existing.id; }
    else { recipientId = insertStmt.run(email, '').lastInsertRowid; added++; }
    if (listId) linkStmt.run(listId, recipientId);
  }
  res.json({ added_count: added, duplicate_count: duplicates, invalid_count: invalid.length, invalid });
});
recipientsRouter.post('/import-csv', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu.' });
  const listId = req.body.list_id ? Number(req.body.list_id) : null;
  let records;
  try {
    records = parse(req.file.buffer, { columns: true, skip_empty_lines: true, trim: true });
  } catch (e) {
    return res.status(400).json({ error: 'Fichier CSV invalide : ' + e.message });
  }
  const insertStmt = db.prepare('INSERT INTO recipients (email, name) VALUES (?, ?)');
  const findStmt = db.prepare('SELECT id FROM recipients WHERE email = ?');
  const linkStmt = db.prepare('INSERT OR IGNORE INTO list_recipients (list_id, recipient_id) VALUES (?, ?)');
  let added = 0, duplicates = 0, invalid = 0;
  for (const row of records) {
    const email = (row.email || row.Email || row.EMAIL || '').trim();
    const name = (row.name || row.Name || '').trim();
    if (!email || !isValidEmail(email)) { invalid++; continue; }
    const existing = findStmt.get(email);
    let recipientId;
    if (existing) { duplicates++; recipientId = existing.id; }
    else { recipientId = insertStmt.run(email, name).lastInsertRowid; added++; }
    if (listId) linkStmt.run(listId, recipientId);
  }
  res.json({ added, duplicates, invalid, total_rows: records.length });
});
recipientsRouter.put('/:id', (req, res) => {
  const { email, name } = req.body || {};
  if (email && !isValidEmail(email)) return res.status(400).json({ error: 'Adresse e-mail invalide.' });
  db.prepare('UPDATE recipients SET email = COALESCE(?, email), name = COALESCE(?, name) WHERE id = ?').run(email, name, req.params.id);
  res.json({ ok: true });
});
recipientsRouter.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM recipients WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});
recipientsRouter.post('/:id/unsubscribe', (req, res) => {
  db.prepare('UPDATE recipients SET unsubscribed = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});
app.use('/api/recipients', requireAuth, recipientsRouter);

// ---- CAMPAGNES ----
const campaignsRouter = express.Router();
campaignsRouter.get('/', (req, res) => res.json(db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all()));
campaignsRouter.get('/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Campagne introuvable.' });
  res.json(c);
});
function campaignPayload(b) {
  return {
    name: b.name, connection_id: b.connection_id || null, list_id: b.list_id,
    subject: b.subject, body_html: b.body_html, use_bcc: b.use_bcc === false ? 0 : 1,
    batch_size: b.batch_size, delay: b.delay_between_batches_seconds ?? 30,
    schedule_type: b.schedule_type, schedule_time: b.schedule_time || null,
    schedule_date: b.schedule_date || null,
    schedule_days: Array.isArray(b.schedule_days) ? b.schedule_days.join(',') : b.schedule_days || null,
    schedule_cron: b.schedule_cron || null, timezone: b.timezone || process.env.APP_TIMEZONE || 'Europe/Paris',
    end_date: b.end_date || null, is_active: b.is_active === false ? 0 : 1,
  };
}
function validateCampaign(b) {
  if (!b.name || !b.name.trim()) return 'Le nom de la campagne est requis.';
  if (!b.subject || !b.subject.trim()) return "L'objet est requis.";
  if (!b.body_html || !b.body_html.trim()) return 'Le contenu du message est requis.';
  if (!b.list_id) return 'Une liste de destinataires doit être sélectionnée.';
  if (!['once', 'daily', 'weekly', 'custom_cron'].includes(b.schedule_type)) return 'Fréquence invalide.';
  if (!b.batch_size || b.batch_size < 1 || b.batch_size > 500) return 'Taille de groupe invalide.';
  return null;
}
campaignsRouter.post('/', (req, res) => {
  const err = validateCampaign(req.body);
  if (err) return res.status(400).json({ error: err });
  const p = campaignPayload(req.body);
  const info = db.prepare(
    `INSERT INTO campaigns (name, connection_id, list_id, subject, body_html, use_bcc, batch_size, delay_between_batches_seconds,
      schedule_type, schedule_time, schedule_date, schedule_days, schedule_cron, timezone, end_date, is_active)
     VALUES (@name, @connection_id, @list_id, @subject, @body_html, @use_bcc, @batch_size, @delay,
      @schedule_type, @schedule_time, @schedule_date, @schedule_days, @schedule_cron, @timezone, @end_date, @is_active)`
  ).run(p);
  res.json({ id: info.lastInsertRowid });
});
campaignsRouter.put('/:id', (req, res) => {
  const err = validateCampaign(req.body);
  if (err) return res.status(400).json({ error: err });
  const p = campaignPayload(req.body);
  p.id = req.params.id;
  db.prepare(
    `UPDATE campaigns SET name=@name, connection_id=@connection_id, list_id=@list_id, subject=@subject, body_html=@body_html,
      use_bcc=@use_bcc, batch_size=@batch_size, delay_between_batches_seconds=@delay, schedule_type=@schedule_type,
      schedule_time=@schedule_time, schedule_date=@schedule_date, schedule_days=@schedule_days, schedule_cron=@schedule_cron,
      timezone=@timezone, end_date=@end_date, is_active=@is_active, updated_at=datetime('now') WHERE id=@id`
  ).run(p);
  res.json({ ok: true });
});
campaignsRouter.post('/:id/toggle', (req, res) => {
  const c = db.prepare('SELECT is_active FROM campaigns WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Campagne introuvable.' });
  db.prepare('UPDATE campaigns SET is_active = ? WHERE id = ?').run(c.is_active ? 0 : 1, req.params.id);
  res.json({ ok: true, is_active: !c.is_active });
});
campaignsRouter.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM campaigns WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});
campaignsRouter.post('/:id/test', async (req, res) => {
  try {
    await runCampaign(Number(req.params.id), true);
    res.json({ ok: true, message: "Envoi test terminé. Consultez l'historique pour le détail." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.use('/api/campaigns', requireAuth, campaignsRouter);

// ---- CONNEXIONS E-MAIL ----
const connectionsRouter = express.Router();
connectionsRouter.get('/', (req, res) => {
  res.json(db.prepare('SELECT id, provider, label, from_email, is_default, created_at FROM email_connections').all());
});
connectionsRouter.post('/', (req, res) => {
  const { label, from_email, provider } = req.body || {};
  if (!label || !isValidEmail(from_email) || !['smtp', 'gmail_oauth', 'microsoft_oauth'].includes(provider)) {
    return res.status(400).json({ error: 'Champs invalides.' });
  }
  const configJson = JSON.stringify({ note: 'Identifiants lus depuis les variables d\'environnement.' });
  const info = db.prepare('INSERT INTO email_connections (provider, label, from_email, config_json) VALUES (?, ?, ?, ?)').run(provider, label, from_email, configJson);
  res.json({ id: info.lastInsertRowid });
});
connectionsRouter.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM email_connections WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});
connectionsRouter.post('/test-smtp', async (req, res) => {
  try {
    const transport = createSmtpTransport();
    await transport.verify();
    res.json({ ok: true, message: 'Connexion SMTP valide.' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.use('/api/connections', requireAuth, connectionsRouter);

// ---- IA (facultatif) ----
const aiRouter = express.Router();
aiRouter.post('/generate', async (req, res) => {
  const instruction = (req.body.instruction || '').trim();
  if (!instruction) return res.status(400).json({ error: 'Instruction requise.' });
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) {
    return res.status(400).json({ error: "Génération IA non configurée. Renseignez AI_API_KEY dans les variables d'environnement." });
  }
  try {
    const model = process.env.AI_MODEL || 'claude-sonnet-4-6';
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model, max_tokens: 800,
        messages: [{ role: 'user', content: `Rédige le contenu HTML d'un e-mail professionnel en français à partir de cette instruction : "${instruction}". Réponds uniquement avec le HTML du corps du message.` }],
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      return res.status(502).json({ error: `Erreur de l'API IA : ${text}` });
    }
    const data = await response.json();
    const generated = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    res.json({ content: generated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.use('/api/ai', requireAuth, aiRouter);

// ---- HISTORIQUE / STATS / PARAMETRES ----
const miscRouter = express.Router();
miscRouter.get('/history', (req, res) => {
  const limit = Number(req.query.limit || 100);
  res.json(db.prepare('SELECT * FROM history ORDER BY executed_at DESC LIMIT ?').all(limit));
});
miscRouter.get('/stats', (req, res) => {
  const totalCampaigns = db.prepare('SELECT COUNT(*) AS c FROM campaigns').get().c;
  const activeCampaigns = db.prepare('SELECT COUNT(*) AS c FROM campaigns WHERE is_active = 1').get().c;
  const totalRecipients = db.prepare('SELECT COUNT(*) AS c FROM recipients WHERE unsubscribed = 0').get().c;
  const totalSent = db.prepare('SELECT COALESCE(SUM(sent_count),0) AS c FROM campaigns').get().c;
  const totalFailed = db.prepare('SELECT COALESCE(SUM(failed_count),0) AS c FROM campaigns').get().c;
  res.json({ totalCampaigns, activeCampaigns, totalRecipients, totalSent, totalFailed });
});
miscRouter.get('/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const r of rows) settings[r.key] = r.value;
  settings.timezone = settings.timezone || process.env.APP_TIMEZONE || 'Europe/Paris';
  res.json(settings);
});
miscRouter.post('/settings', (req, res) => {
  const upsert = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  for (const [key, value] of Object.entries(req.body || {})) upsert.run(key, String(value));
  res.json({ ok: true });
});
app.use('/api', requireAuth, miscRouter);

// Lien de désinscription public
app.get('/unsubscribe/:id', (req, res) => {
  db.prepare('UPDATE recipients SET unsubscribed = 1 WHERE id = ?').run(req.params.id);
  res.send('<h1>Désinscription confirmée</h1><p>Vous ne recevrez plus de messages de notre part.</p>');
});

// ---- FICHIERS STATIQUES (frontend) ----
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  if (req.session.userId) res.sendFile(path.join(__dirname, 'public', 'index.html'));
  else res.redirect('/login.html');
});

app.use((err, req, res, next) => {
  console.error(`[ERREUR] ${req.method} ${req.path} :`, err);
  res.status(500).json({ error: 'Une erreur interne est survenue.' });
});

app.listen(PORT, () => {
  console.log(`✅ Serveur démarré sur le port ${PORT}`);
  startScheduler();
});
