const chromium = require('@sparticuz/chromium');
const { chromium: playwright } = require('playwright-core');
const dns = require('node:dns').promises;

function blockedIp(ip) {
  const x = String(ip).toLowerCase();
  if (x.includes(':')) return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb');
  const p = x.split('.').map(Number);
  if (p.length !== 4 || p.some(Number.isNaN)) return true;
  return p[0] === 0 || p[0] === 10 || p[0] === 127 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168);
}

async function publicUrl(raw) {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('HTTPまたはHTTPSのURLのみ対応しています');
  if (u.username || u.password) throw new Error('認証情報を含むURLは使用できません');
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') throw new Error('ローカルホストは調査できません');
  const records = await dns.lookup(host, { all: true });
  if (!records.length || records.some(r => blockedIp(r.address))) throw new Error('プライベートネットワークのURLは調査できません');
  return u.href;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function collectPage(page, viewport, label) {
  const failedRequests = [];
  const consoleErrors = [];
  page.on('requestfailed', r => { if (failedRequests.length < 120) failedRequests.push({ url: r.url(), method: r.method(), error: r.failure()?.errorText || '' }); });
  page.on('console', m => { if (m.type() === 'error' && consoleErrors.length < 120) consoleErrors.push(m.text()); });

  const started = Date.now();
  let response = null;
  try { response = await page.goto(page.url(), { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (e) {
    if (!page.url()) throw e;
  }
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await sleep(1200);

  const data = await page.evaluate(() => {
    const visible = el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const text = el => (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 180);
    const rect = el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; };
    const els = sel => [...document.querySelectorAll(sel)];
    const headings = els('h1,h2,h3,h4,h5,h6').filter(visible).map(e => ({ tag: e.tagName, text: text(e), rect: rect(e) })).slice(0, 120);
    const buttons = els('button,[role="button"],input[type="button"],input[type="submit"]').filter(visible).map(e => ({ tag: e.tagName, text: text(e), aria: e.getAttribute('aria-label') || '', disabled: !!e.disabled, rect: rect(e) })).slice(0, 150);
    const links = els('a[href]').filter(visible).map(e => ({ text: text(e), href: e.href, rect: rect(e) })).slice(0, 180);
    const inputs = els('input,textarea,select').filter(visible).map(e => ({ tag: e.tagName, type: e.type || '', name: e.name || '', placeholder: e.placeholder || '', aria: e.getAttribute('aria-label') || '', required: !!e.required, rect: rect(e) })).slice(0, 120);
    const images = els('img').map(e => ({ src: e.currentSrc || e.src, alt: e.alt || '', width: e.naturalWidth || e.width, height: e.naturalHeight || e.height, loading: e.loading || '' })).slice(0, 160);
    const navs = els('nav,[role="navigation"]').filter(visible).map(e => ({ text: text(e).slice(0, 500), rect: rect(e) })).slice(0, 30);
    const modals = els('[role="dialog"],dialog').filter(visible).map(e => ({ text: text(e).slice(0, 1000), rect: rect(e) })).slice(0, 30);
    const landmarks = els('header,main,footer,aside,nav,section').filter(visible).map(e => ({ tag: e.tagName, id: e.id || '', label: e.getAttribute('aria-label') || '', rect: rect(e) })).slice(0, 150);
    const styles = [...document.styleSheets].length;
    const body = document.body;
    const scrollHeight = Math.max(document.documentElement.scrollHeight, body?.scrollHeight || 0);
    const viewportMeta = document.querySelector('meta[name="viewport"]')?.content || '';
    const metaDescription = document.querySelector('meta[name="description"]')?.content || '';
    const canonical = document.querySelector('link[rel="canonical"]')?.href || '';
    const jsonld = els('script[type="application/ld+json"]').length;
    const forms = els('form').map(f => ({ action: f.action, method: f.method, controls: f.querySelectorAll('input,textarea,select,button').length })).slice(0, 50);
    const visibleText = (body?.innerText || '').replace(/\s+/g, ' ').trim();
    return { title: document.title, lang: document.documentElement.lang || '', charset: document.characterSet, viewportMeta, metaDescription, canonical, jsonld, scrollHeight, bodyText: visibleText.slice(0, 20000), headings, buttons, links, inputs, images, navs, modals, landmarks, forms, stylesheetCount: styles, htmlLength: document.documentElement.outerHTML.length, dimensions: { width: innerWidth, height: innerHeight, devicePixelRatio }, stats: { h1: headings.filter(x => x.tag === 'H1').length, images: images.length, missingAlt: images.filter(x => !x.alt).length, links: links.length, buttons: buttons.length, inputs: inputs.length, emptyLinks: links.filter(x => !x.text).length, unlabeledButtons: buttons.filter(x => !x.text && !x.aria).length, dialogs: modals.length } };
  });

  let aria = '';
  try { aria = await page.locator('body').ariaSnapshot({ timeout: 5000 }); } catch {}
  const screenshot = await page.screenshot({ type: 'jpeg', quality: 72, fullPage: true });
  const perf = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0];
    return n ? { domContentLoaded: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), response: Math.round(n.responseEnd - n.requestStart), transferSize: n.transferSize || 0, type: n.type } : null;
  }).catch(() => null);

  return { label, viewport, finalUrl: page.url(), status: response?.status() ?? null, contentType: response?.headers()['content-type'] || '', elapsedMs: Date.now() - started, dom: data, ariaSnapshot: String(aria || '').slice(0, 30000), screenshot: `data:image/jpeg;base64,${screenshot.toString('base64')}`, consoleErrors, failedRequests, performance: perf };
}

