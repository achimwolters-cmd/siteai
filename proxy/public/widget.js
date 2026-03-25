(() => {
  // ══ KI WIDGET CONFIG ══════════════════════
  const scriptTag = document.currentScript || document.querySelector('script[data-token]');
  const KI_TOKEN  = scriptTag.getAttribute('data-token');
  const KI_PROXY  = scriptTag.getAttribute('data-proxy') || window.location.origin;
  // ══════════════════════════════════════════

  // ── CSS injizieren ────────────────────────────────────────────────────────
  const css = `
  /* ── Floating Button ── */
  #ki-fab {
    position: fixed;
    bottom: 28px; right: 28px;
    z-index: 9999;
    width: 56px; height: 56px;
    background: linear-gradient(135deg, #b8935a, #9a7840);
    border: none;
    border-radius: 50%;
    cursor: pointer;
    box-shadow: 0 4px 20px rgba(184,147,90,0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 22px;
    transition: transform 0.2s, box-shadow 0.2s;
    color: white;
  }
  #ki-fab:hover { transform: scale(1.1); box-shadow: 0 6px 28px rgba(184,147,90,0.7); }
  #ki-fab.open { border-radius: 12px; width: 48px; height: 48px; font-size: 18px; }

  /* ── Panel ── */
  #ki-panel {
    position: fixed;
    bottom: 96px; right: 28px;
    z-index: 9998;
    width: 360px;
    max-height: 72vh;
    background: #ffffff;
    border-radius: 20px;
    box-shadow: 0 16px 60px rgba(0,0,0,0.18);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    transform: scale(0.9) translateY(16px);
    opacity: 0;
    pointer-events: none;
    transition: transform 0.25s cubic-bezier(0.34,1.56,0.64,1), opacity 0.2s;
    transform-origin: bottom right;
  }
  #ki-panel.open {
    transform: scale(1) translateY(0);
    opacity: 1;
    pointer-events: all;
  }

  /* Panel Header */
  .ki-header {
    background: linear-gradient(135deg, #1a1a1a, #2d2416);
    padding: 16px 18px;
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }
  .ki-header-icon {
    width: 34px; height: 34px;
    background: rgba(184,147,90,0.25);
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 16px;
  }
  .ki-header-title { font-size: 14px; font-weight: 700; color: #fff; font-family: 'Inter', sans-serif; }
  .ki-header-sub { font-size: 11px; color: rgba(255,255,255,0.5); font-family: 'Inter', sans-serif; }
  .ki-credits {
    margin-left: auto;
    background: rgba(184,147,90,0.2);
    color: #d4aa78;
    font-size: 11px;
    font-weight: 600;
    padding: 4px 10px;
    border-radius: 20px;
    font-family: 'Inter', sans-serif;
    white-space: nowrap;
  }

  /* Messages */
  .ki-messages {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: #f8f7f5;
  }
  .ki-messages::-webkit-scrollbar { width: 4px; }
  .ki-messages::-webkit-scrollbar-track { background: transparent; }
  .ki-messages::-webkit-scrollbar-thumb { background: #ddd; border-radius: 4px; }

  .ki-msg {
    max-width: 85%;
    padding: 10px 14px;
    border-radius: 14px;
    font-size: 13px;
    line-height: 1.55;
    font-family: 'Inter', sans-serif;
  }
  .ki-msg.bot {
    background: #ffffff;
    color: #1a1a1a;
    align-self: flex-start;
    border: 1px solid #e8e3db;
    border-bottom-left-radius: 4px;
  }
  .ki-msg.user {
    background: linear-gradient(135deg, #b8935a, #9a7840);
    color: #fff;
    align-self: flex-end;
    border-bottom-right-radius: 4px;
  }
  .ki-msg.error { background: #fff0f0; color: #c00; border: 1px solid #fcc; align-self: flex-start; }

  /* Typing Indicator */
  .ki-typing {
    display: none;
    align-self: flex-start;
    background: #fff;
    border: 1px solid #e8e3db;
    border-radius: 14px;
    border-bottom-left-radius: 4px;
    padding: 12px 16px;
    gap: 5px;
    align-items: center;
  }
  .ki-typing.visible { display: flex; }
  .ki-dot {
    width: 7px; height: 7px;
    background: #b8935a;
    border-radius: 50%;
    animation: ki-bounce 1.2s infinite;
  }
  .ki-dot:nth-child(2) { animation-delay: 0.2s; }
  .ki-dot:nth-child(3) { animation-delay: 0.4s; }
  @keyframes ki-bounce { 0%,60%,100%{transform:translateY(0)} 30%{transform:translateY(-6px)} }

  /* Chips */
  .ki-chips {
    padding: 10px 16px 0;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    flex-shrink: 0;
    background: #f8f7f5;
  }
  .ki-chip {
    background: #fff;
    border: 1px solid #e8e3db;
    border-radius: 20px;
    padding: 5px 12px;
    font-size: 12px;
    color: #555;
    cursor: pointer;
    font-family: 'Inter', sans-serif;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
    white-space: nowrap;
  }
  .ki-chip:hover { background: #b8935a; border-color: #b8935a; color: #fff; }

  /* Input */
  .ki-input-row {
    padding: 12px 14px;
    display: flex;
    gap: 8px;
    align-items: flex-end;
    border-top: 1px solid #e8e3db;
    background: #fff;
    flex-shrink: 0;
  }
  .ki-textarea {
    flex: 1;
    background: #f5f3ef;
    border: 1.5px solid #e8e3db;
    border-radius: 10px;
    padding: 9px 12px;
    font-size: 13px;
    font-family: 'Inter', sans-serif;
    resize: none;
    min-height: 38px;
    max-height: 100px;
    color: #1a1a1a;
    line-height: 1.45;
    transition: border-color 0.2s;
  }
  .ki-textarea:focus { outline: none; border-color: #b8935a; }
  .ki-send {
    width: 38px; height: 38px;
    background: #b8935a;
    border: none;
    border-radius: 10px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: background 0.15s, transform 0.15s;
    color: white;
    font-size: 16px;
  }
  .ki-send:hover:not(:disabled) { background: #9a7840; transform: scale(1.05); }
  .ki-send:disabled { background: #ccc; cursor: not-allowed; }

  /* Speichern-Bar */
  .ki-save-bar {
    padding: 10px 14px;
    background: #f0faf4;
    border-top: 1px solid #c6e8d3;
    flex-shrink: 0;
  }
  .ki-save-btn {
    width: 100%;
    background: #2a7d4f;
    color: #fff;
    border: none;
    border-radius: 10px;
    padding: 10px 16px;
    font-size: 13px;
    font-weight: 600;
    font-family: 'Inter', sans-serif;
    cursor: pointer;
    transition: background 0.15s, transform 0.1s;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
  }
  .ki-save-btn:hover:not(:disabled) { background: #1e5c3a; transform: scale(1.01); }
  .ki-save-btn:disabled { background: #8bbfa3; cursor: not-allowed; }
  .ki-save-btn.saving { background: #8bbfa3; }
  .ki-save-btn.saved  { background: #1a6638; }

  @media (max-width: 480px) {
    #ki-panel { width: calc(100vw - 32px); right: 16px; bottom: 88px; }
    #ki-fab { right: 16px; bottom: 16px; }
  }

  /* ── Flächen-Farb-Editor ── */
  .ki-colorable { position: relative; }
  .ki-color-btn {
    position: absolute;
    top: 10px; right: 10px;
    z-index: 500;
    background: rgba(255,255,255,0.92);
    border: none;
    border-radius: 50%;
    width: 36px; height: 36px;
    font-size: 16px;
    cursor: pointer;
    box-shadow: 0 2px 10px rgba(0,0,0,0.18);
    opacity: 0;
    transition: opacity 0.2s, transform 0.15s;
    display: flex; align-items: center; justify-content: center;
  }
  .ki-colorable:hover .ki-color-btn { opacity: 1; }
  .ki-color-btn:hover { transform: scale(1.15); }

  #ki-color-popup {
    position: fixed;
    z-index: 99999;
    background: #fff;
    border: 2px solid #b8935a;
    border-radius: 14px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.2);
    padding: 16px;
    width: 240px;
    font-family: inherit;
  }
  #ki-color-popup .ki-cp-label {
    font-size: 11px; font-weight: 700; color: #b8935a;
    text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 10px;
  }
  #ki-color-popup input[type=color] {
    width: 100%; height: 48px; border: none; border-radius: 8px;
    cursor: pointer; padding: 2px; background: none;
  }
  #ki-color-popup .ki-cp-swatches {
    display: grid; grid-template-columns: repeat(7,1fr); gap: 6px; margin: 10px 0;
  }
  #ki-color-popup .ki-cp-swatch {
    width: 28px; height: 28px; border-radius: 50%; cursor: pointer;
    border: 2px solid transparent; transition: transform 0.15s;
  }
  #ki-color-popup .ki-cp-swatch:hover { transform: scale(1.2); border-color: #333; }
  #ki-color-popup .ki-cp-actions { display: flex; gap: 8px; margin-top: 10px; }
  #ki-color-popup .ki-cp-cancel {
    flex:1; padding:8px; border:1px solid #ddd; border-radius:8px;
    background:#f5f5f5; cursor:pointer; font-size:13px;
  }
  #ki-color-popup .ki-cp-confirm {
    flex:2; padding:8px; border:none; border-radius:8px;
    background:#b8935a; color:#fff; cursor:pointer; font-size:13px; font-weight:600;
  }

  /* ── Inline-Editing ── */
  .ki-editable {
    cursor: pointer !important;
    border-radius: 3px;
    transition: outline 0.15s ease;
  }
  .ki-editable:hover {
    outline: 2px dashed #b8935a;
    outline-offset: 4px;
  }
  .ki-editable:hover::after {
    content: ' ✏️';
    font-size: 0.75em;
    opacity: 0.7;
  }

  /* ── Button-Editing ── */
  .ki-btn-editable { position: relative !important; }
  .ki-btn-badge {
    position: absolute;
    top: -9px; right: -9px;
    background: #fff;
    border: 2px solid #b8935a;
    border-radius: 50%;
    width: 22px; height: 22px;
    font-size: 11px;
    display: flex; align-items: center; justify-content: center;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.2s;
    z-index: 20;
  }
  .ki-btn-editable:hover .ki-btn-badge { opacity: 1; }

  /* ── Button + Text-Farb-Popup (gemeinsam genutzt) ── */
  #ki-btn-popup {
    position: fixed;
    z-index: 99999;
    background: #fff;
    border: 2px solid #b8935a;
    border-radius: 14px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.2);
    padding: 14px;
    width: 270px;
    font-family: inherit;
  }
  #ki-btn-popup .ki-bp-label {
    font-size: 11px; font-weight: 700; color: #b8935a;
    text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 10px;
  }
  #ki-btn-popup input[type=text] {
    width: 100%; border: 1px solid #ddd; border-radius: 8px;
    padding: 8px; font-size: 14px; font-family: inherit;
    box-sizing: border-box; margin-bottom: 10px;
  }
  #ki-btn-popup input[type=text]:focus { outline: none; border-color: #b8935a; }
  #ki-btn-popup .ki-bp-colors {
    display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 10px;
  }
  #ki-btn-popup .ki-bp-color-row label {
    font-size: 11px; color: #888; display: block; margin-bottom: 3px;
  }
  #ki-btn-popup .ki-bp-color-row input[type=color] {
    width: 100%; height: 36px; border: 1px solid #ddd; border-radius: 8px;
    cursor: pointer; padding: 2px; background: none;
  }
  #ki-btn-popup .ki-bp-actions { display: flex; gap: 8px; }
  #ki-btn-popup .ki-bp-cancel {
    flex:1; padding:8px; border:1px solid #ddd; border-radius:8px;
    background:#f5f5f5; cursor:pointer; font-size:13px;
  }
  #ki-btn-popup .ki-bp-confirm {
    flex:2; padding:8px; border:none; border-radius:8px;
    background:#b8935a; color:#fff; cursor:pointer; font-size:13px; font-weight:600;
  }

  /* ── Farb-Zeile im Text-Inline-Editor ── */
  .ki-il-colors {
    display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 8px 0;
  }
  .ki-il-color-row label {
    font-size: 11px; color: #888; display: block; margin-bottom: 3px;
  }
  .ki-il-color-row input[type=color] {
    width: 100%; height: 32px; border: 1px solid #ddd; border-radius: 6px;
    cursor: pointer; padding: 2px; background: none;
  }
  #ki-inline-popup {
    position: fixed;
    z-index: 99999;
    background: #fff;
    border: 2px solid #b8935a;
    border-radius: 14px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.18);
    padding: 14px;
    width: 300px;
    font-family: inherit;
  }
  #ki-inline-popup .ki-il-label {
    font-size: 11px;
    font-weight: 700;
    color: #b8935a;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 8px;
  }
  #ki-inline-popup textarea {
    width: 100%;
    border: 1px solid #ddd;
    border-radius: 8px;
    padding: 8px;
    font-size: 14px;
    font-family: inherit;
    resize: vertical;
    min-height: 58px;
    box-sizing: border-box;
    outline: none;
    transition: border-color 0.15s;
  }
  #ki-inline-popup textarea:focus { border-color: #b8935a; }
  #ki-inline-popup .ki-il-hint {
    font-size: 11px;
    color: #aaa;
    margin: 5px 0 8px;
  }
  #ki-inline-popup .ki-il-actions {
    display: flex;
    gap: 8px;
  }
  #ki-inline-popup .ki-il-cancel {
    flex: 1;
    padding: 8px;
    border: 1px solid #ddd;
    border-radius: 8px;
    background: #f5f5f5;
    cursor: pointer;
    font-size: 13px;
  }
  #ki-inline-popup .ki-il-confirm {
    flex: 2;
    padding: 8px;
    border: none;
    border-radius: 8px;
    background: #b8935a;
    color: #fff;
    cursor: pointer;
    font-size: 13px;
    font-weight: 600;
  }
  #ki-inline-popup .ki-il-confirm:hover { background: #a07840; }
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ── HTML injizieren ───────────────────────────────────────────────────────
  const widgetHTML = `
<!-- FAB Button -->
<button id="ki-fab" onclick="toggleKI()" title="KI-Editor öffnen">✨</button>

<!-- Panel -->
<div id="ki-panel">
  <div class="ki-header">
    <div class="ki-header-icon">✨</div>
    <div>
      <div class="ki-header-title">KI-Editor</div>
      <div class="ki-header-sub">Änderungen per Text</div>
    </div>
    <div class="ki-credits" id="ki-credits-badge">… Credits</div>
  </div>

  <div class="ki-messages" id="ki-messages">
    <div class="ki-msg bot">👋 Hallo! Ich bin Ihr KI-Assistent. Beschreiben Sie einfach, was Sie ändern möchten – z.B. <em>„Mach die Überschrift im Hero blau"</em> oder <em>„Füge eine neue Leistung hinzu"</em>.</div>
    <div class="ki-typing" id="ki-typing">
      <div class="ki-dot"></div><div class="ki-dot"></div><div class="ki-dot"></div>
    </div>
  </div>

  <div class="ki-chips" id="ki-chips">
    <div class="ki-chip" onclick="kiChip(this)">Farbe der Überschrift ändern</div>
    <div class="ki-chip" onclick="kiChip(this)">Neuen Abschnitt hinzufügen</div>
    <div class="ki-chip" onclick="kiChip(this)">Telefonnummer ändern</div>
    <div class="ki-chip" onclick="kiChip(this)">Preise aktualisieren</div>
    <div class="ki-chip" onclick="kiChip(this)">Öffnungszeiten ändern</div>
  </div>

  <div class="ki-save-bar">
    <button class="ki-save-btn" id="ki-save-btn" onclick="kiSave()">
      💾 Änderungen veröffentlichen
    </button>
  </div>

  <div class="ki-input-row">
    <textarea class="ki-textarea" id="ki-input" placeholder="Was soll geändert werden?" rows="1"
      onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();kiSend();}"
      oninput="this.style.height='auto';this.style.height=this.scrollHeight+'px'"></textarea>
    <button class="ki-send" id="ki-send-btn" onclick="kiSend()">➤</button>
  </div>
</div>
`;

  document.body.insertAdjacentHTML('beforeend', widgetHTML);

  // ── Widget-Logik ──────────────────────────────────────────────────────────
  let kiOpen = false;

  // ── Flächen-Farb-Editor ───────────────────────────────────────────────────
  const SWATCHES = ['#1a1a1a','#2d2416','#b8935a','#ffffff','#1a6fc4','#c0392b','#1a6638','#e67e22','#8e44ad','#2c3e50','#f5f0eb','#e8d5b7','#34495e','#7f8c8d'];
  let _cpActive = null;

  function _cpClose() {
    if (_cpActive) {
      _cpActive.popup.remove();
      document.removeEventListener('click', _cpOutside);
      _cpActive = null;
    }
  }
  function _cpOutside(e) {
    if (_cpActive && !_cpActive.popup.contains(e.target)) _cpClose();
  }

  function _cpOpen(el, prop, e) {
    e.stopPropagation();
    _cpClose(); _ilClose();

    const current = getComputedStyle(el)[prop] || '#ffffff';
    const toHex = c => {
      const m = c.match(/\d+/g);
      if (!m) return c;
      return '#' + m.slice(0,3).map(n => parseInt(n).toString(16).padStart(2,'0')).join('');
    };
    const startHex = toHex(current);

    const popup = document.createElement('div');
    popup.id = 'ki-color-popup';

    const propLabel = prop === 'backgroundColor' ? 'Hintergrundfarbe' : 'Farbe';
    popup.innerHTML = `
      <div class="ki-cp-label">🎨 ${propLabel} ändern</div>
      <input type="color" value="${startHex.slice(0,7)}">
      <div class="ki-cp-swatches">${SWATCHES.map(s=>`<div class="ki-cp-swatch" style="background:${s}" data-color="${s}" title="${s}"></div>`).join('')}</div>
      <div class="ki-cp-actions">
        <button class="ki-cp-cancel">Abbrechen</button>
        <button class="ki-cp-confirm">✓ Übernehmen</button>
      </div>`;

    const x = Math.min(e.clientX, window.innerWidth  - 258);
    const y = e.clientY + 12 < window.innerHeight - 220
      ? e.clientY + 12
      : e.clientY - 220;
    popup.style.left = x + 'px';
    popup.style.top  = y + 'px';
    document.body.appendChild(popup);

    const picker = popup.querySelector('input[type=color]');

    picker.addEventListener('input', () => { el.style[prop] = picker.value; });

    popup.querySelectorAll('.ki-cp-swatch').forEach(sw => {
      sw.addEventListener('click', ev => {
        ev.stopPropagation();
        const c = sw.dataset.color;
        picker.value = c;
        el.style[prop] = c;
      });
    });

    const confirm = () => {
      const chosen = picker.value;
      el.style[prop] = chosen;
      addMsg(`🎨 ${propLabel} → ${chosen}`, 'bot');
      _cpClose();
    };

    popup.querySelector('.ki-cp-confirm').addEventListener('click', confirm);
    popup.querySelector('.ki-cp-cancel').addEventListener('click', () => {
      el.style[prop] = startHex;
      _cpClose();
    });

    _cpActive = { popup, el };
    setTimeout(() => document.addEventListener('click', _cpOutside), 100);
  }

  function initColorEditing() {
    const colorTargets = [
      ['.hero-content',  'background', 'Hero-Hintergrund'],
      ['.navbar',        'background', 'Navigation'],
      ['.topbar',        'background', 'Topbar'],
      ['.footer',        'background', 'Footer'],
      ['#leistungen',    'background', 'Leistungen-Bereich'],
      ['#galerie',       'background', 'Galerie-Bereich'],
      ['#ueber',         'background', 'Über uns-Bereich'],
      ['#team',          'background', 'Team-Bereich'],
      ['#preise',        'background', 'Preise-Bereich'],
      ['#bewertungen',   'background', 'Bewertungen-Bereich'],
      ['#kontakt',       'background', 'Kontakt-Bereich'],
      ['.promo-banner',  'background', 'Promo-Banner'],
      ['.btn-primary',        'background', 'Gold-Button'],
      ['.nav-cta',            'background', 'Nav-Button'],
      ['.contact-form-wrap',  'background', 'Formular-Hintergrund'],
      ['.services-strip',     'background', 'Leistungsstreifen'],
    ];
    colorTargets.forEach(([sel, prop, label]) => {
      const el = document.querySelector(sel);
      if (!el) return;
      el.classList.add('ki-colorable');
      const btn = document.createElement('button');
      btn.className = 'ki-color-btn';
      btn.title = `${label} Farbe ändern`;
      btn.textContent = '🎨';
      btn.addEventListener('click', e => { e.stopPropagation(); _cpOpen(el, prop, e); });
      el.appendChild(btn);
    });
  }

  // ── Inline-Editor ──────────────────────────────────────────────────────────
  let _ilActive = null;

  function _ilClose() {
    if (_ilActive) {
      _ilActive.popup.remove();
      document.removeEventListener('click', _ilOutside);
      _ilActive = null;
    }
  }

  function _ilOutside(e) {
    if (_ilActive && !_ilActive.popup.contains(e.target)) _ilClose();
  }

  function _ilOpen(el) {
    _ilClose();
    const original = el.textContent.trim();
    const rect     = el.getBoundingClientRect();

    const popup = document.createElement('div');
    popup.id = 'ki-inline-popup';

    const spaceBelow = window.innerHeight - rect.bottom;
    const top  = spaceBelow > 170 ? rect.bottom + 8 : rect.top - 175;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - 316));

    popup.style.top  = top  + 'px';
    popup.style.left = left + 'px';

    const cs = getComputedStyle(el);
    const toHex = c => { const m = c.match(/\d+/g); return m ? '#'+m.slice(0,3).map(n=>parseInt(n).toString(16).padStart(2,'0')).join('') : '#ffffff'; };
    popup.innerHTML = `
      <div class="ki-il-label">✏️ Text bearbeiten</div>
      <textarea>${original}</textarea>
      <div class="ki-il-hint">Enter = übernehmen &nbsp;·&nbsp; Shift+Enter = neue Zeile</div>
      <div class="ki-il-colors">
        <div class="ki-il-color-row"><label>🔤 Textfarbe</label><input type="color" value="${toHex(cs.color).slice(0,7)}"></div>
        <div class="ki-il-color-row"><label>🖍 Hintergrund</label><input type="color" value="${toHex(cs.backgroundColor).slice(0,7)}"></div>
      </div>
      <div class="ki-il-actions">
        <button class="ki-il-cancel">Abbrechen</button>
        <button class="ki-il-confirm">✓ Übernehmen</button>
      </div>`;

    document.body.appendChild(popup);
    _ilActive = { popup, el, original };

    const ta = popup.querySelector('textarea');
    const [fgPicker, bgPicker] = popup.querySelectorAll('input[type=color]');
    ta.focus(); ta.select();

    let fgChanged = false, bgChanged = false;
    fgPicker.addEventListener('input', () => { fgChanged = true; el.style.color = fgPicker.value; });
    bgPicker.addEventListener('input', () => { bgChanged = true; el.style.backgroundColor = bgPicker.value; });

    const confirm = () => {
      const newText = ta.value.trim();
      if (newText && newText !== original) {
        el.textContent = newText;
        addMsg(`✏️ "${original.slice(0,40)}" → "${newText.slice(0,40)}"`, 'bot');
      }
      if (fgChanged) el.style.color = fgPicker.value;
      if (bgChanged) el.style.backgroundColor = bgPicker.value;
      _ilClose();
    };

    popup.querySelector('.ki-il-confirm').addEventListener('click', confirm);
    popup.querySelector('.ki-il-cancel').addEventListener('click', _ilClose);
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); confirm(); }
      if (e.key === 'Escape') _ilClose();
    });

    setTimeout(() => document.addEventListener('click', _ilOutside), 100);
  }

  // ── Button-Editor ─────────────────────────────────────────────────────────
  let _bpActive = null;

  function _bpClose() {
    if (_bpActive) { _bpActive.popup.remove(); document.removeEventListener('click', _bpOutside); _bpActive = null; }
  }
  function _bpOutside(e) { if (_bpActive && !_bpActive.popup.contains(e.target)) _bpClose(); }

  function _bpOpen(el, e) {
    e.stopPropagation(); e.preventDefault();
    _bpClose(); _ilClose(); _cpClose();
    const cs = getComputedStyle(el);
    const toHex = c => { const m = c.match(/\d+/g); return m ? '#'+m.slice(0,3).map(n=>parseInt(n).toString(16).padStart(2,'0')).join('') : '#ffffff'; };

    const popup = document.createElement('div');
    popup.id = 'ki-btn-popup';
    const x = Math.min(e.clientX, window.innerWidth - 288);
    const y = e.clientY + 12 < window.innerHeight - 200
      ? e.clientY + 12 : e.clientY - 210;
    popup.style.left = x+'px'; popup.style.top = y+'px';

    popup.innerHTML = `
      <div class="ki-bp-label">🔘 Button bearbeiten</div>
      <input type="text" value="${el.textContent.trim()}" placeholder="Button-Text">
      <div class="ki-bp-colors">
        <div class="ki-bp-color-row"><label>Hintergrund</label><input type="color" value="${toHex(cs.backgroundColor).slice(0,7)}"></div>
        <div class="ki-bp-color-row"><label>Textfarbe</label><input type="color" value="${toHex(cs.color).slice(0,7)}"></div>
      </div>
      <div class="ki-bp-actions">
        <button class="ki-bp-cancel">Abbrechen</button>
        <button class="ki-bp-confirm">✓ Übernehmen</button>
      </div>`;
    document.body.appendChild(popup);

    const [bgPicker, fgPicker] = popup.querySelectorAll('input[type=color]');
    bgPicker.addEventListener('input', () => el.style.background = bgPicker.value);
    fgPicker.addEventListener('input', () => el.style.color = fgPicker.value);

    const confirm = () => {
      const txt = popup.querySelector('input[type=text]').value.trim();
      if (txt) el.textContent = txt;
      el.style.background = bgPicker.value;
      el.style.color = fgPicker.value;
      addMsg(`🔘 Button geändert: "${txt}" bg:${bgPicker.value} fg:${fgPicker.value}`, 'bot');
      _bpClose();
    };
    popup.querySelector('.ki-bp-confirm').addEventListener('click', confirm);
    popup.querySelector('.ki-bp-cancel').addEventListener('click', _bpClose);
    popup.querySelector('input[type=text]').addEventListener('keydown', e => { if(e.key==='Enter') confirm(); if(e.key==='Escape') _bpClose(); });
    _bpActive = { popup, el };
    setTimeout(() => document.addEventListener('click', _bpOutside), 100);
  }

  function initButtonEditing() {
    document.querySelectorAll('.btn-primary,.btn-outline,.nav-cta,.mobile-menu-cta,.form-submit').forEach(btn => {
      if (btn.closest('#ki-panel,#ki-fab')) return;
      btn.classList.add('ki-btn-editable');
      const badge = document.createElement('span');
      badge.className = 'ki-btn-badge'; badge.textContent = '✏️';
      btn.appendChild(badge);
      btn.addEventListener('click', e => _bpOpen(btn, e));
    });
  }

  function initInlineEditing() {
    function makeEditable(el) {
      if (!el || !el.textContent.trim()) return;
      if (el.closest('#ki-panel,#ki-fab,script,style')) return;
      el.classList.add('ki-editable');
      el.addEventListener('click', e => { e.stopPropagation(); _ilOpen(el); });
    }

    function makeMixedEditable(el) {
      if (!el || el.closest('#ki-panel,#ki-fab')) return;
      // Elternelement selbst NICHT klickbar – nur die Teilbereiche
      el.classList.remove('ki-editable');
      el.childNodes.forEach(node => {
        if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
          const span = document.createElement('span');
          span.className = 'ki-editable ki-text-node';
          span.textContent = node.textContent;
          el.replaceChild(span, node);
          span.addEventListener('click', e => { e.stopPropagation(); _ilOpen(span); });
        } else if (node.nodeType === Node.ELEMENT_NODE && node.textContent.trim()) {
          makeEditable(node);
        }
      });
    }

    const simpleTargets = [
      'h2','h3','h4',
      '.topbar-item',
      '.nav-links a','.nav-tel',
      '.hero-eyebrow','.hero-desc',
      '.hero-image-tag-name','.hero-image-tag-role','.hero-image-tag-stars',
      '.stat-num','.stat-label',
      '.eyebrow','.section-title','.section-subtitle',
      '.service-card h3','.service-card p','.service-duration',
      '.promo-tag','.promo-desc',
      '.about-badge-num','.about-badge-txt','.about-text p',
      '.team-name','.team-role','.team-desc',
      '.price-cat-name','.price-name','.price-val','.price-from',
      '.review-stars','.review-text','.review-name','.review-date','.review-source',
      '.contact-form-wrap h3','.form-subtitle',
      '.form-group label',
      '.cb-val','.hours-table td',
      '.footer-desc','.footer-col h4','.footer-col ul a',
      '.footer-contact-item a','.footer-contact-item span:last-child',
      '.footer-bottom p','.footer-legal a',
      '.footer-logo span',
    ].join(',');

    document.querySelectorAll(simpleTargets).forEach(el => makeEditable(el));

    document.querySelectorAll('h1, .promo-title, .strip-item, .service-price').forEach(el => {
      if (el.closest('#ki-panel,#ki-fab')) return;
      if (el.children.length > 0) {
        makeMixedEditable(el);
      } else {
        makeEditable(el);
      }
    });

    document.querySelectorAll('.form-group input, .form-group textarea, .form-group select').forEach(input => {
      if (!input.placeholder && input.tagName !== 'SELECT') return;
      input.classList.add('ki-editable');
      input.addEventListener('focus', e => {
        e.preventDefault(); e.stopPropagation(); input.blur();
        const label = input.closest('.form-group')?.querySelector('label')?.textContent || 'Feld';
        const orig  = input.placeholder || '';
        const popup = document.createElement('div');
        popup.id = 'ki-inline-popup';
        const r = input.getBoundingClientRect();
        popup.style.cssText = `position:fixed;z-index:99999;left:${Math.min(r.left,window.innerWidth-320)}px;top:${r.top-110}px;width:300px;background:#fff;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.18);padding:14px;border:2px solid #b8935a;`;
        popup.innerHTML = `<div style="font-size:12px;color:#b8935a;font-weight:700;margin-bottom:8px;">✏️ Platzhalter: ${label}</div><input class="ki-il-inp" value="${orig}" style="width:100%;border:1px solid #ddd;border-radius:8px;padding:8px;font-size:14px;box-sizing:border-box;" /><div style="display:flex;gap:8px;margin-top:8px;"><button class="ki-il-cancel" style="flex:1;padding:8px;border:1px solid #ddd;border-radius:8px;cursor:pointer;background:#f5f5f5;">Abbrechen</button><button class="ki-il-ok" style="flex:1;padding:8px;background:#b8935a;color:white;border:none;border-radius:8px;cursor:pointer;font-weight:600;">✓ OK</button></div>`;
        document.body.appendChild(popup);
        const inp = popup.querySelector('.ki-il-inp'); inp.focus(); inp.select();
        popup.querySelector('.ki-il-ok').onclick = () => { input.placeholder = inp.value; popup.remove(); };
        popup.querySelector('.ki-il-cancel').onclick = () => popup.remove();
        inp.addEventListener('keydown', e => { if(e.key==='Enter'){input.placeholder=inp.value;popup.remove();} if(e.key==='Escape')popup.remove(); });
        setTimeout(() => document.addEventListener('click', function h(e){ if(!popup.contains(e.target)){popup.remove();document.removeEventListener('click',h);} }), 100);
      });
    });
  }

  // ── Zugriff nur mit ?edit=TOKEN ────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    const urlToken = new URLSearchParams(window.location.search).get('edit');
    const fab   = document.getElementById('ki-fab');
    const panel = document.getElementById('ki-panel');

    if (urlToken !== KI_TOKEN) {
      fab.style.display   = 'none';
      panel.style.display = 'none';
      return;
    }

    panel.classList.remove('open');
    fab.classList.remove('open');
    fab.textContent = '✨';

    document.querySelectorAll('a[href]').forEach(a => {
      if (a.closest('#ki-panel,#ki-fab')) return;
      a.addEventListener('click', e => e.preventDefault());
    });

    document.addEventListener('click', e => {
      const a = e.target.closest('a[href]');
      if (a && !a.closest('#ki-panel') && !a.closest('#ki-fab')) {
        e.preventDefault();
      }
    }, true);

    initInlineEditing();
    initColorEditing();
    initButtonEditing();
  });

  // ── Globale Funktionen (für onclick-Handler im HTML) ──────────────────────
  window.toggleKI = function() {
    kiOpen = !kiOpen;
    document.getElementById('ki-panel').classList.toggle('open', kiOpen);
    document.getElementById('ki-fab').classList.toggle('open', kiOpen);
    document.getElementById('ki-fab').textContent = kiOpen ? '✕' : '✨';
    if (kiOpen) {
      loadCredits();
      document.getElementById('ki-input').focus();
    }
  };

  window.loadCredits = async function() {
    try {
      const r = await fetch(`${KI_PROXY}/api/status`, { headers: { 'x-client-token': KI_TOKEN } });
      const d = await r.json();
      document.getElementById('ki-credits-badge').textContent = `${d.credits ?? '?'} Credits`;
    } catch(e) {}
  };

  window.kiChip = function(el) {
    document.getElementById('ki-input').value = el.textContent;
    document.getElementById('ki-input').focus();
  };

  window.addMsg = function(text, type) {
    const msgs = document.getElementById('ki-messages');
    const typing = document.getElementById('ki-typing');
    const div = document.createElement('div');
    div.className = `ki-msg ${type}`;
    div.innerHTML = text;
    msgs.insertBefore(div, typing);
    msgs.scrollTop = msgs.scrollHeight;
  };

  // local alias for internal use
  function addMsg(text, type) { window.addMsg(text, type); }

  function replaceTextInDOM(findText, replaceText) {
    let count = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: n => n.parentElement?.closest('#ki-panel,#ki-fab,script,style,noscript')
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    });
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    for (const n of nodes) {
      if (n.textContent.includes(findText)) {
        n.textContent = n.textContent.replaceAll(findText, replaceText);
        count++;
      }
    }
    return count;
  }

  function applyChanges(changes) {
    let ok = 0, fail = [];
    for (const c of changes) {
      try {
        if (c.type === 'text') {
          const n = replaceTextInDOM(c.find, c.replace);
          if (n > 0) ok++; else fail.push(`"${c.find}" nicht gefunden`);
        } else if (c.type === 'style') {
          const els = document.querySelectorAll(c.selector);
          if (els.length) { els.forEach(el => el.style[c.prop] = c.value); ok++; }
          else fail.push(`Selektor "${c.selector}" nicht gefunden`);
        } else if (c.type === 'cssvar') {
          document.documentElement.style.setProperty(c.name, c.value); ok++;
        }
      } catch(e) { fail.push(e.message); }
    }
    return { ok, fail };
  }

  function buildPageContext() {
    const skip = el => el.closest('#ki-panel,#ki-fab');
    const parts = [];
    document.querySelectorAll('.topbar, nav, section, footer').forEach(sec => {
      if (skip(sec)) return;
      const heading = sec.querySelector('h1,h2')?.textContent?.trim() || sec.id || sec.className.split(' ')[0];
      const text = (sec.innerText || '').replace(/\n{3,}/g,'\n\n').trim().slice(0, 600);
      if (text.length > 10) parts.push(`=== ${heading} ===\n${text}`);
    });
    return parts.join('\n\n').slice(0, 4000);
  }

  window.kiSend = async function() {
    const input = document.getElementById('ki-input');
    const btn   = document.getElementById('ki-send-btn');
    const msg   = input.value.trim();
    if (!msg) return;

    addMsg(msg, 'user');
    input.value = '';
    input.style.height = 'auto';
    btn.disabled = true;
    document.getElementById('ki-chips').style.display = 'none';
    document.getElementById('ki-typing').classList.add('visible');
    document.getElementById('ki-messages').scrollTop = 999999;

    try {
      const pageContext = buildPageContext();

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);

      const res = await fetch(`${KI_PROXY}/api/chat`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'x-client-token': KI_TOKEN },
        body: JSON.stringify({
          system: `Du bist ein Website-Editor. Du bekommst den sichtbaren Text einer Website und eine Änderungsanfrage.
Antworte NUR mit einem JSON-Array – kein Markdown, keine Erklärung, kein Text außerhalb des Arrays.

ÄNDERUNGSTYPEN:
1. Text ändern (funktioniert für JEDEN Text auf der Seite):
   {"type":"text","find":"EXAKTER TEXT wie er auf der Seite steht","replace":"NEUER TEXT","desc":"was wurde geändert"}

2. Farbe / Stil ändern:
   {"type":"style","selector":"CSS-SELEKTOR","prop":"CSS-Eigenschaft (camelCase)","value":"Wert","desc":"was wurde geändert"}

3. Globale Akzentfarbe (ändert Buttons, Icons, Akzente auf einmal):
   {"type":"cssvar","name":"--gold","value":"#FARBE","desc":"was wurde geändert"}

BEKANNTE STIL-SELEKTOREN:
- Hero-Hintergrund links (dunkler Bereich): .hero-content → background
- Navigation Hintergrund: .navbar → background
- Topbar Hintergrund: .topbar → background
- Footer Hintergrund: .footer → background
- Alle Abschnitts-Überschriften: h2.section-title → color
- Alle Buttons: .btn-primary → background / color
- Nav-Button "Termin buchen": .nav-cta → background / color
- Abschnitt Leistungen: #leistungen → background
- Abschnitt Team: #team → background

FARBBEISPIELE: Blau #1a6fc4 | Rot #c0392b | Grün #1a6638 | Orange #e67e22 | Lila #8e44ad

REGELN:
- "find" muss EXAKT dem Text auf der Seite entsprechen (nicht kürzen, nicht paraphrasieren)
- Ändere NUR was der Nutzer verlangt
- Bei unklarer Anfrage: [{"type":"question","desc":"Rückfrage an den Nutzer"}]`,
          messages: [{ role: 'user', content: `Seiteninhalt:\n${pageContext}\n\nGewünschte Änderung: ${msg}` }]
        })
      });
      clearTimeout(timeout);
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      let raw = (data.content?.[0]?.text || '').trim()
        .replace(/^```[\w]*\s*\n?/, '').replace(/\n?```[\w]*\s*$/g, '').trim();

      let changes;
      try { changes = JSON.parse(raw); } catch(e) {
        addMsg(raw || 'Keine Antwort erhalten.', 'bot');
        return;
      }

      if (changes[0]?.type === 'question') {
        addMsg(changes[0].desc, 'bot');
        return;
      }

      const { ok, fail } = applyChanges(changes);
      const descs = changes.filter(c=>c.desc && c.type!=='question').map(c=>c.desc).join(', ');

      if (ok > 0) addMsg(`✅ ${descs || ok + ' Änderung(en) vorgenommen'}`, 'bot');
      if (fail.length) addMsg(`⚠️ Nicht angewendet: ${fail.join('; ')}`, 'error');

      if (data._credits_remaining !== undefined) {
        document.getElementById('ki-credits-badge').textContent = `${data._credits_remaining} Credits`;
      }
    } catch(err) {
      if (err.name === 'AbortError') {
        addMsg('⏱️ Zeitüberschreitung – bitte nochmal versuchen.', 'error');
      } else {
        addMsg(`❌ Fehler: ${err.message}`, 'error');
      }
    }

    document.getElementById('ki-typing').classList.remove('visible');
    document.getElementById('ki-chips').style.display = '';
    btn.disabled = false;
    window.loadCredits();
  };

  window.kiSave = async function() {
    const btn = document.getElementById('ki-save-btn');
    btn.disabled = true;
    btn.classList.add('saving');
    btn.textContent = '⏳ Wird gespeichert…';

    try {
      const panel = document.getElementById('ki-panel');
      const fab   = document.getElementById('ki-fab');
      panel.classList.remove('open');
      fab.classList.remove('open');
      fab.textContent = '✨';
      kiOpen = false;

      const html = document.documentElement.outerHTML;

      const saveCtrl = new AbortController();
      const saveTimeout = setTimeout(() => saveCtrl.abort(), 20000);

      const res  = await fetch(`${KI_PROXY}/api/save`, {
        method: 'POST',
        signal: saveCtrl.signal,
        headers: { 'Content-Type': 'application/json', 'x-client-token': KI_TOKEN },
        body: JSON.stringify({ html, site: 'demo' })
      });
      clearTimeout(saveTimeout);
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Unbekannter Fehler');

      btn.classList.remove('saving');
      btn.classList.add('saved');
      btn.textContent = '✅ Veröffentlicht!';
      addMsg('✅ Seite erfolgreich gespeichert und veröffentlicht!', 'bot');

      setTimeout(() => {
        btn.classList.remove('saved');
        btn.disabled = false;
        btn.innerHTML = '💾 Änderungen veröffentlichen';
      }, 3000);
    } catch(err) {
      btn.classList.remove('saving');
      btn.disabled = false;
      btn.innerHTML = '💾 Änderungen veröffentlichen';
      const msg2 = err.name === 'AbortError'
        ? '⏱️ Zeitüberschreitung beim Speichern – bitte nochmal versuchen.'
        : `❌ Speichern fehlgeschlagen: ${err.message}`;
      addMsg(msg2, 'error');
    }
  };

})();
