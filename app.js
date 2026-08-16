// ---------- Utilitaires ----------
async function api(path, options = {}) {
  const res = await fetch('/api' + path, {
    headers: options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erreur inconnue.');
  return data;
}

function toast(message, isError = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (isError ? ' error' : '');
  t.textContent = message;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

function statusLabel(status) {
  const map = {
    programme: 'Programmé', en_attente: 'En attente', envoye: 'Envoyé',
    echec: 'Échec', annule: 'Annulé',
  };
  return map[status] || status;
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d.includes('Z') ? d : d + 'Z').toLocaleString('fr-FR');
}

// ---------- Navigation ----------
document.querySelectorAll('.sidebar nav a').forEach((link) => {
  link.addEventListener('click', () => {
    document.querySelectorAll('.sidebar nav a').forEach((a) => a.classList.remove('active'));
    document.querySelectorAll('.section').forEach((s) => s.classList.remove('active'));
    link.classList.add('active');
    document.getElementById(link.dataset.section).classList.add('active');
    loadSection(link.dataset.section);
  });
});

async function checkAuth() {
  const me = await api('/auth/me');
  if (!me.authenticated) {
    window.location.href = '/login.html';
    return;
  }
  document.getElementById('userLabel').textContent = me.email;
}

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

function loadSection(name) {
  if (name === 'dashboard') loadDashboard();
  if (name === 'campaigns') loadCampaigns();
  if (name === 'recipients') loadRecipients();
  if (name === 'lists') loadLists();
  if (name === 'history') loadHistory();
  if (name === 'settings') loadSettingsSection();
}

// ---------- Tableau de bord ----------
async function loadDashboard() {
  const stats = await api('/stats');
  document.getElementById('statsGrid').innerHTML = `
    <div class="stat-card"><div class="value">${stats.totalCampaigns}</div><div class="label">Campagnes</div></div>
    <div class="stat-card"><div class="value">${stats.activeCampaigns}</div><div class="label">Campagnes actives</div></div>
    <div class="stat-card"><div class="value">${stats.totalRecipients}</div><div class="label">Destinataires</div></div>
    <div class="stat-card"><div class="value">${stats.totalSent}</div><div class="label">E-mails envoyés</div></div>
    <div class="stat-card"><div class="value">${stats.totalFailed}</div><div class="label">Échecs</div></div>
  `;
  const campaigns = (await api('/campaigns')).filter((c) => c.is_active);
  document.querySelector('#dashboardCampaignsTable tbody').innerHTML = campaigns
    .map(
      (c) => `<tr><td>${c.name}</td><td><span class="badge active">Active</span></td>
      <td>${c.schedule_time || '—'}</td><td>${c.sent_count}</td></tr>`
    )
    .join('') || '<tr><td colspan="4">Aucune campagne active.</td></tr>';
}

// ---------- Campagnes ----------
let listsCache = [];
let connectionsCache = [];

async function loadCampaigns() {
  const campaigns = await api('/campaigns');
  document.querySelector('#campaignsTable tbody').innerHTML = campaigns
    .map((c) => {
      const statusBadge = c.is_active
        ? '<span class="badge active">Active</span>'
        : '<span class="badge inactive">Désactivée</span>';
      return `<tr>
        <td>${c.name}</td>
        <td>${statusBadge}</td>
        <td>${c.batch_size ? 'Groupes de ' + c.batch_size : '—'}</td>
        <td>${fmtDate(c.last_run_at)}</td>
        <td>${c.sent_count}</td>
        <td>${c.failed_count}</td>
        <td>
          <button class="btn btn-sm" onclick="editCampaign(${c.id})">Modifier</button>
          <button class="btn btn-sm" onclick="toggleCampaign(${c.id})">${c.is_active ? 'Désactiver' : 'Activer'}</button>
          <button class="btn btn-sm" onclick="testCampaign(${c.id})">Tester</button>
          <button class="btn btn-sm btn-danger" onclick="deleteCampaign(${c.id})">Supprimer</button>
        </td>
      </tr>`;
    })
    .join('') || '<tr><td colspan="7">Aucune campagne pour le moment.</td></tr>';
}

async function toggleCampaign(id) {
  await api(`/campaigns/${id}/toggle`, { method: 'POST' });
  toast('Statut de la campagne mis à jour.');
  loadCampaigns();
}

async function deleteCampaign(id) {
  if (!confirm('Supprimer définitivement cette campagne ? Cette action est irréversible.')) return;
  await api(`/campaigns/${id}`, { method: 'DELETE' });
  toast('Campagne supprimée.');
  loadCampaigns();
}

async function testCampaign(id) {
  if (!confirm("Envoyer un envoi TEST réel maintenant à tous les destinataires de la liste associée. Continuer ?")) return;
  try {
    const res = await api(`/campaigns/${id}/test`, { method: 'POST' });
    toast(res.message || 'Test envoyé.');
  } catch (err) {
    toast(err.message, true);
  }
}

async function populateCampaignSelects() {
  listsCache = await api('/recipients/lists');
  connectionsCache = await api('/connections');
  document.getElementById('campaignListId').innerHTML = listsCache
    .map((l) => `<option value="${l.id}">${l.name} (${l.recipient_count})</option>`)
    .join('');
  document.getElementById('campaignConnectionId').innerHTML =
    '<option value="">Par défaut</option>' +
    connectionsCache.map((c) => `<option value="${c.id}">${c.label} (${c.provider})</option>`).join('');
}

const weekdayLabels = [
  ['MO', 'Lun'], ['TU', 'Mar'], ['WE', 'Mer'], ['TH', 'Jeu'], ['FR', 'Ven'], ['SA', 'Sam'], ['SU', 'Dim'],
];
document.getElementById('weekdaysCheckboxes').innerHTML = weekdayLabels
  .map(([code, label]) => `<label style="display:inline-block;margin-right:0.7rem;font-weight:400;">
    <input type="checkbox" value="${code}" class="weekday-cb" /> ${label}</label>`)
  .join('');

document.getElementById('campaignScheduleType').addEventListener('change', (e) => {
  document.getElementById('scheduleOnceFields').style.display = e.target.value === 'once' ? 'block' : 'none';
  document.getElementById('scheduleWeeklyFields').style.display = e.target.value === 'weekly' ? 'block' : 'none';
});

document.getElementById('newCampaignBtn').addEventListener('click', async () => {
  await populateCampaignSelects();
  document.getElementById('campaignModalTitle').textContent = 'Nouvelle campagne';
  document.getElementById('campaignForm').reset();
  document.getElementById('campaignId').value = '';
  document.getElementById('campaignTimezone').value = 'Europe/Paris';
  document.getElementById('campaignModalOverlay').style.display = 'flex';
});

document.getElementById('cancelCampaignBtn').addEventListener('click', () => {
  document.getElementById('campaignModalOverlay').style.display = 'none';
});

async function editCampaign(id) {
  await populateCampaignSelects();
  const c = await api(`/campaigns/${id}`);
  document.getElementById('campaignModalTitle').textContent = 'Modifier la campagne';
  document.getElementById('campaignId').value = c.id;
  document.getElementById('campaignName').value = c.name;
  document.getElementById('campaignListId').value = c.list_id;
  document.getElementById('campaignConnectionId').value = c.connection_id || '';
  document.getElementById('campaignSubject').value = c.subject;
  document.getElementById('campaignBody').value = c.body_html;
  document.getElementById('campaignUseBcc').checked = !!c.use_bcc;
  document.getElementById('campaignBatchSize').value = c.batch_size;
  document.getElementById('campaignDelay').value = c.delay_between_batches_seconds;
  document.getElementById('campaignTimezone').value = c.timezone;
  document.getElementById('campaignScheduleType').value = c.schedule_type;
  document.getElementById('campaignScheduleType').dispatchEvent(new Event('change'));
  document.getElementById('campaignScheduleDate').value = c.schedule_date || '';
  document.getElementById('campaignScheduleTime').value = c.schedule_time || '';
  document.getElementById('campaignEndDate').value = c.end_date || '';
  document.getElementById('campaignIsActive').checked = !!c.is_active;
  const days = (c.schedule_days || '').split(',');
  document.querySelectorAll('.weekday-cb').forEach((cb) => (cb.checked = days.includes(cb.value)));
  document.getElementById('campaignModalOverlay').style.display = 'flex';
}

document.getElementById('campaignForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('campaignId').value;
  const payload = {
    name: document.getElementById('campaignName').value,
    list_id: Number(document.getElementById('campaignListId').value),
    connection_id: document.getElementById('campaignConnectionId').value || null,
    subject: document.getElementById('campaignSubject').value,
    body_html: document.getElementById('campaignBody').value,
    use_bcc: document.getElementById('campaignUseBcc').checked,
    batch_size: Number(document.getElementById('campaignBatchSize').value),
    delay_between_batches_seconds: Number(document.getElementById('campaignDelay').value),
    timezone: document.getElementById('campaignTimezone').value || 'Europe/Paris',
    schedule_type: document.getElementById('campaignScheduleType').value,
    schedule_date: document.getElementById('campaignScheduleDate').value || null,
    schedule_time: document.getElementById('campaignScheduleTime').value,
    schedule_days: Array.from(document.querySelectorAll('.weekday-cb:checked')).map((cb) => cb.value),
    end_date: document.getElementById('campaignEndDate').value || null,
    is_active: document.getElementById('campaignIsActive').checked,
  };
  try {
    if (id) {
      await api(`/campaigns/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      toast('Campagne mise à jour.');
    } else {
      await api('/campaigns', { method: 'POST', body: JSON.stringify(payload) });
      toast('Campagne créée.');
    }
    document.getElementById('campaignModalOverlay').style.display = 'none';
    loadCampaigns();
  } catch (err) {
    toast(err.message, true);
  }
});

document.getElementById('aiGenerateBtn').addEventListener('click', async () => {
  const instruction = prompt("Décrivez l'e-mail à générer (ex : « Rappel de rendez-vous client »)");
  if (!instruction) return;
  try {
    toast('Génération en cours...');
    const res = await api('/ai/generate', { method: 'POST', body: JSON.stringify({ instruction }) });
    document.getElementById('campaignBody').value = res.content;
    toast('Contenu généré. Relisez-le avant de programmer la campagne.');
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- Destinataires ----------
async function loadRecipients() {
  listsCache = await api('/recipients/lists');
  document.getElementById('recipientListSelect').innerHTML =
    '<option value="">(aucune liste)</option>' + listsCache.map((l) => `<option value="${l.id}">${l.name}</option>`).join('');

  const recipients = await api('/recipients');
  document.getElementById('recipientCount').textContent = recipients.length;
  document.querySelector('#recipientsTable tbody').innerHTML = recipients
    .map(
      (r) => `<tr><td>${r.email}</td><td>${r.name || ''}</td>
      <td>${r.unsubscribed ? '<span class="badge inactive">Désinscrit</span>' : '<span class="badge active">Actif</span>'}</td>
      <td><button class="btn btn-sm btn-danger" onclick="deleteRecipient(${r.id})">Supprimer</button></td></tr>`
    )
    .join('') || '<tr><td colspan="4">Aucun destinataire.</td></tr>';
}

async function deleteRecipient(id) {
  if (!confirm('Supprimer ce destinataire ?')) return;
  await api(`/recipients/${id}`, { method: 'DELETE' });
  toast('Destinataire supprimé.');
  loadRecipients();
}

document.getElementById('addRecipientsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const emails = document.getElementById('emailsInput').value;
  const list_id = document.getElementById('recipientListSelect').value || null;
  try {
    const res = await api('/recipients', { method: 'POST', body: JSON.stringify({ emails, list_id }) });
    toast(`${res.added_count} ajouté(s), ${res.duplicate_count} doublon(s), ${res.invalid_count} invalide(s).`);
    document.getElementById('emailsInput').value = '';
    loadRecipients();
  } catch (err) {
    toast(err.message, true);
  }
});

document.getElementById('csvForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = document.getElementById('csvFile').files[0];
  if (!file) return toast('Sélectionnez un fichier CSV.', true);
  const list_id = document.getElementById('recipientListSelect').value || '';
  const formData = new FormData();
  formData.append('file', file);
  if (list_id) formData.append('list_id', list_id);
  try {
    const res = await api('/recipients/import-csv', { method: 'POST', body: formData });
    toast(`Import terminé : ${res.added} ajouté(s), ${res.duplicates} doublon(s), ${res.invalid} invalide(s).`);
    loadRecipients();
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- Listes ----------
async function loadLists() {
  const lists = await api('/recipients/lists');
  document.querySelector('#listsTable tbody').innerHTML = lists
    .map(
      (l) => `<tr><td>${l.name}</td><td>${l.recipient_count}</td><td>${fmtDate(l.created_at)}</td>
      <td><button class="btn btn-sm btn-danger" onclick="deleteList(${l.id})">Supprimer</button></td></tr>`
    )
    .join('') || '<tr><td colspan="4">Aucune liste.</td></tr>';
}

async function deleteList(id) {
  if (!confirm('Supprimer cette liste ? Les destinataires ne seront pas supprimés, seulement retirés de la liste.')) return;
  await api(`/recipients/lists/${id}`, { method: 'DELETE' });
  toast('Liste supprimée.');
  loadLists();
}

document.getElementById('newListForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('newListName').value;
  await api('/recipients/lists', { method: 'POST', body: JSON.stringify({ name }) });
  document.getElementById('newListName').value = '';
  toast('Liste créée.');
  loadLists();
});

// ---------- Historique ----------
async function loadHistory() {
  const rows = await api('/history');
  document.querySelector('#historyTable tbody').innerHTML = rows
    .map(
      (h) => `<tr><td>${fmtDate(h.executed_at)}</td><td>${h.campaign_name || '—'}</td><td>${h.batch_label || '—'}</td>
      <td>${h.recipients_count ?? '—'}</td><td><span class="badge ${h.status}">${statusLabel(h.status)}</span></td>
      <td>${h.error || ''}</td></tr>`
    )
    .join('') || '<tr><td colspan="6">Aucun historique pour le moment.</td></tr>';
}

// ---------- Paramètres ----------
async function loadSettingsSection() {
  connectionsCache = await api('/connections');
  document.querySelector('#connectionsTable tbody').innerHTML = connectionsCache
    .map(
      (c) => `<tr><td>${c.label}</td><td>${c.provider}</td><td>${c.from_email}</td>
      <td><button class="btn btn-sm btn-danger" onclick="deleteConnection(${c.id})">Supprimer</button></td></tr>`
    )
    .join('') || '<tr><td colspan="4">Aucune connexion enregistrée.</td></tr>';

  const settings = await api('/settings');
  document.getElementById('timezoneInput').value = settings.timezone || 'Europe/Paris';
}

async function deleteConnection(id) {
  if (!confirm('Supprimer cette connexion e-mail ?')) return;
  await api(`/connections/${id}`, { method: 'DELETE' });
  loadSettingsSection();
}

document.getElementById('newConnectionForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    label: document.getElementById('connLabel').value,
    provider: document.getElementById('connProvider').value,
    from_email: document.getElementById('connFromEmail').value,
  };
  try {
    await api('/connections', { method: 'POST', body: JSON.stringify(payload) });
    toast('Connexion ajoutée.');
    e.target.reset();
    loadSettingsSection();
  } catch (err) {
    toast(err.message, true);
  }
});

document.getElementById('testSmtpBtn').addEventListener('click', async () => {
  const resultEl = document.getElementById('smtpTestResult');
  resultEl.textContent = 'Test en cours...';
  try {
    const res = await api('/connections/test-smtp', { method: 'POST' });
    resultEl.textContent = '✅ ' + res.message;
  } catch (err) {
    resultEl.textContent = '❌ ' + err.message;
  }
});

document.getElementById('changePasswordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({
        currentPassword: document.getElementById('currentPassword').value,
        newPassword: document.getElementById('newPassword').value,
      }),
    });
    toast('Mot de passe modifié.');
    e.target.reset();
  } catch (err) {
    toast(err.message, true);
  }
});

document.getElementById('timezoneForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('/settings', { method: 'POST', body: JSON.stringify({ timezone: document.getElementById('timezoneInput').value }) });
  toast('Fuseau horaire enregistré.');
});

// ---------- Démarrage ----------
checkAuth().then(loadDashboard);
