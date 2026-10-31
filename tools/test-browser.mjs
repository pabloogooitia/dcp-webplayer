// Prueba del player en Chromium con Playwright (solo para desarrollo).
// Uso: node tools/test-browser.mjs http://127.0.0.1:8765/ carpeta_con_dcps carpeta_capturas
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [url, root, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const results = [];

for (const name of readdirSync(root).sort()) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  await page.goto(url);
  await page.setInputFiles('#dirInput', join(root, name));
  await page.waitForSelector('#ficha:not(.hidden)', { timeout: 20000 });
  const enc = await page.evaluate(() => window.__dcp.cpl.encrypted);
  const r = { name, enc, errors };
  if (!enc) {
    await page.waitForFunction(() => document.getElementById('view').dataset.frame == window.__dcp.frame && document.getElementById('view').dataset.level === '0', null, { timeout: 30000 });
    // colores de las barras (fila y = 10 % del alto) y del degradado
    r.pixels = await page.evaluate(() => {
      const cv = document.getElementById('view');
      const ctx = cv.getContext('2d');
      const y = Math.round(cv.height * 0.15);
      const out = [];
      for (let k = 0; k < 7; k++) {
        const x = Math.round(cv.width * (k + 0.5) / 7);
        out.push(Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3)));
      }
      const gy = Math.round(cv.height * 0.9);
      const grad = [0.25, 0.5, 0.75].map(f => Array.from(ctx.getImageData(Math.round(cv.width * f), gy, 1, 1).data.slice(0, 3)));
      return { size: [cv.width, cv.height], bars: out, grad };
    });
    r.hud = await page.textContent('#hud');
    await page.screenshot({ path: join(out, name + '-1-inicio.png'), fullPage: true });
    // a 0,5 s + 1 fotograma (subtítulo visible), con teclado
    await page.focus('body');
    await page.keyboard.press('Shift+ArrowRight');
    for (let i = 0; i < 1; i++) await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(200);
    await page.waitForFunction(() => document.getElementById('view').dataset.frame == window.__dcp.frame && document.getElementById('view').dataset.level === '0', null, { timeout: 30000 });
    r.tcAt1s = await page.textContent('#tc');
    r.subs = await page.evaluate(() => Array.from(document.querySelectorAll('#subs .sub-item')).map(d => d.textContent || (d.querySelector('img') ? '[img]' : '')));
    await page.locator('#stageWrap').screenshot({ path: join(out, name + '-2-subs.png') });
    // fin de la CPL
    await page.keyboard.press('End');
    await page.waitForTimeout(300);
    await page.waitForFunction(() => document.getElementById('view').dataset.frame == window.__dcp.frame && document.getElementById('view').dataset.level === '0', null, { timeout: 30000 });
    r.tcEnd = await page.textContent('#tc');
    r.posEnd = await page.textContent('#pos');
    await page.locator('#stageWrap').screenshot({ path: join(out, name + '-3-final.png') });
    // sonido
    await page.keyboard.press('Home');
    await page.waitForTimeout(300);
    await page.click('#bPlay');
    await page.waitForSelector('#meters .meter', { timeout: 15000 });
    await page.waitForTimeout(1500);
    r.playingTc = await page.textContent('#tc');
    r.meters = await page.evaluate(() => Array.from(document.querySelectorAll('#meters .meter')).map(m => m.querySelector('.l').textContent + ':' + m.querySelector('.db').textContent));
    await page.screenshot({ path: join(out, name + '-4-sonido.png'), fullPage: true });
    await page.click('#bPlay');
  } else {
    await page.waitForTimeout(800);
    r.msg = await page.textContent('#msg');
    await page.screenshot({ path: join(out, name + '-1-inicio.png'), fullPage: true });
  }
  r.chips = await page.evaluate(() => Array.from(document.querySelectorAll('#ficha .chip')).map(c => c.textContent));
  r.verdict = await page.textContent('#ficha .verdict');
  results.push(r);
  await page.close();
}
await browser.close();
console.log(JSON.stringify(results, null, 1));
