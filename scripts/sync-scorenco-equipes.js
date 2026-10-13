/**
 * Synchronisation Scorenco -> Firestore pour les équipes de l'Amicale
 * -------------------------------------------------------------------
 * Ouvre la page Scorenco de chaque équipe dans un navigateur sans écran,
 * lit le classement de la poule, les résultats et le prochain match,
 * puis les enregistre dans la zone Firestore de l'équipe : equipes/<id>/...
 * (là où appli.html?equipe=<id> vient les lire).
 *
 * L'équipe PNM n'est PAS gérée ici : elle garde sa synchro FFBB (sync-ffbb.js).
 */

// ===================== À MODIFIER : LISTE DES ÉQUIPES =====================
// id            : le même id que dans equipes.js du site
// url           : l'adresse de la page de l'équipe sur Scorenco
// nomClub       : nom du club tel qu'il doit apparaître dans l'appli (doit contenir CHAZEAU)
// libelleEquipe : comment Scorenco appelle l'équipe dans la liste des résultats (ex. SENIOR F1)
const EQUIPES_SCORENCO = [
  {
    id: 'pnf',
    url: 'https://scorenco.com/basket/clubs/firminy-chazeau-fayol-al-2szc/f1-2o1x',
    nomClub: 'FIRMINY CHAZEAU-FAYOL AL',
    libelleEquipe: 'SENIOR F1'
  }
];
// Seuls les matchs à partir de cette date sont conservés (début de la saison en cours)
const SAISON_DEBUT = '2026-08-01';
// =========================================================================

const SOURCE = 'scorenco-2026-27';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ---------- Outils de lecture du texte ----------

const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MOIS = ['janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre'];

function sansAccent(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}
function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const estEntier = t => /^\d+$/.test(t);

// Retrouve l'année d'une date écrite sans année (« samedi 10 octobre ») grâce au jour de la semaine.
// sens = 'passe' : la date la plus récente qui n'est pas dans le futur ; 'futur' : la prochaine à venir.
function resoudreDate(jourSemaine, jour, moisTexte, sens, aujourdhui) {
  const m = MOIS.indexOf(sansAccent(moisTexte));
  const j = JOURS.indexOf(sansAccent(jourSemaine));
  if (m < 0 || j < 0) return null;
  const an = aujourdhui.getFullYear();
  const candidats = [an - 1, an, an + 1]
    .map(a => new Date(a, m, Number(jour), 12, 0, 0))
    .filter(d => d.getMonth() === m && d.getDay() === j);
  const limite = new Date(aujourdhui.getFullYear(), aujourdhui.getMonth(), aujourdhui.getDate(), 12, 0, 0);
  if (sens === 'passe') {
    const ok = candidats.filter(d => d <= new Date(limite.getTime() + 86400000));
    return ok.length ? iso(ok[ok.length - 1]) : null;
  }
  const ok = candidats.filter(d => d >= new Date(limite.getTime() - 86400000));
  return ok.length ? iso(ok[0]) : null;
}

