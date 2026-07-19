'use strict';
/* Alerte TGV Max Paris<->Rennes
 * - Lit alerte_config.json (règles: sens, jour, plage horaire)
 * - Interroge l'API SNCF open data (od_happy_card="OUI")
 * - Compare au fichier d'état tgvmax_state.json
 * - Envoie une alerte Telegram pour chaque train nouvellement réservable
 *   correspondant à une règle, et archive l'historique dans historique.jsonl
 */

const fs = require('fs');

const API = 'https://ressources.data.sncf.com/api/explore/v2.1/catalog/datasets/tgvmax/records';
const STATE_FILE = 'tgvmax_state.json';
const CONFIG_FILE = 'alerte_config.json';
const HIST_FILE = 'historique.jsonl';
const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

function dow(iso) {
  const p = iso.split('-');
  return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay();
}

async function fetchDirection(origLike, destLike) {
  const all = [];
  for (let offset = 0; offset < 900; offset += 100) {
    const where = `origine like "${origLike}" AND destination like "${destLike}" AND od_happy_card="OUI"`;
    const url = `${API}?where=${encodeURIComponent(where)}&order_by=date,heure_depart&limit=100&offset=${offset}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`API SNCF HTTP ${r.status}`);
    const j = await r.json();
    const res = j.results || [];
    all.push(...res);
    if (res.length < 100) break;
  }
  return all;
}

function trainKey(dir, t) {
  return `${dir}|${t.date}|${t.train_no}|${t.heure_depart}`;
}

function matchRegles(regles, dir, t) {
  const d = dow(t.date);
  const dep = t.heure_depart.slice(0, 5);
  return regles.some((r) => {
    const sens = r.sens || 'BOTH';
    if (sens !== 'BOTH' && sens !== dir) return false;
    return r.jour === d && dep >= r.debut && dep <= r.fin;
  });
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true })
  });
  if (!r.ok) console.error('Telegram HTTP', r.status, await r.text());
}

async function main() {
  if (!TOKEN || !CHAT_ID) {
    console.error('Secrets TELEGRAM_TOKEN / TELEGRAM_CHAT_ID manquants');
    process.exit(1);
  }

  // Config
  let config = { regles: [] };
  try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) {
    console.log('Pas de config, aucune règle active.');
  }
  const regles = config.regles || [];

  // État précédent
  let state = { trains: [] };
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) {
    console.log('Pas d\u2019état précédent (premier passage).');
  }
  const prevKeys = new Set(state.trains || []);
  const firstRun = prevKeys.size === 0;

  // Snapshot du jour
  const dirs = [
    { dir: 'PR', label: 'Paris → Rennes', orig: 'PARIS%', dest: 'RENNES' },
    { dir: 'RP', label: 'Rennes → Paris', orig: 'RENNES', dest: 'PARIS%' }
  ];
  const nowKeys = [];
  const alertes = [];
  const today = new Date().toISOString().slice(0, 10);
  const histLines = [];

  for (const d of dirs) {
    const trains = await fetchDirection(d.orig, d.dest);
    console.log(`${d.label} : ${trains.length} trains MAX réservables`);
    for (const t of trains) {
      const key = trainKey(d.dir, t);
      nowKeys.push(key);
      histLines.push(JSON.stringify({ snapshot: today, dir: d.dir, date: t.date, train_no: t.train_no, dep: t.heure_depart }));
      if (!firstRun && !prevKeys.has(key) && matchRegles(regles, d.dir, t)) {
        alertes.push({ label: d.label, t });
      }
    }
  }

  // Alertes Telegram
  if (alertes.length > 0) {
    alertes.sort((a, b) => (a.t.date + a.t.heure_depart).localeCompare(b.t.date + b.t.heure_depart));
    let msg = `🚄 <b>TGV Max : ${alertes.length} nouveau${alertes.length > 1 ? 'x' : ''} train${alertes.length > 1 ? 's' : ''} réservable${alertes.length > 1 ? 's' : ''}</b>\n\n`;
    for (const a of alertes.slice(0, 20)) {
      const t = a.t;
      msg += `• ${a.label} — <b>${JOURS[dow(t.date)]} ${t.date.slice(8, 10)}/${t.date.slice(5, 7)}</b> ` +
        `${t.heure_depart.slice(0, 5)} → ${t.heure_arrivee.slice(0, 5)} (n°${t.train_no})\n`;
    }
    if (alertes.length > 20) msg += `… et ${alertes.length - 20} autres\n`;
    msg += '\n👉 Réserver : https://www.sncf-connect.com/';
    await sendTelegram(msg);
    console.log(`Alerte envoyée : ${alertes.length} trains.`);
  } else {
    console.log(firstRun ? 'Premier passage : état initialisé, pas d\u2019alerte.' : 'Aucun nouveau train dans les créneaux surveillés.');
  }

  // Sauvegarde état + historique
  fs.writeFileSync(STATE_FILE, JSON.stringify({ maj: new Date().toISOString(), trains: nowKeys }, null, 1));
  fs.appendFileSync(HIST_FILE, histLines.join('\n') + '\n');
  console.log('État sauvegardé :', nowKeys.length, 'trains.');
}

main().catch((e) => { console.error(e); process.exit(1); });
