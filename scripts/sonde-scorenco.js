/**
 * SONDE Scorenco (diagnostic, n'écrit rien dans Firebase)
 * Ouvre la page Scorenco dans un vrai navigateur sans écran, puis note :
 *  - si la page s'ouvre ou si elle est bloquée,
 *  - le texte affiché (classement, résultats...),
 *  - les adresses de données (JSON) que la page appelle en coulisse.
 * Les fichiers produits sont conservés dans l'exécution (rubrique « Artifacts »).
 */
const { chromium } = require('playwright');
const fs = require('fs');

const URL = process.env.SONDE_URL || 'https://scorenco.com/basket/clubs/firminy-chazeau-fayol-al-2szc/f1-2o1x';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ locale: 'fr-FR', userAgent: UA, viewport: { width: 1400, height: 1200 } });
  const page = await context.newPage();

  const appelsJson = [];
  let numero = 0;
  page.on('response', async r => {
    try {
      const ct = r.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      appelsJson.push(`${r.status()} ${r.request().method()} ${r.url()}`);
      if (numero < 25 && r.status() === 200) {
        const corps = await r.text();
        fs.writeFileSync(`json-${String(++numero).padStart(2, '0')}.json`, `${r.url()}\n${corps.slice(0, 200000)}`);
      }
    } catch (e) { /* on ignore */ }
  });

  const rep = await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('Statut de la page :', rep ? rep.status() : 'inconnu');
  await page.waitForTimeout(12000);

  const titre = await page.title();
  const texte = await page.evaluate(() => document.body.innerText);
  fs.writeFileSync('page.txt', texte);
  fs.writeFileSync('page.html', await page.content());
  await page.screenshot({ path: 'page.png', fullPage: true });

  console.log('Titre :', titre);
  console.log('Longueur du texte affiché :', texte.length);
  console.log('Adresses de données (JSON) appelées par la page :');
  appelsJson.slice(0, 40).forEach(l => console.log('  ' + l));
  console.log('--- Début du texte affiché ---');
  console.log(texte.slice(0, 2500));

  await browser.close();
})().catch(e => {
  console.error('ÉCHEC de la sonde :', e.message);
  process.exit(1);
});
