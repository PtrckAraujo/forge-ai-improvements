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

  const id = await p.evaluate(async () => (await Kit.loadData()).nodes[0].id);
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

  await regressions(browser, watch, check, hasCompass);

  await browser.close();
  if (errors.length) { console.error('FAIL\n' + errors.join('\n')); process.exit(1); }
  console.log('ok: map' + (hasCompass ? ' + compass' : ''));
})();

/* One check per bug fixed after the code review, so none can come back. */
async function regressions(browser, watch, check, hasCompass) {
  const open = async (hash = '', size = { width: 1440, height: 1000 }, opts = {}) => {
    const p = await browser.newPage({ viewport: size, ...opts });
    watch(p);
    await p.goto(base + hash);
    await p.waitForFunction(() => document.getElementById('gate').hidden);
    await p.waitForTimeout(hash ? 900 : 2200);
    return p;
  };
  const zoom = p => p.evaluate(() => parseInt(document.getElementById('sZoom').textContent, 10));

  // number formats: the unit is chosen after rounding
  const p = await open();
  const f = await p.evaluate(() => [Kit.fmt.short(999600), Kit.fmt.short(9960), Kit.fmt.short(9940),
                                    Kit.fmt.pct(0.0996), Kit.fmt.pct(0.027)]);
  check(JSON.stringify(f) === '["1.0M","10K","9.9K","10%","2.7%"]', 'number formats ' + JSON.stringify(f));

  // a theme change keeps the user's own switches
  await p.click('[data-opt=cat]');
  await p.click('#btnTheme');
  check(await p.getAttribute('[data-opt=cat]', 'aria-pressed') === 'false', 'theme toggle kept colour = cluster');
  await p.click('.tabs [data-tab=rank]');
  await p.click('[data-opt=itr]');
  await p.click('#btnTheme');
  check(await p.getAttribute('[data-opt=itr]', 'aria-pressed') === 'false', 'theme toggle kept size = collaborations');

  // double-click on a node selects it and zooms in
  await p.click('#btnReset');
  await p.waitForTimeout(800);
  let hit = null;
  scan: for (let y = 250; y < 800; y += 6) {
    for (let x = 380; x < 1080; x += 6) {
      await p.mouse.move(x, y);
      if (await p.isVisible('#tip')) { hit = { x, y, name: await p.textContent('#tip b') }; break scan; }
    }
  }
  check(!!hit, 'found a node to double-click');
  if (hit) {
    await p.mouse.dblclick(hit.x, hit.y);
    await p.waitForTimeout(900);
    check(await p.evaluate(() => decodeURIComponent(location.hash.slice(1))) === hit.name.toLowerCase(),
          'double-click leaves the node selected');
    check(await p.isVisible('#card'), 'double-click shows the profile card');
    check(await zoom(p) >= 220, 'double-click zooms in to at least 220%');
  }

  // resizing with a profile open keeps the zoom level
  if (await p.isVisible('#card')) await p.click('#card .close');
  await p.fill('#q', 'a');
  await p.keyboard.press('Enter');
  await p.waitForTimeout(700);
  for (let i = 0; i < 4; i++) await p.click('#zOut');   // below the 105% a selection flies to
  const before = await zoom(p);
  check(before < 105, `zoomed out with a profile open (${before}%)`);
  await p.setViewportSize({ width: 1300, height: 900 });
  await p.waitForTimeout(300);
  check(await zoom(p) === before, `resize kept the zoom (${before}% → ${await zoom(p)}%)`);
  await p.close();

  // a link to a cluster opens the list that names it; a stale one is cleared
  const c = await open('#cluster/0');
  check(await c.getAttribute('.tabs [data-tab=cluster]', 'aria-selected') === 'true', '#cluster/0 shows the Clusters tab');
  check(await c.isVisible('#railBody [data-kind=cluster][data-key="0"].on'), '#cluster/0 marks its row');
  await c.evaluate(() => { location.hash = 'cluster/999'; });
  await c.waitForTimeout(400);
  check(await c.evaluate(() => location.hash) === '', 'unknown cluster link is cleared');
  check(await c.locator('#railBody .on').count() === 0, 'no row stays marked after an unknown link');
  await c.close();

  // the phone menu button reports the menu's real state
  const m = await open('', { width: 390, height: 844 }, { isMobile: true, hasTouch: true });
  await m.click('#btnMenu');
  await m.keyboard.press('Escape');
  check(await m.getAttribute('#btnMenu', 'aria-expanded') === 'false', 'Escape closes the menu and its aria state');
  await m.click('#btnMenu');
  await m.fill('#q', 'a');
  await m.keyboard.press('Enter');
  check(await m.getAttribute('#btnMenu', 'aria-expanded') === 'false', 'choosing a result closes the menu and its aria state');
  await m.close();

  if (!hasCompass) return;
  const k = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  watch(k);
  await k.goto(base + 'compass.html');
  await k.waitForTimeout(1500);
  const pressed = () => k.evaluate(() => +document.querySelector('#timeline [aria-pressed=true]').dataset.m);
  const shown = await k.evaluate(async () => (await Kit.loadData()).compass.months_shown);

  // filtering repaints without re-running the overlap pass
  const hypot = await k.evaluate(async () => {
    let n = 0;
    const h = Math.hypot;
    Math.hypot = (...a) => { n++; return h(...a); };
    const q = document.getElementById('fq');
    q.value = 'a';
    q.dispatchEvent(new Event('input'));
    Math.hypot = h;
    q.value = '';
    q.dispatchEvent(new Event('input'));
    return n;
  });
  check(hypot === 0, `filtering re-ran the layout (${hypot} distance computations)`);

  // ▶ on the last month plays again from the first
  await k.click(`#timeline [data-m="${shown[shown.length - 1]}"]`);
  await k.click('#play');
  await k.waitForTimeout(200);
  check(await pressed() === shown[0], 'play from the last month restarts at the first');
  check((await k.textContent('#play')).trim() === '❚❚', 'playback is running');
  await k.click('#play');

  // in a month, every axis uses that month's posts
  await k.click('#axis [data-y=side]');
  await k.click(`#timeline [data-m="${shown[1]}"]`);
  await k.waitForTimeout(300);
  const nd = await k.evaluate(async j => {
    const D = (await Kit.loadData()).compass, T = D.thresholds;
    const want = D.profiles.filter(p => p.months[j][0] >= T.min_month && p.months[j][3] + p.months[j][4] < T.min_sides).length;
    const got = document.querySelectorAll('#cpSvg .dot:not(.off) circle.nd').length;
    return [want, got];
  }, shown[1]);
  check(nd[0] === nd[1], `month view n.d. profiles on "against whom": expected ${nd[0]}, drawn ${nd[1]}`);

  // hollow n.d. rings are clickable, not just their outline
  const ring = k.locator('#cpSvg .dot:not(.off):has(circle.nd)').last();
  if (await ring.count()) {
    const key = await ring.evaluate(g => g.getAttribute('aria-label'));
    const clicked = await ring.click({ timeout: 3000 }).then(() => true, () => false);
    check(clicked && (await k.evaluate(() => location.hash)).length > 1, 'clicking an n.d. ring selects it: ' + key);
    await k.keyboard.press('Escape');
  }

  // the profile's monthly chart is scaled by the months it draws: pick a profile
  // whose thin months (not drawn) are hotter than every month that is drawn
  const tricky = await k.evaluate(async () => {
    const D = (await Kit.loadData()).compass, T = D.thresholds;
    const rate = m => m[1] / m[0];
    const p = D.profiles.find(p => {
      const drawn = p.months.filter(m => m[0] >= T.min_month).map(rate);
      const thin = p.months.filter(m => m[0] > 0 && m[0] < T.min_month).map(rate);
      return drawn.length && thin.length && Math.max(...thin) > Math.max(...drawn);
    });
    return p && p.name;
  });
  check(!!tricky, 'sample has a profile with a hot thin month');
  await k.evaluate(key => { location.hash = key; }, tricky);
  await k.waitForTimeout(400);
  const heights = await k.evaluate(() =>
    [...document.querySelectorAll('.side-detail .months span')].map(s => parseFloat(s.style.height)));
  check(heights.length > 0 && Math.max(...heights) === 100, 'tallest monthly bar fills the chart ' + JSON.stringify(heights));
  await k.close();
}