async function interact(page) {
  const actions = [];
  const candidates = await page.locator('button:visible, [role="button"]:visible, a[href]:visible').all();
  for (let i = 0; i < Math.min(candidates.length, 10); i++) {
    const el = candidates[i];
    const label = await el.innerText().catch(() => '') || await el.getAttribute('aria-label').catch(() => '');
    if (!label || /^(閉じる|close|menu|メニュー)$/i.test(label.trim())) continue;
    const before = await page.locator('body').innerText().catch(() => '');
    try {
      await el.click({ timeout: 1500, noWaitAfter: true });
      await sleep(350);
      const after = await page.locator('body').innerText().catch(() => '');
      if (before !== after) actions.push({ action: 'click', label: label.trim().slice(0, 100), changed: true });
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 4000 }).catch(() => {});
    } catch {}
  }
  return actions.slice(0, 10);
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const raw = Array.isArray(req.query?.url) ? req.query.url[0] : req.query?.url;
  if (!raw) return res.status(400).json({ error: 'url is required' });
  let url;
  try { url = await publicUrl(raw); } catch (e) { return res.status(400).json({ error: e.message || 'URLが不正です' }); }

  let browser;
  try {
    browser = await playwright.launch({ args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox'], executablePath: await chromium.executablePath(), headless: true });
    const results = {};
    for (const cfg of [{ key: 'desktop', width: 1440, height: 900, mobile: false }, { key: 'mobile', width: 390, height: 844, mobile: true }]) {
      const context = await browser.newContext({ viewport: { width: cfg.width, height: cfg.height }, isMobile: cfg.mobile, hasTouch: cfg.mobile, deviceScaleFactor: cfg.mobile ? 2 : 1, locale: 'ja-JP', colorScheme: 'light' });
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await sleep(1200);
      results[cfg.key] = await collectPage(page, { width: cfg.width, height: cfg.height, mobile: cfg.mobile }, cfg.key);
      if (cfg.key === 'desktop') results.interactions = await interact(page);
      await context.close();
    }
    return res.status(200).json({ ok: true, requestedUrl: url, desktop: results.desktop, mobile: results.mobile, interactions: results.interactions || [], generatedAt: new Date().toISOString(), engine: 'Chromium + Playwright' });
  } catch (e) {
    return res.status(502).json({ ok: false, error: e.message || '実ブラウザでページを調査できませんでした' });
  } finally { if (browser) await browser.close().catch(() => {}); }
};
