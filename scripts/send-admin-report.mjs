import { chromium } from '@playwright/test';
import nodemailer from 'nodemailer';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL || 'https://sgkomdvgocrmsrmcktnn.supabase.co';
const anonKey = process.env.SUPABASE_ANON_KEY || 'sb_publishable_5MB-vD9ZvTa_gfHsitfOng__XVP5PL5';
const to = process.env.REPORT_TO || 'basketloisirreunion@gmail.com';
const gmailUser = process.env.GMAIL_USER || 'basketloisirreunion@gmail.com';
const gmailPassword = process.env.GMAIL_APP_PASSWORD;

for (const [name, value] of Object.entries({ GMAIL_APP_PASSWORD: gmailPassword })) {
  if (!value) throw new Error(`Secret manquant : ${name}`);
}

const supabase = createClient(url, anonKey);
const { data: allSessions, error: sessionsError } = await supabase
  .from('sessions')
  .select('id,nom,horaires,debut_date,max_capacity,statut')
  .order('debut_date', { ascending: true });
if (sessionsError) throw new Error(`Lecture des créneaux impossible : ${sessionsError.message}`);
const { data: bookingData, error: bookingsError } = await supabase.functions.invoke('public-bookings', { body: { action: 'list' } });
if (bookingsError) throw new Error(`Lecture des inscriptions impossible : ${bookingsError.message}`);
const inscriptions = bookingData?.inscriptions || [];

const reunionParts = date => Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Indian/Reunion', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', hourCycle: 'h23'
}).formatToParts(date).map(part => [part.type, part.value]));
const maintenantLocal = reunionParts(new Date());
const jourLocal = new Date(Date.UTC(+maintenantLocal.year, +maintenantLocal.month - 1, +maintenantLocal.day));
const jourSemaine = jourLocal.getUTCDay();
const lundi = new Date(jourLocal);
lundi.setUTCDate(lundi.getUTCDate() - ((jourSemaine + 6) % 7)
  + ((jourSemaine === 5 && +maintenantLocal.hour >= 6) || jourSemaine === 6 || jourSemaine === 0 ? 7 : 0));
