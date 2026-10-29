/* Browser smoke test: loads both pages, exercises the main interactions and
   fails on any page error. Needs Playwright with Chromium.

     cd site && python3 -m http.server 8765 --bind 127.0.0.1 &
     node tests/smoke.js http://127.0.0.1:8765/ [screenshot-dir]
*/
const { chromium } = require('playwright');

const base = process.argv[2] || 'http://127.0.0.1:8765/';
const shots = process.argv[3];

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const watch = p => {
    p.on('pageerror', e => errors.push(e.message));
    p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  };
  const check = (cond, what) => { if (!cond) errors.push('check failed: ' + what); };
  const snap = (p, name) => shots && p.screenshot({ path: `${shots}/${name}.png` });

  const p = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  watch(p);
  await p.goto(base);
  await p.waitForFunction(() => document.getElementById('gate').hidden, null, { timeout: 10000 });
  await p.waitForTimeout(1800);
  await snap(p, 'map');

  await p.fill('#q', 'a');
  check(await p.locator('#sugg li[data-i]').count() > 0, 'search suggestions');
  await p.keyboard.press('Enter');
  await p.waitForTimeout(700);
  check(/^#.+/.test(await p.evaluate(() => location.hash)), 'selection hash');
  check(await p.isVisible('#card'), 'profile card open');
  await snap(p, 'selected');

  await p.keyboard.press('Escape');
  await p.click('.tabs [data-tab=cluster]');
  await p.click('#railBody [data-kind=cluster]');
  await p.waitForTimeout(700);
  check((await p.evaluate(() => location.hash)).startsWith('#cluster/'), 'cluster focus hash');

  for (const tab of ['bridge', 'rank']) await p.click(`.tabs [data-tab=${tab}]`);
  await p.click('[data-opt=photos]');
  await p.click('[data-opt=matrix]');
  check(await p.isVisible('#mx td[data-a]'), 'matrix cells');
  await p.click('#mx td[data-a]');
  await p.waitForTimeout(600);
  check((await p.evaluate(() => location.hash)).startsWith('#pair/'), 'pair focus from matrix');
  await p.click('#btnTheme');
  check(await p.evaluate(() => document.documentElement.dataset.theme) === 'dark', 'dark theme');
  await snap(p, 'dark');
  await p.click('#btnInfo');
  check(await p.isVisible('#info'), 'info dialog');
  await p.keyboard.press('Escape');

  const id = await p.evaluate(() => document.querySelector('#railBody [data-id]')?.dataset.id);
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  watch(phone);
  await phone.goto(base + '#' + encodeURIComponent(id));
  await phone.waitForTimeout(1200);
  check(await phone.isVisible('#card'), 'deep link opens the card on a phone');
  check(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal scroll (map)');
  await snap(phone, 'phone');

  const hasCompass = await p.evaluate(() => !document.getElementById('teaser').hidden);
  if (hasCompass) {
    const c = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    watch(c);
    await c.goto(base + 'compass.html');
    await c.waitForTimeout(1500);
    check(await c.locator('#cpSvg .dot').count() > 0, 'compass dots');
    await c.locator('#cpSvg .dot:not(.off)').last().click();
    await c.waitForTimeout(500);
    check(await c.isVisible('.side-detail'), 'compass profile detail');
    await c.click('#axis [data-y=side]');
    await c.click('#timeline [data-m]:nth-of-type(3)');
    await c.waitForTimeout(800);
    await snap(c, 'compass');
    await phone.goto(base + 'compass.html');
    await phone.waitForTimeout(1200);
    check(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal scroll (compass)');
  }

  await browser.close();
  if (errors.length) { console.error('FAIL\n' + errors.join('\n')); process.exit(1); }
  console.log('ok: map' + (hasCompass ? ' + compass' : ''));
})();
