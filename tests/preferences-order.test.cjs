const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {root} = require('./helpers.cjs');
test('Favourites is the first settings section with its original bindings', () => {
 const source = fs.readFileSync(root + '/addon/chrome/content/preferences.xhtml', 'utf8');
 const first = source.match(/<vbox class="main-section"[^>]*>/)[0];
 assert.match(first, /id="__addonRef__-favourites"/);
 assert.ok(source.indexOf('id="__addonRef__-advanced-faves"') < source.indexOf('id="__addonRef__-general"'));
 for (const binding of ['id="faves-list"', "onPrefsRefresh('faves-add-voice', window.document)", "onPrefsRefresh('faves-remove-voice', window.document)"]) {
  assert.equal(source.split(binding).length, 2);
 }
});
