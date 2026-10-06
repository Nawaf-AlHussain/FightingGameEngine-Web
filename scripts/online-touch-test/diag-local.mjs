// Quick local-boot diagnostic: what does /play?p1=kfm&p2=kfm&p2ai=4 do?
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:3210';
const browser = await chromium.launch({
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-features=WebRtcHideLocalIpsWithMdns'],
});
const ctx = await browser.newContext({
  viewport: { width: 844, height: 390 }, deviceScaleFactor: 3,
  isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
const page = await ctx.newPage();
page.on('console', (m) => console.log('CONSOLE: ' + m.text().slice(0, 200)));
page.on('pageerror', (e) => console.log('PAGEERROR: ' + e.message));

await page.goto(BASE + '/play?p1=kfm&p2=kfm&p2ai=4', { waitUntil: 'domcontentloaded', timeout: 60000 });
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(10000);
  const st = await page.evaluate(() => {
    const c = document.querySelector('canvas#ikemen-canvas');
    const boot = document.querySelector('[class*="boot"], pre, code');
    return {
      canvas: !!c, w: c ? c.width : 0, h: c ? c.height : 0,
      dispW: c ? c.style.width : '',
      bootText: boot ? boot.textContent.slice(-300) : '(no boot el)',
      touch: !!document.querySelector('#ikemen-touch'),
    };
  }).catch((e) => ({ err: e.message }));
  console.log(`t=${(i + 1) * 10}s  ` + JSON.stringify(st));
  if (st.canvas && st.w > 0) {
    // try a frame grab
    const px = await page.evaluate(() => new Promise((res) => {
      requestAnimationFrame(() => {
        try {
          const c = document.querySelector('canvas#ikemen-canvas');
          const t = document.createElement('canvas');
          t.width = 96; t.height = 54;
          const cx = t.getContext('2d');
          cx.drawImage(c, 0, 0, 96, 54);
          const d = cx.getImageData(0, 0, 96, 54).data;
          let nz = 0;
          for (let k = 0; k < d.length; k += 4) if (d[k] || d[k + 1] || d[k + 2]) nz++;
          res({ nonzero: nz, total: d.length / 4 });
        } catch (e) { res({ err: e.message }); }
      });
    }));
    console.log('  framegrab: ' + JSON.stringify(px));
  }
}
await page.screenshot({ path: '/home/z/my-project/scripts/online-touch-test/local-diag.png' });
await browser.close();
