/**
 * SONDE Scorenco n°2 (diagnostic, n'écrit rien dans Firebase)
 * Ouvre la page Scorenco dans un navigateur sans écran et relève précisément les demandes
 * faites au serveur de données (graphql.scorenco.com) : leur contenu et un extrait des réponses.
 * Les détails sont conservés dans les fichiers json-XX.json (rubrique « Artifacts »).
 */
const { chromium } = require('playwright');
const fs = require('fs');

const URL = process.env.SONDE_URL || 'https://scorenco.com/basket/clubs/firminy-chazeau-fayol-al-2szc/f1-2o1x';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function entetesSurs(h) {
  const sortie = {};
  for (const k of Object.keys(h)) {
    if (k === 'cookie') continue;
    sortie[k] = k === 'authorization' ? '(présent, masqué)' : h[k];
  }
  return sortie;
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ locale: 'fr-FR', userAgent: UA, viewport: { width: 1400, height: 1200 } });
  const page = await context.newPage();

  let numero = 0;
  page.on('response', async r => {
    try {
      if (!r.url().includes('graphql.scorenco.com')) return;
      const req = r.request();
      const corps = req.postData() || '';
      let operations = [];
      try {
        const j = JSON.parse(corps);
        operations = (Array.isArray(j) ? j : [j]).map(o => ({
          operation: o.operationName || '(sans nom)',
          variables: o.variables || {},
          requete: String(o.query || '').slice(0, 4000)
        }));
      } catch (e) { operations = [{ operation: '(corps illisible)', brut: corps.slice(0, 2000) }]; }

      const reponse = (await r.text()).slice(0, 60000);
      const n = ++numero;
      fs.writeFileSync(`json-${String(n).padStart(2, '0')}.json`, JSON.stringify({
        statut: r.status(), adresse: r.url(), entetes: entetesSurs(req.headers()), operations, reponse
      }, null, 1));
      console.log(`GRAPHQL ${n} [${r.status()}] ${operations.map(o => o.operation + ' ' + JSON.stringify(o.variables).slice(0, 220)).join(' || ')}`);
    } catch (e) { /* on ignore */ }
  });

  const rep = await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('Statut de la page :', rep ? rep.status() : 'inconnu');
  await page.waitForTimeout(12000);

  const texte = await page.evaluate(() => document.body.innerText);
  fs.writeFileSync('page.txt', texte);
  fs.writeFileSync('page.html', await page.content());
  await page.screenshot({ path: 'page.png', fullPage: true });

  console.log('Titre :', await page.title());
  console.log('Nombre de demandes de données Scorenco :', numero);
  console.log('--- Texte affiché (résumé sur une ligne) ---');
  console.log(texte.replace(/\s*\n\s*/g, ' | ').slice(0, 2600));

  await browser.close();
})().catch(e => {
  console.error('ÉCHEC de la sonde :', e.message);
  process.exit(1);
});
