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

// Catch-all pass: every remaining business with a website, grouped by its main OSM key.
const CATCH_ALL = {
  shop:       'Weitere Geschäfte',
  office:     'Weitere Dienstleister & Büros',
  craft:      'Handwerk',
  healthcare: 'Weitere Gesundheitsanbieter',
  amenity:    'Weitere Dienstleister & Büros',
  tourism:    'Freizeit, Kultur & Tourismus',
  leisure:    'Freizeit, Kultur & Tourismus',
};
const NOT_A_BUSINESS = new Set([
  'school','kindergarten','childcare','university','college','place_of_worship','townhall','police','fire_station',
  'courthouse','prison','library','community_centre','social_facility','social_centre','post_office','bank','atm',
  'parking','fuel','toilets','hospital','grave_yard','public_bookcase','shelter','recycling','bus_station','embassy',
  'park','playground','pitch','nature_reserve','garden','track','stadium','common','dog_park','marina','slipway',
  'information','artwork','viewpoint','attraction','picnic_site','camp_site','yes','vacant','government','religion',
  'association','ngo','political_party','educational_institution','research','charity','diplomatic','union',
]);

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

let doneGroups = new Set();

function addElements(byId, els, classify) {
  let added = 0;
  for (const el of els) {
    if (el.tags?.['brand:wikidata']) continue;
    const industry = classify(el);
    if (!industry) continue;
    const lead = toLead(el, industry);
    const prev = byId.get(lead.osmId);
    if (prev) { Object.assign(prev, { ...lead, industry: prev.industry, email: prev.email || lead.email }); continue; }
    byId.set(lead.osmId, lead); added++;
  }
  return added;
}

// Several industries per Overpass query: the public servers queue every request, so fewer requests = much faster.
async function runBatches(byId, onBatchDone) {
  const pending = Object.entries(INDUSTRIES).filter(([name]) => !doneGroups.has(name));
  for (let i = 0; i < pending.length; i += 5) {
    const batch = pending.slice(i, i + 5);
    console.log(`▶ ${batch.map(([n]) => n).join(', ')}`);
    const lines = batch.flatMap(([, tags]) => tags.map(([k, v]) => `nwr["${k}"="${v}"]["name"];`)).join('');
    const els = await overpass(`[out:json][timeout:170][bbox:${REGION.bbox}];(${lines});out center tags;`);
    const added = addElements(byId, els, el => {
      const hit = batch.find(([, tags]) => tags.some(([k, v]) => el.tags?.[k] === v));
      return hit && (hit[0] === 'Handwerk+' ? 'Handwerk' : hit[0]);
    });
    batch.forEach(([n]) => doneGroups.add(n));
    console.log(`   ${els.length} gefunden, ${added} neu`);
    await onBatchDone();
    await sleep(5000);
  }
  for (const [key, industry] of Object.entries(CATCH_ALL)) {
    const group = `catch:${key}`;
    if (doneGroups.has(group)) continue;
    console.log(`▶ Sammel-Durchlauf ${key} → ${industry}`);
    const els = await overpass(`[out:json][timeout:170][bbox:${REGION.bbox}];(nwr["${key}"]["name"]["website"];nwr["${key}"]["name"]["contact:website"];);out center tags;`);
    const added = addElements(byId, els, el => {
      const t = el.tags || {};
      if (NOT_A_BUSINESS.has(t[key]) || byId.has(`${el.type}/${el.id}`)) return null;
      return industry;
    });
    doneGroups.add(group);
    console.log(`   ${els.length} gefunden, ${added} neu`);
    await onBatchDone();
    await sleep(5000);
  }
}

const { findEmail } = require('../lib/site-tools');

// Website addresses beat OpenStreetMap ones (OSM is often outdated → bounces). Dead sites are flagged.
async function enrich(leads) {
  const todo = leads.filter(l => l.website && !l.emailChecked && l.emailSource !== 'website');
  console.log(`▶ E-Mail-Suche für ${todo.length} Websites`);
  let done = 0, hits = 0, dead = 0, i = 0;
  async function worker() {
    while (i < todo.length) {
      const lead = todo[i++];
      try {
        const found = await findEmail(lead.website);
        if (found) {
          if (lead.email && lead.email !== found) lead.osmEmail = lead.email;
          lead.email = found; lead.emailSource = 'website'; hits++;
        }
      } catch {
        lead.websiteDead = true; dead++;
      }
      lead.emailChecked = true;
      if (++done % 25 === 0) { console.log(`   ${done}/${todo.length} geprüft, ${hits} E-Mails, ${dead} tote Websites`); save(leads); }
    }
  }
  await Promise.all(Array.from({ length: 16 }, worker));
  console.log(`   fertig: ${hits} E-Mails gefunden, ${dead} tote Websites`);
}

function save(leads) {
  fs.writeFileSync(OUT, JSON.stringify({ region: REGION.name, updatedAt: new Date().toISOString(), doneGroups: [...doneGroups], leads }, null, 1));
}

function upload() {
  const env = Object.fromEntries(fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
  const netrc = path.join(require('os').tmpdir(), 'ailima-pool-netrc');
  fs.writeFileSync(netrc, `machine ${env.FTP_HOST}\nlogin ${env.FTP_USER}\npassword ${env.FTP_PASS}\n`, { mode: 0o600 });
  try {
    execFileSync('curl', ['--netrc-file', netrc, '-sS', '-T', OUT, `ftp://${env.FTP_HOST}/ailima-data/lead-pool.json.tmp`,
      '-Q', '-RNFR lead-pool.json.tmp', '-Q', '-RNTO lead-pool.json']);
  } finally { fs.unlinkSync(netrc); }
  console.log('▶ Pool hochgeladen');
}

function report(leads) {
  console.log(`✓ Pool: ${leads.length} Firmen, ${leads.filter(l => l.email).length} mit E-Mail`);
  for (const ind of [...new Set(leads.map(l => l.industry))]) {
    const all = leads.filter(l => l.industry === ind);
    console.log(`   ${ind}: ${all.length} (${all.filter(l => l.email).length} mit E-Mail)`);
  }
}

(async () => {
  const file = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { leads: [] };
  doneGroups = new Set(file.doneGroups || file.leads.map(l => l.industry));
  if (argVal('--done')) argVal('--done').split(',').forEach(g => doneGroups.add(g.trim()));
  const byId = new Map(file.leads.map(l => [l.osmId, l]));
  const all = () => [...byId.values()];
  const doUpload = args.includes('--upload');
  const afterBatch = async () => {
    save(all());
    await enrich(all());
    save(all());
    if (doUpload) upload();
  };
  if (!args.includes('--skip-osm')) await runBatches(byId, afterBatch);
  else await afterBatch();
  report(all());
})().catch(e => { console.error('✗', e.message); process.exit(1); });
