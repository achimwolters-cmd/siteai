// Shared helpers for reading business websites: email extraction, text snapshot, mail-domain check.
const dns = require('dns').promises;

const UA = 'Mozilla/5.0 (compatible; AilimaCRM/1.0; +https://ailima.de)';
const BAD_EMAIL = /(example\.|sentry|wixpress|@domain\.|@email\.|\.png|\.jpg|\.webp|\.gif|@sentry|noreply|no-reply|datenschutz@|privacy@|webmaster@)/i;

function deobfuscate(html) {
  return html
    .replace(/&#64;|&#x40;|%40/gi, '@')
    .replace(/&#46;|&#x2e;/gi, '.')
    .replace(/\s*[\[\(\{]\s*(at|ät)\s*[\]\)\}]\s*/gi, '@')
    .replace(/\s*[\[\(\{]\s*(dot|punkt)\s*[\]\)\}]\s*/gi, '.');
}

function extractEmails(html) {
  const text = deobfuscate(html);
  const found = new Set();
  for (const m of text.matchAll(/mailto:([^"'?>\s]+)/gi)) found.add(decodeURIComponent(m[1]).toLowerCase());
  for (const m of text.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)) found.add(m[0].toLowerCase());
  return [...found].filter(e => !BAD_EMAIL.test(e) && e.length < 80);
}

async function getHtml(url, timeoutMs = 12000) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const type = r.headers.get('content-type') || '';
  if (!type.includes('html')) throw new Error('kein HTML');
  return { html: (await r.text()).slice(0, 600000), url: r.url };
}

function pickEmail(emails, website, exclude = []) {
  const skip = new Set(exclude.map(e => (e || '').toLowerCase()));
  emails = emails.filter(e => !skip.has(e));
  if (!emails.length) return '';
  let host = '';
  try { host = new URL(website).hostname.replace(/^www\./, ''); } catch {}
  const sameDomain = emails.filter(e => host && e.endsWith('@' + host));
  const pool = sameDomain.length ? sameDomain : emails;
  return pool.find(e => /^(info|kontakt|hallo|hello|mail|office|praxis|termin)@/.test(e)) || pool[0];
}

// Returns the best contact address from homepage / Impressum / Kontakt, or '' if none.
// Throws if the homepage itself is unreachable (used to detect dead websites).
async function findEmail(website, exclude = []) {
  const home = await getHtml(website);
  let found = pickEmail(extractEmails(home.html), website, exclude);
  if (found) return found;
  const links = [...home.html.matchAll(/href=["']([^"'#]+)["'][^>]*>([^<]{0,60})/gi)]
    .filter(m => /impressum|kontakt|imprint|contact/i.test(m[1] + ' ' + m[2]))
    .map(m => { try { return new URL(m[1], home.url).href; } catch { return null; } })
    .filter(Boolean);
  const candidates = [...new Set([...links, new URL('/impressum', home.url).href, new URL('/kontakt', home.url).href])].slice(0, 4);
  for (const url of candidates) {
    try {
      found = pickEmail(extractEmails((await getHtml(url)).html), website, exclude);
      if (found) return found;
    } catch {}
  }
  return '';
}

function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

// Short text snapshot of the homepage for personalising a mail. Returns null if unreachable.
async function siteSnapshot(website) {
  try {
    const { html, url } = await getHtml(website, 10000);
    const title = (html.match(/<title[^>]*>([^<]{0,120})/i)?.[1] || '').trim();
    const text = htmlToText(html);
    const years = [...text.matchAll(/(?:©|copyright|\(c\))\s*(?:\d{4}\s*[-–]\s*)?(\d{4})/gi)].map(m => parseInt(m[1]));
    return { url, title, text: text.slice(0, 2500), copyrightYear: years.length ? Math.max(...years) : null };
  } catch {
    return null;
  }
}

const mxCache = new Map();
// True if the address's domain can receive mail (MX record, or A record as fallback per RFC 5321).
async function domainAcceptsMail(email) {
  const domain = (email || '').split('@')[1]?.toLowerCase();
  if (!domain) return false;
  if (mxCache.has(domain)) return mxCache.get(domain);
  let ok;
  try {
    ok = (await dns.resolveMx(domain)).some(r => r.exchange && r.exchange !== '.');
  } catch (e) {
    if (e.code === 'ENOTFOUND' || e.code === 'ENODATA') {
      try { ok = (await dns.resolve4(domain)).length > 0; } catch { ok = false; }
    } else {
      return true; // DNS hiccup: don't block sending on a transient error
    }
  }
  mxCache.set(domain, ok);
  return ok;
}

module.exports = { findEmail, siteSnapshot, domainAcceptsMail, extractEmails };
