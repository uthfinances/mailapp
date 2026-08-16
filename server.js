// MailApp — serveur unique (Express + stockage JSON + node-cron + nodemailer)
// Stockage JSON local (pas de dependance native) pour un deploiement fiable
// sur les hebergeurs gratuits (pas de compilation necessaire).
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const nodemailer = require('nodemailer');
const cron = require('node-cron');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const dbFile = path.join(dataDir, 'db.json');

function defaultStore() {
  return {
    nextId: { users: 1, lists: 1, recipients: 1, email_connections: 1, campaigns: 1, history: 1 },
    users: [],
    lists: [],
    recipients: [],
    email_connections: [],
    campaigns: [],
    history: [],
    settings: {},
  };
}

let store = defaultStore();
if (fs.existsSync(dbFile)) {
  try {
    store = { ...defaultStore(), ...JSON.parse(fs.readFileSync(dbFile, 'utf8')) };
  } catch (e) {
    console.error('Fichier de donnees illisible, reinitialisation.', e);
    store = defaultStore();
  }
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFileSync(dbFile, JSON.stringify(store, null, 2));
  }, 200);
}

function takeId(table) {
  const id = store.nextId[table]++;
  save();
  return id;
}
function nowIso() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

(function ensureAdmin() {
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@example.com';
  const adminPassword = process.env.ADMIN_PASSWORD || 'ChangeMoi123!';
  const existing = store.users.find((u) => u.email === adminEmail);
  if (!existing) {
    const hash = bcrypt.hashSync(adminPassword, 12);
    store.users.push({ id: takeId('users'), email: adminEmail, password_hash: hash, created_at: nowIso() });
    save();
    console.log(`Compte administrateur cree : ${adminEmail}`);
  }
})();

function createSmtpTransport() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = process.env.SMTP_SECURE === 'true';
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    throw new Error('Configuration SMTP incomplete. Renseignez SMTP_HOST, SMTP_USER et SMTP_PASS.');
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
  store.history.unshift({
    id: takeId('history'),
    campaign_id: entry.campaign_id,
    campaign_name: entry.campaign_name,
    batch_label: entry.batch_label,
    recipients_count: entry.recipients_count,
    status: entry.status,
    error: entry.error || null,
    executed_at: nowIso(),
  });
  save();
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCampaign(campaignId, manualTest = false) {
  const campaign = store.campaigns.find((c) => c.id === campaignId);
  if (!campaign) return;
  if (!campaign.is_active && !manualTest) return;

  const connection = campaign.connection_id
    ? store.email_connections.find((c) => c.id === campaign.connection_id)
    : null;

  const list = campaign.list_id ? store.lists.find((l) => l.id === campaign.list_id) : null;
  const recipients = list
    ? (list.recipient_ids || [])
        .map((rid) => store.recipients.find((r) => r.id === rid))
        .filter((r) => r && !r.unsubscribed)
    : [];

  if (recipients.length === 0) {
    logHistory({
      campaign_id: campaign.id, campaign_name: campaign.name, batch_label: 'N/A',
      recipients_count: 0, status: 'echec', error: 'Aucun destinataire actif dans la liste associee.',
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

  campaign.last_run_at = nowIso();
  campaign.sent_count = (campaign.sent_count || 0) + sentTotal;
  campaign.failed_count = (campaign.failed_count || 0) + failedTotal;
  save();
}

function startScheduler() {
  cron.schedule('* * * * *', async () => {
    const now = new Date();
    const campaigns = store.campaigns.filter((c) => c.is_active);

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
        const lastRun = new Date(campaign.last_run_at.replace(' ', 'T') + 'Z');
        if (now.getTime() - lastRun.getTime() < 55000) shouldRun = false;
      }

      if (shouldRun) {
        runCampaign(campaign.id).catch((err) => console.error(`Erreur campagne ${campaign.id} :`, err));
        if (campaign.schedule_type === 'once') {
          campaign.is_active = 0;
          save();
        }
      }
    }
  });
  console.log('Planificateur demarre (verification toutes les minutes).');
}

const app = express();
const PORT = Number(process.env.PORT || 3000);
app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
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
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Non authentifie. Veuillez vous connecter.' });
  return res.redirect('/login.html');
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isValidEmail = (e) => EMAIL_REGEX.test((e || '').trim());
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const authRouter = express.Router();
authRouter.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'E-mail et mot de passe requis.' });
  const user = store.users.find((u) => u.email === email);
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
  if (!req.session.userId) return res.status(401).json({ error: 'Non authentifie.' });
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'Le nouveau mot de passe doit contenir au moins 8 caracteres.' });
  const user = store.users.find((u) => u.id === req.session.userId);
  if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(401).json({ error: 'Mot de passe actuel incorrect.' });
  }
  user.password_hash = bcrypt.hashSync(newPassword, 12);
  save();
  res.json({ ok: true });
});
app.use('/api/auth', authRouter);

