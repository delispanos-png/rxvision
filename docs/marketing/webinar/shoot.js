const { chromium } = require('playwright');
const fs = require('fs');

const ROUTES = [
  ['intelligence',  '/intelligence'],
  ['dashboard',     '/dashboard'],
  ['prescriptions', '/prescriptions'],
  ['vaccinations',  '/vaccinations'],
  ['future',        '/future'],
  ['patients',      '/patients'],
  ['advisor',       '/advisor'],
  ['copilot',       '/copilot'],
  ['nutrition',     '/nutrition'],
  ['profitability', '/profitability'],
  ['warehouse',     '/warehouse'],
  ['eshop-offers',  '/eshop-offers'],
  ['orders-delivery','/orders-delivery'],
  ['portal-admin',  '/portal-admin'],
  ['loyalty',       '/loyalty'],
  ['marketing',     '/marketing'],
  ['reimbursement', '/reimbursement'],
];

(async () => {
  const A = process.env.ACCESS, R = process.env.REFRESH;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1680, height: 945 }, deviceScaleFactor: 2, locale: 'el-GR' });
  await ctx.addInitScript(([a, r]) => {
    try {
      localStorage.setItem('access_token', a);
      localStorage.setItem('refresh_token', r);
      // Καθαρή οθόνη για παρουσίαση: προ-αποδοχή cookies ώστε να μη σκάσει το banner.
      localStorage.setItem('rxvision_cookie_consent', JSON.stringify({ choice: 'all', at: new Date().toISOString() }));
    } catch (e) {}
  }, [A, R]);

  // Κρύψε στοιχεία που δεν έχουν θέση σε προωθητικό slideshow: το tooltip/launcher του PharmaCat,
  // το κουμπί βοήθειας, το toast και το «Χωρίς κάρτα».
  const page = await ctx.newPage();
  await page.goto('https://app.rxvision.gr/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  for (const [name, route] of ROUTES) {
    try {
      await page.goto('https://app.rxvision.gr' + route, { waitUntil: 'networkidle', timeout: 45000 });
      await page.waitForTimeout(3500);          // άσε τα γραφήματα να ζωγραφιστούν
      await page.addStyleTag({ content: `
        [data-cookie-consent], .fixed.bottom-0, [aria-label*="Βοηθ"], [title*="Βοηθ"] { display: none !important; }
      `}).catch(() => {});
      // Κλείσε το tooltip του PharmaCat και το banner cookies αν εμφανιστούν παρ' όλα αυτά
      for (const sel of ['text=Αποδοχή όλων', 'text=Μόνο απαραίτητα']) {
        const b = page.locator(sel).first();
        if (await b.count() && await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); await page.waitForTimeout(400); }
      }
      await page.evaluate(() => {
        // tooltip PharmaCat + chip «Χωρίς κάρτα» + κουμπί βοήθειας: αφαίρεσέ τα από το DOM
        document.querySelectorAll('*').forEach((el) => {
          const t = (el.textContent || '').trim();
          if (el.children.length === 0 && (t === 'Χωρίς κάρτα' || t.startsWith('Θέλεις κάποια ερώτηση'))) {
            const box = el.closest('button, a, div');
            if (box && box.getBoundingClientRect().width < 420) box.style.display = 'none';
          }
        });
      }).catch(() => {});
      await page.waitForTimeout(500);
      await page.screenshot({ path: `/shots/${name}.png`, fullPage: false });
      console.log('OK   ' + name);
    } catch (e) { console.log('FAIL ' + name + ' — ' + String(e).slice(0, 90)); }
  }
  await browser.close();
})();
