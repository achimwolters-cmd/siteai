// Builds the lead pool: collects businesses from OpenStreetMap, enriches emails from Impressum pages.
// Usage: node scripts/build-lead-pool.js [--only "Friseur / Kosmetik"] [--skip-osm] [--upload]
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const UA = 'AilimaCRM/1.0 (achim@ailima.de)';
const OUT = process.env.POOL_FILE || path.join(__dirname, '..', 'lead-pool.json');

const REGION = { name: 'München & Umland', bbox: '47.95,11.25,48.30,11.85' };

const INDUSTRIES = {
  'Friseur / Kosmetik': [['shop','hairdresser'],['shop','beauty'],['shop','cosmetics']],
  'Physiotherapie':     [['amenity','physiotherapist'],['healthcare','physiotherapist'],['shop','massage']],
  'Restaurant / Café':  [['amenity','restaurant'],['amenity','cafe']],
  'Handwerk':           [['craft','plumber'],['craft','electrician'],['craft','carpenter'],['craft','painter'],['craft','hvac'],['craft','tiler'],['craft','roofer'],['craft','gardener']],
  'Fitness / Yoga':     [['leisure','fitness_centre'],['sport','yoga'],['leisure','sports_centre']],
  'Arztpraxis':         [['amenity','doctors'],['amenity','dentist'],['healthcare','doctor'],['healthcare','dentist']],
  'Handwerk+':          [['craft','plasterer'],['craft','glaziery'],['craft','metal_construction'],['craft','stonemason'],['craft','locksmith'],['shop','locksmith'],['craft','floorer'],['craft','window_construction'],['craft','joiner'],['craft','upholsterer'],['craft','chimney_sweeper'],['craft','builder'],['craft','sanitary'],['craft','heating_engineer'],['craft','plumber;heating_engineer']],
  'Kanzlei / Steuerberater':   [['office','lawyer'],['office','tax_advisor'],['office','accountant'],['office','notary']],
  'Immobilien':                [['office','estate_agent']],
  'Versicherung / Finanzen':   [['office','insurance'],['office','financial_advisor'],['office','financial']],
  'Architektur / Ingenieure':  [['office','architect'],['office','engineer'],['office','surveyor']],
  'Agentur / IT / Beratung':   [['office','advertising_agency'],['office','it'],['office','consulting'],['office','graphic_design']],
  'Hotel / Pension':           [['tourism','hotel'],['tourism','guest_house'],['tourism','hostel'],['tourism','apartment']],
  'Bar / Kneipe':              [['amenity','bar'],['amenity','pub'],['amenity','biergarten']],
  'Imbiss / Eisdiele':         [['amenity','fast_food'],['amenity','ice_cream']],
  'Bäckerei / Konditorei':     [['shop','bakery'],['shop','pastry'],['shop','confectionery']],
  'Metzgerei / Feinkost / Wein': [['shop','butcher'],['shop','deli'],['shop','wine'],['shop','cheese'],['shop','greengrocer'],['shop','coffee'],['shop','tea']],
  'Blumen / Garten':           [['shop','florist'],['shop','garden_centre']],
  'Mode / Schuhe':             [['shop','clothes'],['shop','shoes'],['shop','boutique'],['shop','fashion_accessories'],['shop','bag']],
  'Schmuck / Uhren':           [['shop','jewelry'],['shop','watches']],
  'Optiker / Hörakustik':      [['shop','optician'],['shop','hearing_aids']],
  'Einrichtung / Möbel':       [['shop','furniture'],['shop','interior_decoration'],['shop','kitchen'],['shop','bed'],['shop','lighting'],['shop','curtain']],
  'Geschenke / Bücher / Spiel': [['shop','gift'],['shop','books'],['shop','toys'],['shop','stationery'],['shop','art'],['shop','craft']],
  'Fahrrad / Sport':           [['shop','bicycle'],['shop','sports'],['shop','outdoor']],
  'Autowerkstatt / Autohaus':  [['shop','car_repair'],['shop','car'],['shop','tyres'],['shop','motorcycle']],
  'Tierarzt / Tierbedarf':     [['amenity','veterinary'],['shop','pet'],['shop','pet_grooming']],
  'Heilpraktiker / Therapie':  [['healthcare','alternative'],['healthcare','psychotherapist'],['healthcare','occupational_therapist'],['healthcare','speech_therapist'],['healthcare','midwife']],
  'Apotheke / Sanitätshaus':   [['amenity','pharmacy'],['shop','medical_supply']],
  'Fotografie / Druck':        [['shop','photo'],['craft','photographer'],['shop','copyshop'],['craft','printer']],
  'Schulen / Kurse':           [['amenity','driving_school'],['amenity','music_school'],['amenity','dancing_school'],['amenity','language_school'],['amenity','prep_school']],
  'Reinigung / Schneiderei':   [['shop','dry_cleaning'],['shop','laundry'],['shop','tailor'],['craft','tailor'],['shop','shoe_repair']],
  'Tattoo / Piercing':         [['shop','tattoo']],
  'Reisebüro':                 [['shop','travel_agency']],
  'Event / Catering':          [['amenity','events_venue'],['craft','caterer'],['shop','party']],
  'Coworking':                 [['amenity','coworking_space'],['office','coworking']],
};

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const args = process.argv.slice(2);
const argVal = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };

