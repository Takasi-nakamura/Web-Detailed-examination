const chromium = require('@sparticuz/chromium');
const { chromium: playwright } = require('playwright-core');
const dns = require('node:dns').promises;

function blockedIp(ip) {
  if (ip.includes(':')) {
    const x = ip.toLowerCase();
    return x === '::1' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb');
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4) return true;
  return p[0] === 10 || p[0] === 127 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || p[0] === 0;
}

async function assertPublicUrl(raw) {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('HTTPまたはHTTPSのURLのみ対応しています');
  if (u.username || u.password) throw new Error('認証情報を含むURLは使用できません');
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') throw new Error('ローカルホストは調査できません');
  const records = await dns.lookup(host, { all: true });
  if (!records.length || records.some(x => blockedIp(x.address))) throw new Error('プライベートネットワークのURLは調査できません');
  return u.href;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const raw = Array.isArray(req.query?.url) ? req.query.url[0] : req.query?.url;
  if (!raw) return res.status(400).json({ error: 'url is required' });

  let url;
  try { url = await assertPublicUrl(raw); }
  catch (e) { return res.status(400).json({ error: e.message || 'URLが不正です' }); }

  let browser;
  try {
    browser = await playwright.launch({
      args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox'],
      executablePath: await chromium.executablePath(),
      headless: true,
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      userAgent: 'Web-Detailed-Examination/1.0 (+website-audit)',
    });
    const page = await context.newPage();
    const failedRequests = [];
    const consoleErrors = [];
    page.on('requestfailed', r => { if (failedRequests.length < 100) failedRequests.push({ url: r.url(), method: r.method(), error: r.failure()?.errorText || '' }); });
    page.on('console', m => { if (m.type() === 'error' && consoleErrors.length < 100) consoleErrors.push(m.text()); });

    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1200);

    const html = await page.content();
    const finalUrl = page.url();
    const title = await page.title().catch(() => '');
    const status = response?.status() ?? null;
    const contentType = response?.headers()['content-type'] || '';
    const bodyTextLength = await page.locator('body').innerText({ timeout: 3000 }).then(t => t.length).catch(() => 0);

    return res.status(200).json({
      ok: true,
      url,
      finalUrl,
      status,
      contentType,
      title,
      bodyTextLength,
      html,
      browser: { engine: 'Chromium', rendered: true, viewport: { width: 1440, height: 900 } },
      consoleErrors,
      failedRequests,
    });
  } catch (e) {
    return res.status(502).json({ ok: false, error: e.message || 'ブラウザでページを開けませんでした' });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
};