const vendredi = new Date(lundi);
vendredi.setUTCDate(vendredi.getUTCDate() + 4);
const dateCle = date => {
  const p = reunionParts(new Date(date));
  return p.year + '-' + p.month + '-' + p.day;
};
const debutSemaine = lundi.toISOString().slice(0, 10);
const finSemaine = vendredi.toISOString().slice(0, 10);
const upcoming = allSessions.filter(s => {
  if (s.statut === 'annulee') return false;
  const date = dateCle(s.debut_date);
  return date >= debutSemaine && date <= finSemaine;
}).slice(0, 2);
if (!upcoming.length) throw new Error('Aucun créneau dans la semaine de réservation en cours.');

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dateFmt = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Indian/Reunion', weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const card = session => {
  const rows = inscriptions.filter(i => i.session_id === session.id);
  const confirmedAll = rows.filter(i => i.statut === 'confirmed');
  const waitingAll = rows.filter(i => i.statut !== 'confirmed');
  const confirmed = confirmedAll.slice(0, 30);
  const waiting = waitingAll.slice(0, Math.max(0, 30 - confirmed.length));
  const hidden = Math.max(0, confirmedAll.length + waitingAll.length - 30);
  const dayName = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'Indian/Reunion' })
    .format(new Date(session.debut_date)).toLowerCase();
  const theme = dayName === 'tuesday' ? 'tuesday' : 'thursday';
  const horodatageCourt = value => {
    const d = new Date(Number(value) || value);
    const p = Object.fromEntries(new Intl.DateTimeFormat('fr-FR', {
      timeZone: 'Indian/Reunion', weekday: 'short', day: 'numeric',
      month: 'short', hour: '2-digit', minute: '2-digit'
    }).formatToParts(d).map(part => [part.type, part.value]));
    return `${p.weekday} ${p.day} ${p.month} · ${p.hour}h${p.minute}`;
  };
  const row = (i, n, waitingList) => `<div class="person ${waitingList ? 'waiting' : ''}"><b>${n}. ${escapeHtml(i.prenom)} ${escapeHtml(i.nom)}</b>${i.est_invite ? `<span>(invité par ${escapeHtml(i.invite_par_nom)})</span>` : ''}<small>${escapeHtml(horodatageCourt(i.date_demande))}</small></div>`;
  const title = `${session.nom || 'Basket'} — ${session.horaires || dateFmt.format(new Date(session.debut_date))}`;
  return `<section class="session ${theme}"><header><h2>${escapeHtml(title)}</h2><b class="count">${confirmedAll.length} / ${session.max_capacity || 22}</b><p>${dateFmt.format(new Date(session.debut_date))}</p></header><h3>Confirmés (${confirmedAll.length})</h3><div class="people">${confirmed.map((i,n)=>row(i,n+1,false)).join('')||'<p class="empty">Aucune inscription confirmée</p>'}</div><h3>File d’attente (${waitingAll.length})</h3><div class="people">${waiting.map((i,n)=>row(i,confirmed.length+n+1,true)).join('')||'<p class="empty">File d’attente vide</p>'}</div>${hidden ? `<p class="limit">Affichage limité aux 30 premiers joueurs (${hidden} non affiché(s)).</p>` : ''}</section>`;
};
const reportDate = dateFmt.format(new Date());
const html = `<!doctype html><html lang="fr"><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;background:#131330;color:#f5f6ff;font:16px Arial,sans-serif;padding:24px}h1{margin:0 0 5px;color:#fff;font-size:24px}.stamp{color:#b7c4e4;margin-bottom:16px}section{background:#1b2140;border:2px solid #394567;border-radius:14px;padding:14px;margin:0;overflow:hidden}.sessions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;align-items:start}.session.tuesday{border-color:#3977ed}.session.thursday{border-color:#d99b37}.session.tuesday h2{color:#a9c7ff}.session.thursday h2{color:#ffd18a}section header{border-bottom:1px solid #414c77;padding-bottom:9px;margin-bottom:9px}h2{display:inline-block;margin:0 10px 3px 0;font-size:20px}.count{color:#9ce4ba}header p{margin:4px 0 0;color:#bdc9e4;font-size:13px}h3{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#bdc9e4;margin:11px 0 5px}.people{display:block}.person{display:flex;align-items:baseline;flex-wrap:wrap;gap:5px;background:#252b53;border:1px solid #3c4976;border-radius:7px;padding:4px 7px;margin:3px 0;color:#fff;font-size:13px;line-height:1.25}.person.waiting{background:#302c42;border-color:#8c7839}.person span{color:#bec9e5}.person small{display:inline;margin-left:auto;color:#b2bfdc;font-size:10px;white-space:nowrap}.empty,.limit{color:#aab6d4;font-size:12px;font-style:italic}</style><h1>Basket Loisir Réunion</h1><div class="stamp">Listes détaillées — ${escapeHtml(reportDate)}</div><main class="sessions">${upcoming.map(card).join('')}</main></html>`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1.25 });
  await page.setContent(html, { waitUntil: 'load' });
  const image = await page.screenshot({ fullPage: true, type: 'png' });
  const transport = nodemailer.createTransport({ service: 'gmail', auth: { user: gmailUser, pass: gmailPassword } });
  await transport.sendMail({
    from: `Basket BLR <${gmailUser}>`, to,
    subject: `Basket BLR — listes des ${upcoming.length} créneaux de la semaine`,
    text: `Bonjour,\n\nVoici la capture des listes détaillées des créneaux de la semaine. Rapport généré le ${reportDate}.`,
    html: `<p>Bonjour,</p><p>Voici les listes détaillées des prochains créneaux en pièce jointe.</p><p>Rapport généré le ${escapeHtml(reportDate)}.</p>`,
    attachments: [{ filename: 'listes-basket-blr.png', content: image, contentType: 'image/png' }],
  });
} finally {
  await browser.close();
}
console.log(`Rapport envoyé à ${to}`);