const recipientsRouter = express.Router();
recipientsRouter.get('/lists', (req, res) => {
  res.json(
    store.lists.map((l) => ({
      id: l.id, name: l.name, created_at: l.created_at,
      recipient_count: (l.recipient_ids || []).length,
    }))
  );
});
recipientsRouter.post('/lists', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Le nom de la liste est requis.' });
  const list = { id: takeId('lists'), name, created_at: nowIso(), recipient_ids: [] };
  store.lists.unshift(list);
  save();
  res.json({ id: list.id });
});
recipientsRouter.delete('/lists/:id', (req, res) => {
  store.lists = store.lists.filter((l) => l.id !== Number(req.params.id));
  save();
  res.json({ ok: true });
});
recipientsRouter.get('/', (req, res) => {
  const listId = req.query.list_id ? Number(req.query.list_id) : null;
  if (listId) {
    const list = store.lists.find((l) => l.id === listId);
    const rows = list ? (list.recipient_ids || []).map((id) => store.recipients.find((r) => r.id === id)).filter(Boolean) : [];
    return res.json(rows);
  }
  res.json(store.recipients);
});
recipientsRouter.post('/', (req, res) => {
  const emails = (req.body.emails || '').split(/[\n,;]+/).map((e) => e.trim()).filter(Boolean);
  const listId = req.body.list_id ? Number(req.body.list_id) : null;
  const list = listId ? store.lists.find((l) => l.id === listId) : null;
  let added = 0, duplicates = 0, invalid = [];
  for (const email of emails) {
    if (!isValidEmail(email)) { invalid.push(email); continue; }
    let recipient = store.recipients.find((r) => r.email === email);
    if (recipient) { duplicates++; }
    else {
      recipient = { id: takeId('recipients'), email, name: '', unsubscribed: 0, created_at: nowIso() };
      store.recipients.push(recipient);
      added++;
    }
    if (list && !list.recipient_ids.includes(recipient.id)) list.recipient_ids.push(recipient.id);
  }
  save();
  res.json({ added_count: added, duplicate_count: duplicates, invalid_count: invalid.length, invalid });
});
recipientsRouter.post('/import-csv', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier recu.' });
  const listId = req.body.list_id ? Number(req.body.list_id) : null;
  const list = listId ? store.lists.find((l) => l.id === listId) : null;
  let records;
  try {
    records = parse(req.file.buffer, { columns: true, skip_empty_lines: true, trim: true });
  } catch (e) {
    return res.status(400).json({ error: 'Fichier CSV invalide : ' + e.message });
  }
  let added = 0, duplicates = 0, invalid = 0;
  for (const row of records) {
    const email = (row.email || row.Email || row.EMAIL || '').trim();
    const name = (row.name || row.Name || '').trim();
    if (!email || !isValidEmail(email)) { invalid++; continue; }
    let recipient = store.recipients.find((r) => r.email === email);
    if (recipient) { duplicates++; }
    else {
      recipient = { id: takeId('recipients'), email, name, unsubscribed: 0, created_at: nowIso() };
      store.recipients.push(recipient);
      added++;
    }
    if (list && !list.recipient_ids.includes(recipient.id)) list.recipient_ids.push(recipient.id);
  }
  save();
  res.json({ added, duplicates, invalid, total_rows: records.length });
});
recipientsRouter.put('/:id', (req, res) => {
  const { email, name } = req.body || {};
  if (email && !isValidEmail(email)) return res.status(400).json({ error: 'Adresse e-mail invalide.' });
  const recipient = store.recipients.find((r) => r.id === Number(req.params.id));
  if (!recipient) return res.status(404).json({ error: 'Destinataire introuvable.' });
  if (email) recipient.email = email;
  if (name !== undefined) recipient.name = name;
  save();
  res.json({ ok: true });
});
recipientsRouter.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  store.recipients = store.recipients.filter((r) => r.id !== id);
  for (const list of store.lists) list.recipient_ids = (list.recipient_ids || []).filter((rid) => rid !== id);
  save();
  res.json({ ok: true });
});
recipientsRouter.post('/:id/unsubscribe', (req, res) => {
  const recipient = store.recipients.find((r) => r.id === Number(req.params.id));
  if (recipient) { recipient.unsubscribed = 1; save(); }
  res.json({ ok: true });
});
app.use('/api/recipients', requireAuth, recipientsRouter);

