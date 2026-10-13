/**
 * Synchronisation FFBB -> Firestore pour les équipes de l'Amicale
 * ----------------------------------------------------------------
 * Pour chaque équipe listée dans EQUIPES_FFBB, récupère le classement et les
 * rencontres de sa poule sur competitions.ffbb.com, puis les enregistre dans
 * la zone Firestore de l'équipe : equipes/<id>/...
 * (là où appli.html?equipe=<id> vient les lire).
 *
 * L'équipe PNM n'est PAS gérée ici : elle garde sa propre synchro (sync-ffbb.js).
 * Exécuté automatiquement par GitHub Actions toutes les ~20 minutes.
 */

// ===================== À MODIFIER : LISTE DES ÉQUIPES =====================
// Pour ajouter une équipe, copie un bloc { ... } et change :
//   id        : le même id que dans equipes.js du site (ex. "pnf", "u18-garcon")
//   url       : l'adresse de la compétition, SANS la partie après le "?"
//   phase     : le numéro après "phase=" dans l'adresse FFBB
//   poule     : le numéro après "poule=" dans l'adresse FFBB
//   nomPoule  : le texte affiché au-dessus du classement
const EQUIPES_FFBB = [
  {
    id: 'pnf',
    url: 'https://competitions.ffbb.com/ligues/ara/competitions/pnf',
    phase: '200000002897651',
    poule: '200000003055506',
    nomPoule: 'Pré-Nationale Féminine'
  },
  {
    id: 'rf3',
    url: 'https://competitions.ffbb.com/ligues/ara/competitions/rf3',
    phase: '200000002897655',
    poule: '200000003055527',
    nomPoule: 'Régionale Féminine - Division 3'
  }
];
// =========================================================================

const SAISON = 'ffbb-2026-27';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const API_HEADERS = { 'user-agent': 'okhttp/4.12.0' };

// Le club est reconnu par son nom FFBB (contient « CHAZEAU »)
function estClub(nom) {
  return (nom || '').toUpperCase().includes('CHAZEAU');
}

// ---------- Outils communs ----------

function formatHeureHHMM(heure) {
  const digits = String(heure || '').replace(/\D/g, '');
  if (digits.length === 3) return `0${digits[0]}:${digits.slice(1)}`;
  if (digits.length === 4) return `${digits.slice(0, 2)}:${digits.slice(2)}`;
  return '';
}

function teamName(e) {
  let nom = e?.nom || '';
  if (e?.numeroEquipe) nom += ` - ${e.numeroEquipe}`;
  return nom.trim();
}

function normalizeMatch(m, logoMap) {
  const dt = m.date_rencontre ? new Date(m.date_rencontre) : null;
  const nom1 = teamName(m.idEngagementEquipe1);
  const nom2 = teamName(m.idEngagementEquipe2);
  return {
    date: dt ? dt.toISOString().split('T')[0] : '',
    heure: formatHeureHHMM(dt),
    equipe1: nom1,
    equipe2: nom2,
    logo1: logoMap[nom1] || null,
    logo2: logoMap[nom2] || null,
    score1: m.joue ? parseInt(m.resultatEquipe1) : null,
    score2: m.joue ? parseInt(m.resultatEquipe2) : null,
    joue: !!m.joue,
    journee: m.numeroJournee || null,
    salle: m.lieuRencontre?.salle?.nom || m.salle?.libelle || '',
    ville: m.lieuRencontre?.adresse?.ville || m.salle?.cartographie?.adresse || '',
    source: SAISON
  };
}

function computeClassement(matchs) {
  const teams = {};
  for (const m of matchs) {
    for (const nom of [m.equipe1, m.equipe2]) {
      if (nom && !teams[nom]) teams[nom] = { nom, logo: m.logo1 || m.logo2 || null, joues: 0, gagnes: 0, perdus: 0, points: 0, diff: 0 };
    }
  }
  for (const m of matchs) {
    if (!m.joue) continue;
    const t1 = teams[m.equipe1];
    const t2 = teams[m.equipe2];
    if (!t1 || !t2) continue;
    const s1 = m.score1 || 0;
    const s2 = m.score2 || 0;
    t1.joues++; t2.joues++;
    t1.diff += (s1 - s2); t2.diff += (s2 - s1);
    if (s1 > s2) { t1.gagnes++; t2.perdus++; t1.points += 2; t2.points += 1; }
    else { t2.gagnes++; t1.perdus++; t2.points += 2; t1.points += 1; }
  }
  return Object.values(teams)
    .map(t => ({
      position: 0, equipe: t.nom, logo: t.logo,
      joues: t.joues, mj: t.joues, gagnes: t.gagnes, victoires: t.gagnes,
      perdus: t.perdus, defaites: t.perdus, difference: t.diff, points: t.points
    }))
    .sort((a, b) => b.points - a.points || b.difference - a.difference)
    .map((t, i) => ({ ...t, position: i + 1 }));
}