const RE_ENTETE_JOUR = /^(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+(\d{1,2})\s+([A-Za-zÀ-ÿ]+)$/i;

// ---------- Résultats ----------
function lireResultats(tokens, aujourdhui) {
  const debut = tokens.findIndex(t => t.toUpperCase() === 'CALENDRIER');
  const finIdx = tokens.findIndex((t, i) => i > debut && (/^charger plus$/i.test(t) || /^b[ée]n[ée]vole de ce club/i.test(t) || /^classement\b/i.test(t)));
  const zone = tokens.slice(debut + 1, finIdx > 0 ? finIdx : tokens.length);
  const matchs = [];
  let dateCourante = null;
  for (let i = 0; i < zone.length;) {
    const h = zone[i].match(RE_ENTETE_JOUR);
    if (h) { dateCourante = resoudreDate(h[1], h[2], h[3], 'passe', aujourdhui); i++; continue; }
    if (dateCourante && estEntier(zone[i + 1] || '') && estEntier(zone[i + 2] || '') && zone[i + 3]) {
      matchs.push({
        date: dateCourante,
        equipe1: zone[i], score1: parseInt(zone[i + 1], 10),
        score2: parseInt(zone[i + 2], 10), equipe2: zone[i + 3],
        competition: zone[i + 4] || ''
      });
      i += 5;
      continue;
    }
    i++;
  }
  return matchs;
}

// ---------- Dernier et prochain match (bloc du haut de la page) ----------
function lireHeureDernierMatch(tokens) {
  const k = tokens.findIndex(t => /^dernier match$/i.test(t));
  if (k < 0) return null;
  const m = (tokens[k + 1] || '').match(/(\d{1,2})\s+([A-Za-zÀ-ÿ]+)\s*-\s*(\d{1,2}:\d{2})/);
  return m ? { jour: Number(m[1]), mois: sansAccent(m[2]), heure: m[3] } : null;
}

function lireProchainMatch(tokens, aujourdhui) {
  const k = tokens.findIndex(t => /^prochain match$/i.test(t));
  if (k < 0) return null;
  const equipe1 = tokens[k + 1];
  const jourSemaine = tokens[k + 2];
  const dm = (tokens[k + 3] || '').match(/^(\d{1,2})\s+([A-Za-zÀ-ÿ]+)$/);
  const heure = /^\d{1,2}:\d{2}$/.test(tokens[k + 4] || '') ? tokens[k + 4] : '';
  const equipe2 = tokens[k + (heure ? 5 : 4)];
  if (!equipe1 || !jourSemaine || !dm || !equipe2) return null;
  const date = resoudreDate(jourSemaine, dm[1], dm[2], 'futur', aujourdhui);
  if (!date) return null;
  return { date, heure, equipe1, equipe2, competition: tokens[k + (heure ? 6 : 5)] || '' };
}

// ---------- Classement ----------
function lireClassement(tokens) {
  const k = tokens.findIndex(t => /^classement\b/i.test(t));
  if (k < 0) return null;
  const nomPoule = tokens[k + 1] || '';
  const iEq = tokens.findIndex((t, i) => i > k && /^[ée]quipes$/i.test(t));
  const iForme = tokens.findIndex((t, i) => i > iEq && /^forme$/i.test(t));
  if (iEq < 0 || iForme < 0) return null;

  // 1) la liste « rang, nom » avant les titres de colonnes
  const equipes = [];
  for (let i = iEq + 1; i < iForme; i++) {
    if (estEntier(tokens[i]) && tokens[i + 1] && !estEntier(tokens[i + 1]) && !/^(PTS|JO|G-P|BP|BC|DIFF|RATIO|FORME)$/i.test(tokens[i + 1])) {
      equipes.push({ position: parseInt(tokens[i], 10), equipe: tokens[i + 1] });
      i++;
    }
  }
  // 2) puis, équipe par équipe : PTS JO G - P BP BC DIFF puis V/D...
  let p = iForme + 1;
  const lignes = [];
  for (const e of equipes) {
    const nb = () => { const t = tokens[p++]; return /^-?\d+$/.test(t || '') ? parseInt(t, 10) : NaN; };
    const points = nb(), joues = nb(), gagnes = nb();
    if (tokens[p] === '-') p++;
    const perdus = nb(), bp = nb(), bc = nb(), diff = nb();
    while (/^[VDNE]$/i.test(tokens[p] || '')) p++;
    if ([points, joues, gagnes, perdus, bp, bc, diff].some(Number.isNaN)) return null;
    lignes.push({
      position: e.position, equipe: e.equipe, logo: null,
      joues, mj: joues, gagnes, victoires: gagnes, perdus, defaites: perdus,
      pointsMarques: bp, pointsEncaisses: bc, difference: diff, points
    });
  }
  return { nomPoule, classement: lignes };
}

// ---------- Assemblage des matchs au format de l'appli ----------
function assemblerMatchs(eq, resultats, prochain, dernierHeure) {
  const club = eq.nomClub;
  const estNous = nom => nom.trim().toUpperCase() === eq.libelleEquipe.toUpperCase() || nom.toUpperCase().includes('CHAZEAU');
  const nettoyer = nom => estNous(nom) ? club : nom.replace(/\s+-\s*$/, '').trim();
  const liste = [];

  for (const r of resultats) {
    if (r.date < SAISON_DEBUT) continue;
    const e1 = nettoyer(r.equipe1), e2 = nettoyer(r.equipe2);
    let heure = '';
    if (dernierHeure && r.date.slice(8) === String(dernierHeure.jour).padStart(2, '0') && MOIS[parseInt(r.date.slice(5, 7), 10) - 1] === dernierHeure.mois) heure = dernierHeure.heure;
    liste.push({ date: r.date, heure, equipe1: e1, equipe2: e2, logo1: null, logo2: null, score1: r.score1, score2: r.score2, joue: true, journee: null, salle: '', ville: '', source: SOURCE });
  }
  if (prochain && prochain.date >= SAISON_DEBUT) {
    liste.push({ date: prochain.date, heure: prochain.heure, equipe1: nettoyer(prochain.equipe1), equipe2: nettoyer(prochain.equipe2), logo1: null, logo2: null, score1: null, score2: null, joue: false, journee: null, salle: '', ville: '', source: SOURCE });
  }
  liste.sort((a, b) => (a.date + a.heure).localeCompare(b.date + b.heure));
  return liste.map(m => {
    const domicile = m.equipe1 === club;
    return { ...m, adversaire: domicile ? m.equipe2 : m.equipe1, lieu: domicile ? 'Domicile' : 'Extérieur' };
  });
}

function analyserPage(texte, eq, aujourdhui = new Date()) {
  const tokens = texte.split('\n').map(t => t.replace(/\u200b/g, '').trim()).filter(Boolean);
  const resultats = lireResultats(tokens, aujourdhui);
  const prochain = lireProchainMatch(tokens, aujourdhui);
  const dernierHeure = lireHeureDernierMatch(tokens);
  const cl = lireClassement(tokens);
  const matchs = assemblerMatchs(eq, resultats, prochain, dernierHeure);
  return { resultats, prochain, cl, matchs };
}

// ---------- Navigateur ----------
async function lirePage(browser, eq) {
  const context = await browser.newContext({ locale: 'fr-FR', userAgent: UA, viewport: { width: 1400, height: 1400 } });
  const page = await context.newPage();
  const rep = await page.goto(eq.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log(`[${eq.id}] Page Scorenco : statut ${rep ? rep.status() : '?'}`);
  await page.waitForSelector('text=Classement', { timeout: 45000 });
  await page.waitForTimeout(3000);
  for (let i = 0; i < 6; i++) {            // « Charger plus » : on déroule les anciens résultats
    const bouton = page.getByText('Charger plus', { exact: true });
    if (!(await bouton.count())) break;
    await bouton.first().click().catch(() => {});
    await page.waitForTimeout(1500);
  }
  const texte = await page.evaluate(() => document.body.innerText);
  await context.close();
  return texte;
}

// ---------- Écriture Firestore ----------
async function ecrire(admin, db, eq, poule, matchs) {
  const base = db.collection('equipes').doc(eq.id);

  const snapC = await base.collection('classement').get();
  const b1 = db.batch();
  snapC.forEach(d => b1.delete(d.ref));
  for (const t of poule.classement) b1.set(base.collection('classement').doc(), t);
  await b1.commit();

  const snapM = await base.collection('matchs').get();
  const b2 = db.batch();
  snapM.forEach(d => b2.delete(d.ref));
  for (const m of matchs) b2.set(base.collection('matchs').doc(), m);
  await b2.commit();

  const updatedAt = admin.firestore.FieldValue.serverTimestamp();
  await Promise.all([
    base.collection('ffbb').doc('poule').set({ nom: poule.nomPoule || 'Poule', classement: poule.classement, updatedAt, source: SOURCE }),
    base.collection('ffbb').doc('rencontres').set({ matchs, updatedAt, source: SOURCE })
  ]);
}

async function main() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error('Variable FIREBASE_SERVICE_ACCOUNT manquante');
  const fs = require('fs');
  const { chromium } = require('playwright');
  const admin = require('firebase-admin');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  const db = admin.firestore();

  const browser = await chromium.launch();
  let echecs = 0;
  for (const eq of EQUIPES_SCORENCO) {
    try {
      const texte = await lirePage(browser, eq);
      fs.writeFileSync(`scorenco-${eq.id}.txt`, texte);   // conservé pour le diagnostic
      const { resultats, prochain, cl, matchs } = analyserPage(texte, eq);
      console.log(`[${eq.id}] Lu : ${resultats.length} résultat(s), prochain match : ${prochain ? prochain.date + ' ' + prochain.heure + ' contre ' + (prochain.equipe2) : 'aucun'}, classement : ${cl ? cl.classement.length + ' équipe(s)' : 'illisible'}`);
      if (!cl || cl.classement.length < 2) throw new Error('classement illisible : rien n\'est écrit');
      if (!matchs.length) throw new Error('aucun match de la saison trouvé : rien n\'est écrit');
      await ecrire(admin, db, eq, cl, matchs);
      console.log(`[${eq.id}] OK — ${cl.classement.length} équipes au classement, ${matchs.length} match(s) enregistré(s) (poule : ${cl.nomPoule}).`);
    } catch (err) {
      echecs++;
      console.error(`[${eq.id}] ÉCHEC : ${err.message}`);
    }
  }
  await browser.close();
  if (echecs > 0) process.exit(1);
}

module.exports = { analyserPage, resoudreDate, EQUIPES_SCORENCO };

if (require.main === module) {
  main().catch(err => { console.error('Échec de la synchronisation Scorenco :', err); process.exit(1); });
}