async function overpass(query) {
  for (let attempt = 1; attempt <= 8; attempt++) {
    for (const url of MIRRORS) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
          body: 'data=' + encodeURIComponent(query),
          signal: AbortSignal.timeout(180000),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const d = await r.json();
        if (d.remark && !d.elements?.length) throw new Error('remark: ' + d.remark.slice(0, 80));
        return d.elements;
      } catch (e) {
        console.log(`   ${new URL(url).host}: ${e.message}`);
      }
    }
    const wait = attempt * 20000;
    console.log(`   Versuch ${attempt} fehlgeschlagen, warte ${wait / 1000}s…`);
    await sleep(wait);
  }
  throw new Error('Overpass dauerhaft nicht erreichbar');
}

function toLead(el, industry) {
  const t = el.tags || {};
  let website = t.website || t['contact:website'] || t.url || '';
  if (website && !/^https?:\/\//i.test(website)) website = 'https://' + website;
  return {
    osmId: `${el.type}/${el.id}`,
    company: t.name,
    industry,
    phone: t.phone || t['contact:phone'] || t['phone:mobile'] || '',
    website,
    email: (t.email || t['contact:email'] || '').split(';')[0].trim().toLowerCase(),
    street: [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' '),
    postcode: t['addr:postcode'] || '',
    city: t['addr:city'] || '',
  };
}

async function collect(existing) {
  const byId = new Map(existing.map(l => [l.osmId, l]));
  const only = argVal('--only');
  const known = new Set(existing.map(l => l.industry));
  for (const [industry, tags] of Object.entries(INDUSTRIES)) {
    if (only && only !== industry) continue;
    if (!only && known.has(industry)) { console.log(`▷ ${industry}: schon im Pool, übersprungen`); continue; }
    console.log(`▶ ${industry}`);
    const lines = tags.map(([k, v]) => `nwr["${k}"="${v}"]["name"];`).join('');
    const els = await overpass(`[out:json][timeout:170][bbox:${REGION.bbox}];(${lines});out center tags;`);
    let added = 0;
    for (const el of els) {
      if (el.tags?.['brand:wikidata']) continue;
      const lead = toLead(el, industry === 'Handwerk+' ? 'Handwerk' : industry);
      const prev = byId.get(lead.osmId);
      if (prev) { Object.assign(prev, { ...lead, industry: prev.industry, email: prev.email || lead.email }); continue; }
      byId.set(lead.osmId, lead); added++;
    }
    console.log(`   ${els.length} gefunden, ${added} neu`);
    save([...byId.values()]);
    await sleep(5000);
  }
  return [...byId.values()];
}

// ── Impressum email extraction ──
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

async function getHtml(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AilimaCRM/1.0; +https://ailima.de)' },
    redirect: 'follow',
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const type = r.headers.get('content-type') || '';
  if (!type.includes('html')) throw new Error('kein HTML');
  return { html: (await r.text()).slice(0, 600000), url: r.url };
}

function pickEmail(emails, website) {
  if (!emails.length) return '';
  let host = '';
  try { host = new URL(website).hostname.replace(/^www\./, ''); } catch {}
  const sameDomain = emails.filter(e => host && e.endsWith('@' + host));
  const pool = sameDomain.length ? sameDomain : emails;
  const pref = pool.find(e => /^(info|kontakt|hallo|hello|mail|office|praxis|termin)@/.test(e));
  return pref || pool[0];
}

async function findEmail(website) {
  const home = await getHtml(website);
  let emails = extractEmails(home.html);
  if (emails.length) return pickEmail(emails, website);
  const links = [...home.html.matchAll(/href=["']([^"'#]+)["'][^>]*>([^<]{0,60})/gi)]
    .filter(m => /impressum|kontakt|imprint|contact/i.test(m[1] + ' ' + m[2]))
    .map(m => { try { return new URL(m[1], home.url).href; } catch { return null; } })
    .filter(Boolean);
  const candidates = [...new Set([...links, new URL('/impressum', home.url).href, new URL('/kontakt', home.url).href])].slice(0, 4);
  for (const url of candidates) {
    try {
      emails = extractEmails((await getHtml(url)).html);
      if (emails.length) return pickEmail(emails, website);
    } catch {}
  }
  return '';
}

async function enrich(leads) {
  const todo = leads.filter(l => l.website && !l.email && !l.emailChecked);
  console.log(`▶ E-Mail-Suche für ${todo.length} Websites`);
  let done = 0, hits = 0, i = 0;
  async function worker() {
    while (i < todo.length) {
      const lead = todo[i++];
      try { lead.email = await findEmail(lead.website); } catch {}
      lead.emailChecked = true;
      if (lead.email) { lead.emailSource = 'website'; hits++; }
      if (++done % 25 === 0) { console.log(`   ${done}/${todo.length} geprüft, ${hits} E-Mails`); save(leads); }
    }
  }
  await Promise.all(Array.from({ length: 16 }, worker));
  console.log(`   fertig: ${hits} E-Mails gefunden`);
}

function save(leads) {
  fs.writeFileSync(OUT, JSON.stringify({ region: REGION.name, updatedAt: new Date().toISOString(), leads }, null, 1));
}

function upload() {
  const env = Object.fromEntries(fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
  const netrc = path.join(require('os').tmpdir(), 'ailima-pool-netrc');
  fs.writeFileSync(netrc, `machine ${env.FTP_HOST}\nlogin ${env.FTP_USER}\npassword ${env.FTP_PASS}\n`, { mode: 0o600 });
  try {
    execFileSync('curl', ['--netrc-file', netrc, '-sS', '-T', OUT, `ftp://${env.FTP_HOST}/ailima-data/lead-pool.json`]);
  } finally { fs.unlinkSync(netrc); }
  console.log('▶ Pool hochgeladen');
}

(async () => {
  const existing = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')).leads : [];
  const leads = args.includes('--skip-osm') ? existing : await collect(existing);
  if (args.includes('--upload')) upload();
  await enrich(leads);
  save(leads);
  const withMail = leads.filter(l => l.email).length;
  console.log(`✓ Pool: ${leads.length} Firmen, ${withMail} mit E-Mail`);
  for (const ind of [...new Set(leads.map(l => l.industry))]) {
    const all = leads.filter(l => l.industry === ind);
    console.log(`   ${ind}: ${all.length} (${all.filter(l => l.email).length} mit E-Mail)`);
  }
  if (args.includes('--upload')) upload();
})().catch(e => { console.error('✗', e.message); process.exit(1); });