// ---------- Source 1 : scraping competitions.ffbb.com ----------

function extractJsonArray(html, key) {
  const searchKey = `\\"${key}\\":[`;
  const start = html.indexOf(searchKey);
  if (start === -1) return null;
  const contentStart = start + searchKey.length;
  let depth = 0, pos = contentStart;
  for (; pos < html.length; pos++) {
    const c = html[pos];
    if (c === '[') depth++;
    else if (c === ']') { if (depth === 0) break; depth--; }
  }
  const raw = html.substring(contentStart, pos);
  return JSON.parse(`[${raw.replace(/\\"/g, '"')}]`);
}

async function scrapeFromSite(eq) {
  const resp = await fetch(`${eq.url}?phase=${eq.phase}&poule=${eq.poule}`, { headers: { 'User-Agent': UA } });
  if (!resp.ok) throw new Error(`Scraping HTTP ${resp.status}`);
  const html = await resp.text();

  const ffbbMatchs = extractJsonArray(html, 'rencontres');
  if (!ffbbMatchs) throw new Error('Impossible d\'extraire les rencontres');

  const logoMap = {};
  for (const m of ffbbMatchs) {
    for (const e of [m.idEngagementEquipe1, m.idEngagementEquipe2]) {
      const nom = teamName(e);
      const logoId = e?.idOrganisme?.logo?.id;
      if (nom && logoId && !logoMap[nom]) {
        logoMap[nom] = `https://api.ffbb.com/assets/${logoId}?height=60&fit=contain&format=png`;
      }
    }
  }
  return ffbbMatchs.map(m => normalizeMatch(m, logoMap));
}

// ---------- Source 2 : API FFBB, plusieurs chemins essayés l'un après l'autre ----------

// Chaque chemin = un serveur + une façon d'écrire le filtre. Le premier qui répond est utilisé.
const ROUTES = [
  { nom: 'app-json',     base: 'https://api.ffbb.app/', style: 'json' },
  { nom: 'app-crochets', base: 'https://api.ffbb.app/', style: 'crochets' },
  { nom: 'com-json',     base: 'https://api.ffbb.com/', style: 'json' },
  { nom: 'com-crochets', base: 'https://api.ffbb.com/', style: 'crochets' }
];

const jetons = {};
let configAffichee = false;

async function getApiToken(base) {
  if (jetons[base]) return jetons[base];
  const res = await fetch(`${base}items/configuration`, { headers: API_HEADERS });
  if (!res.ok) throw new Error(`configuration HTTP ${res.status}`);
  const json = await res.json();
  if (!configAffichee && json?.data) {
    configAffichee = true;
    console.log(`Rubriques de configuration FFBB (${base}) : ${Object.keys(json.data).join(', ')}`);
  }
  const token = json?.data?.key_dh;
  if (!token) throw new Error('jeton introuvable');
  jetons[base] = token;
  return token;
}

function urlRencontres(route, eq) {
  const fields = [
    'id', 'date_rencontre', 'horaire', 'numeroJournee',
    'nomEquipe1', 'nomEquipe2', 'resultatEquipe1', 'resultatEquipe2', 'joue'
  ].join(',');
  const commun = `fields=${encodeURIComponent(fields)}&sort=date_rencontre&limit=300`;
  if (route.style === 'crochets') {
    return `${route.base}items/ffbbserver_rencontres?filter[idPoule][_eq]=${Number(eq.poule)}&${commun}`;
  }
  const filter = encodeURIComponent(JSON.stringify({ idPoule: { _eq: Number(eq.poule) } }));
  return `${route.base}items/ffbbserver_rencontres?filter=${filter}&${commun}`;
}