const campaignsRouter = express.Router();
campaignsRouter.get('/', (req, res) => res.json(store.campaigns));
campaignsRouter.get('/:id', (req, res) => {
  const c = store.campaigns.find((c) => c.id === Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Campagne introuvable.' });
  res.json(c);
});
function campaignPayload(b) {
  return {
    name: b.name, connection_id: b.connection_id ? Number(b.connection_id) : null, list_id: Number(b.list_id),
    subject: b.subject, body_html: b.body_html, use_bcc: b.use_bcc === false ? 0 : 1,
    batch_size: Number(b.batch_size), delay_between_batches_seconds: Number(b.delay_between_batches_seconds ?? 30),
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
  if (!b.list_id) return 'Une liste de destinataires doit etre selectionnee.';
  if (!['once', 'daily', 'weekly', 'custom_cron'].includes(b.schedule_type)) return 'Frequence invalide.';
  if (!b.batch_size || b.batch_size < 1 || b.batch_size > 500) return 'Taille de groupe invalide.';
  return null;
}
campaignsRouter.post('/', (req, res) => {
  const err = validateCampaign(req.body);
  if (err) return res.status(400).json({ error: err });
  const p = campaignPayload(req.body);
  const campaign = {
    id: takeId('campaigns'), ...p,
    last_run_at: null, next_run_at: null, sent_count: 0, failed_count: 0,
    created_at: nowIso(), updated_at: nowIso(),
  };
  store.campaigns.unshift(campaign);
  save();
  res.json({ id: campaign.id });
});
campaignsRouter.put('/:id', (req, res) => {
  const err = validateCampaign(req.body);
  if (err) return res.status(400).json({ error: err });
  const campaign = store.campaigns.find((c) => c.id === Number(req.params.id));
  if (!campaign) return res.status(404).json({ error: 'Campagne introuvable.' });
  Object.assign(campaign, campaignPayload(req.body), { updated_at: nowIso() });
  save();
  res.json({ ok: true });
});
campaignsRouter.post('/:id/toggle', (req, res) => {
  const c = store.campaigns.find((c) => c.id === Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Campagne introuvable.' });
  c.is_active = c.is_active ? 0 : 1;
  save();
  res.json({ ok: true, is_active: !!c.is_active });
});
campaignsRouter.delete('/:id', (req, res) => {
  store.campaigns = store.campaigns.filter((c) => c.id !== Number(req.params.id));
  save();
  res.json({ ok: true });
});
campaignsRouter.post('/:id/test', async (req, res) => {
  try {
    await runCampaign(Number(req.params.id), true);
    res.json({ ok: true, message: "Envoi test termine. Consultez l'historique pour le detail." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.use('/api/campaigns', requireAuth, campaignsRouter);

const connectionsRouter = express.Router();
connectionsRouter.get('/', (req, res) => res.json(store.email_connections));
connectionsRouter.post('/', (req, res) => {
  const { label, from_email, provider } = req.body || {};
  if (!label || !isValidEmail(from_email) || !['smtp', 'gmail_oauth', 'microsoft_oauth'].includes(provider)) {
    return res.status(400).json({ error: 'Champs invalides.' });
  }
  const conn = {
    id: takeId('email_connections'), provider, label, from_email,
    config_json: JSON.stringify({ note: "Identifiants lus depuis les variables d'environnement." }),
    is_default: 0, created_at: nowIso(),
  };
  store.email_connections.push(conn);
  save();
  res.json({ id: conn.id });
});
connectionsRouter.delete('/:id', (req, res) => {
  store.email_connections = store.email_connections.filter((c) => c.id !== Number(req.params.id));
  save();
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

const aiRouter = express.Router();
aiRouter.post('/generate', async (req, res) => {
  const instruction = (req.body.instruction || '').trim();
  if (!instruction) return res.status(400).json({ error: 'Instruction requise.' });
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) {
    return res.status(400).json({ error: "Generation IA non configuree. Renseignez AI_API_KEY dans les variables d'environnement." });
  }
  try {
    const model = process.env.AI_MODEL || 'claude-sonnet-4-6';
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model, max_tokens: 800,
        messages: [{ role: 'user', content: `Redige le contenu HTML d'un e-mail professionnel en francais a partir de cette instruction : "${instruction}". Reponds uniquement avec le HTML du corps du message.` }],
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

const miscRouter = express.Router();
miscRouter.get('/history', (req, res) => {
  const limit = Number(req.query.limit || 100);
  res.json(store.history.slice(0, limit));
});
miscRouter.get('/stats', (req, res) => {
  const totalCampaigns = store.campaigns.length;
  const activeCampaigns = store.campaigns.filter((c) => c.is_active).length;
  const totalRecipients = store.recipients.filter((r) => !r.unsubscribed).length;
  const totalSent = store.campaigns.reduce((s, c) => s + (c.sent_count || 0), 0);
  const totalFailed = store.campaigns.reduce((s, c) => s + (c.failed_count || 0), 0);
  res.json({ totalCampaigns, activeCampaigns, totalRecipients, totalSent, totalFailed });
});
miscRouter.get('/settings', (req, res) => {
  res.json({ timezone: process.env.APP_TIMEZONE || 'Europe/Paris', ...store.settings });
});
miscRouter.post('/settings', (req, res) => {
  Object.assign(store.settings, req.body || {});
  save();
  res.json({ ok: true });
});
app.use('/api', requireAuth, miscRouter);

app.get('/unsubscribe/:id', (req, res) => {
  const recipient = store.recipients.find((r) => r.id === Number(req.params.id));
  if (recipient) { recipient.unsubscribed = 1; save(); }
  res.send('<h1>Desinscription confirmee</h1><p>Vous ne recevrez plus de messages de notre part.</p>');
});

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
  console.log(`Serveur demarre sur le port ${PORT}`);
  startScheduler();
});
