#!/usr/bin/env node
/**
 * SiteAI Admin CLI
 * Usage:
 *   node admin.js list
 *   node admin.js add "Mustermann Sanitär GmbH" 30
 *   node admin.js credits <token> 50
 *   node admin.js enable  <token>
 *   node admin.js disable <token>
 *   node admin.js delete  <token>
 *   node admin.js info    <token>
 */

const fs = require('fs');
const path = require('path');

const CLIENTS_FILE = path.join(__dirname, 'clients.json');

function load() {
  if (!fs.existsSync(CLIENTS_FILE)) return {};
  return JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8'));
}

function save(clients) {
  fs.writeFileSync(CLIENTS_FILE, JSON.stringify(clients, null, 2));
}

function genToken() {
  return 'sat_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

const [, , cmd, ...args] = process.argv;

switch (cmd) {
  case 'list': {
    const clients = load();
    const entries = Object.entries(clients);
    if (entries.length === 0) {
      console.log('Keine Kunden vorhanden.');
      break;
    }
    console.log('\n=== SiteAI Kunden ===\n');
    for (const [token, c] of entries) {
      const status = c.active ? '✅' : '🔴';
      console.log(`${status} ${c.name}`);
      console.log(`   Token  : ${token}`);
      console.log(`   Credits: ${c.credits}`);
      console.log(`   Erstellt: ${c.created}`);
      console.log(`   Letzter Abruf: ${c.lastUsed || '—'}`);
      console.log('');
    }
    break;
  }

  case 'add': {
    const name = args[0];
    const credits = parseInt(args[1] ?? '30', 10);
    if (!name) {
      console.error('Usage: node admin.js add "Kundenname" [credits]');
      process.exit(1);
    }
    const token = genToken();
    const clients = load();
    clients[token] = {
      name,
      credits,
      active: true,
      created: new Date().toISOString(),
      lastUsed: null,
    };
    save(clients);
    console.log(`✅ Kunde angelegt: ${name}`);
    console.log(`   Token  : ${token}`);
    console.log(`   Credits: ${credits}`);
    break;
  }

  case 'credits': {
    const token = args[0];
    const amount = parseInt(args[1], 10);
    if (!token || isNaN(amount)) {
      console.error('Usage: node admin.js credits <token> <amount>');
      process.exit(1);
    }
    const clients = load();
    if (!clients[token]) { console.error('Token nicht gefunden.'); process.exit(1); }
    clients[token].credits += amount;
    save(clients);
    console.log(`✅ ${clients[token].name}: Credits jetzt ${clients[token].credits}`);
    break;
  }

  case 'enable': {
    const clients = load();
    const token = args[0];
    if (!clients[token]) { console.error('Token nicht gefunden.'); process.exit(1); }
    clients[token].active = true;
    save(clients);
    console.log(`✅ ${clients[token].name} aktiviert.`);
    break;
  }

  case 'disable': {
    const clients = load();
    const token = args[0];
    if (!clients[token]) { console.error('Token nicht gefunden.'); process.exit(1); }
    clients[token].active = false;
    save(clients);
    console.log(`🔴 ${clients[token].name} deaktiviert.`);
    break;
  }

  case 'delete': {
    const clients = load();
    const token = args[0];
    if (!clients[token]) { console.error('Token nicht gefunden.'); process.exit(1); }
    const name = clients[token].name;
    delete clients[token];
    save(clients);
    console.log(`🗑️  ${name} gelöscht.`);
    break;
  }

  case 'info': {
    const clients = load();
    const token = args[0];
    if (!clients[token]) { console.error('Token nicht gefunden.'); process.exit(1); }
    const c = clients[token];
    console.log(`\n${c.name}`);
    console.log(`Token  : ${token}`);
    console.log(`Credits: ${c.credits}`);
    console.log(`Aktiv  : ${c.active}`);
    console.log(`Erstellt: ${c.created}`);
    console.log(`Letzter Abruf: ${c.lastUsed || '—'}`);
    break;
  }

  default:
    console.log(`
SiteAI Admin CLI

Befehle:
  list                          Alle Kunden anzeigen
  add <name> [credits=30]       Neuen Kunden anlegen
  credits <token> <amount>      Credits addieren (oder subtrahieren mit negativem Wert)
  enable  <token>               Kunden aktivieren
  disable <token>               Kunden deaktivieren
  delete  <token>               Kunden löschen
  info    <token>               Details zu einem Kunden
`);
}