function convertir(data) {
  return (data || []).map(m => ({
    date: String(m.date_rencontre || '').slice(0, 10),
    heure: formatHeureHHMM(m.horaire),
    equipe1: m.nomEquipe1 || '',
    equipe2: m.nomEquipe2 || '',
    logo1: null,
    logo2: null,
    score1: m.resultatEquipe1 != null ? parseInt(m.resultatEquipe1) : null,
    score2: m.resultatEquipe2 != null ? parseInt(m.resultatEquipe2) : null,
    joue: !!m.joue,
    journee: m.numeroJournee ?? null,
    salle: '',
    ville: '',
    source: SAISON
  }));
}

async function fetchFromApi(eq) {
  for (const route of ROUTES) {
    try {
      await new Promise(r => setTimeout(r, 2000));
      const token = await getApiToken(route.base);
      const res = await fetch(urlRencontres(route, eq), { headers: { ...API_HEADERS, Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        console.log(`[${eq.id}] chemin ${route.nom} : refusé HTTP ${res.status} (serveur : ${res.headers.get('server') || '?'})`);
        continue;
      }
      const json = await res.json();
      const liste = convertir(json.data);
      if (!liste.length) {
        console.log(`[${eq.id}] chemin ${route.nom} : réponse reçue mais aucune rencontre`);
        continue;
      }
      console.log(`[${eq.id}] chemin ${route.nom} : OK`);
      return liste;
    } catch (e) {
      console.log(`[${eq.id}] chemin ${route.nom} : échec (${e.message})`);
    }
  }
  throw new Error('aucun chemin FFBB n\'a fonctionné');
}

// ---------- Écriture Firestore (zone de l'équipe) ----------

async function writeAll(admin, db, eq, matchs, classement) {
  const base = db.collection('equipes').doc(eq.id);

  const matchsClub = matchs
    .filter(m => estClub(m.equipe1) || estClub(m.equipe2))
    .map(m => {
      const isHome = estClub(m.equipe1);
      return { ...m, adversaire: isHome ? m.equipe2 : m.equipe1, lieu: isHome ? 'Domicile' : 'Extérieur' };
    });

  const classementSnap = await base.collection('classement').get();
  const b1 = db.batch();
  classementSnap.forEach(doc => b1.delete(doc.ref));
  for (const t of classement) b1.set(base.collection('classement').doc(), t);
  await b1.commit();

  const matchsSnap = await base.collection('matchs').get();
  const b2 = db.batch();
  matchsSnap.forEach(doc => b2.delete(doc.ref));
  for (const m of matchsClub) b2.set(base.collection('matchs').doc(), m);
  await b2.commit();

  const updatedAt = admin.firestore.FieldValue.serverTimestamp();
  await Promise.all([
    base.collection('ffbb').doc('poule').set({ nom: eq.nomPoule || 'Poule', classement, updatedAt, source: SAISON }),
    base.collection('ffbb').doc('rencontres').set({ matchs, updatedAt, source: SAISON })
  ]);

  return matchsClub.length;
}

async function syncEquipe(admin, db, eq) {
  let matchs;
  try {
    console.log(`[${eq.id}] Scraping competitions.ffbb.com...`);
    matchs = await scrapeFromSite(eq);
    console.log(`[${eq.id}] Scraping OK — ${matchs.length} rencontres`);
  } catch (e) {
    console.log(`[${eq.id}] Scraping échoué (${e.message}), bascule sur api.ffbb.app...`);
    matchs = await fetchFromApi(eq);
    console.log(`[${eq.id}] API OK — ${matchs.length} rencontres`);
  }
  const classement = computeClassement(matchs);
  const nb = await writeAll(admin, db, eq, matchs, classement);
  console.log(`[${eq.id}] OK — ${classement.length} équipes au classement, ${matchs.length} rencontres, ${nb} match(s) du club.`);
}

async function main() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error('Variable FIREBASE_SERVICE_ACCOUNT manquante');
  }
  const admin = require('firebase-admin');
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const db = admin.firestore();

  let echecs = 0;
  for (const eq of EQUIPES_FFBB) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      await syncEquipe(admin, db, eq);
    } catch (err) {
      echecs++;
      console.error(`[${eq.id}] ÉCHEC : ${err.message}`);
    }
  }
  if (echecs > 0) process.exit(1);
}

module.exports = { normalizeMatch, computeClassement, extractJsonArray, estClub, EQUIPES_FFBB, fetchFromApi };

if (require.main === module) {
  main().catch(err => {
    console.error('Échec de la synchronisation FFBB (équipes) :', err);
    process.exit(1);
  });
}
