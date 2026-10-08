// Builds dist/Amitek_Bot.gs: Code.gs + App.gs + Grow.gs + App.html in ONE file to paste into Apps Script.
// Run: node apps-script/build.js
const fs = require('fs');
const path = require('path');
const dir = __dirname;
const read = f => fs.readFileSync(path.join(dir, f), 'utf8');
const out = [
  '/**',
  ' * Amitek WhatsApp Lead Bot - single file. Paste this whole file into Extensions > Apps Script (Code.gs),',
  ' * save, then Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).',
  ' * Then open the Amitek app, paste the Web app link and choose a PIN. Everything else is set up from the app.',
  ' * Built from Code.gs + App.gs + Grow.gs + App.html in github.com/drsourrabhbairwa/amitek-whatsapp-bot. Do not edit here.',
  ' */',
  '',
  read('Code.gs'),
  '',
  read('App.gs'),
  '',
  read('Grow.gs'),
  '',
  '// The phone app page (App.html), served when the Web app link is opened in a browser.',
  'var APP_HTML = ' + JSON.stringify(read('App.html')) + ';',
  ''
].join('\n');
fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
fs.writeFileSync(path.join(dir, 'dist', 'Amitek_Bot.gs'), out);
console.log('wrote dist/Amitek_Bot.gs', out.length, 'bytes');
