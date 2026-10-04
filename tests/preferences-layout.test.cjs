const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {DOMParser} = require('@xmldom/xmldom');
const {load, prefs, root} = require('./helpers.cjs');
const HTML = 'http://www.w3.org/1999/xhtml';
function parse() {
    const source = fs.readFileSync(root + '/addon/chrome/content/preferences.xhtml', 'utf8')
        .replaceAll('__addonRef__', 'zotts');
    return new DOMParser({errorHandler: {
        warning: message => {throw new Error(message);},
        error: message => {throw new Error(message);},
        fatalError: message => {throw new Error(message);},
    }}).parseFromString(`<root xmlns="http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul" xmlns:html="${HTML}">${source}</root>`, 'text/xml');
}
const elements = node => Array.from(node.childNodes).filter(child => child.nodeType === 1);
test('settings order and omission subsection retain their bindings in valid mixed-namespace XML', () => {
    const doc = parse();
    const pane = doc.getElementById('zotero-prefpane-zotts');
    const sections = elements(pane).filter(node => node.getAttribute('class') === 'main-section');
    assert.deepEqual(sections.map(node => node.getAttribute('id')), [
        'zotts-favourites', 'zotts-advanced', 'zotts-general', 'zotts-webSpeech',
        'zotts-azure', 'zotts-openai', 'zotts-local', 'zotts-kokoro', 'zotts-shortcuts',
    ]);
    const advanced = doc.getElementById('zotts-advanced');
    const annotations = doc.getElementById('zotts-ignore-annotations');
    assert.notEqual(annotations.getAttribute('class'), 'main-section');
    let ancestor = annotations.parentNode;
    while (ancestor && ancestor !== advanced) ancestor = ancestor.parentNode;
    assert.equal(ancestor, advanced);
    assert.equal(annotations.getElementsByTagNameNS(HTML, 'h3')[0].getAttribute('data-l10n-id'), 'pref-sect-ignoreAnnotations');
    assert.equal(doc.getElementById('ignoreAnnotations-color').getAttribute('preference'), '__prefsPrefix__.ignoreAnnotations.color');
    assert.equal(doc.getElementById('zotts-advanced-subs-input').getAttribute('oninput'), "Zotero.__addonInstance__.hooks.onPrefsRefresh('subs-text', window.document)");
    assert.equal(doc.getElementById('engine-webSpeech').getAttribute('value'), 'webSpeech');
    const ids = Array.from(doc.getElementsByTagName('*')).map(node => node.getAttribute('id')).filter(Boolean);
    assert.equal(new Set(ids).size, ids.length);
});
test('each section has a native, initially open keyboard-accessible disclosure with controls still attached when closed', () => {
    const doc = parse();
    const sections = elements(doc.getElementById('zotero-prefpane-zotts')).filter(node => node.getAttribute('class') === 'main-section');
    for (const section of sections) {
        const [details] = elements(section);
        assert.equal(details.namespaceURI, HTML);
        assert.equal(details.localName, 'details');
        assert.ok(details.hasAttribute('open'));
        const [summary, content] = elements(details);
        assert.equal(summary.namespaceURI, HTML);
        assert.equal(summary.localName, 'summary');
        const heading = elements(summary)[0];
        assert.equal(heading.namespaceURI, HTML);
        assert.equal(heading.localName, 'h2');
        assert.ok(heading.getAttribute('data-l10n-id'));
        assert.equal(content.localName, 'vbox');
        assert.equal(content.getAttribute('class'), 'settings-content');
        const controls = content.getElementsByTagName('*').length;
        details.removeAttribute('open');
        assert.equal(content.getElementsByTagName('*').length, controls);
        details.setAttribute('open', 'open');
        assert.equal(content.getElementsByTagName('*').length, controls);
    }
});
test('English labels use System voices and preserve the exact requested section titles', () => {
    for (const locale of ['en-GB', 'en-US']) {
        const preferences = fs.readFileSync(`${root}/addon/locale/${locale}/preferences.ftl`, 'utf8');
        const tts = fs.readFileSync(`${root}/addon/locale/${locale}/tts.ftl`, 'utf8');
        assert.match(preferences, /pref-sect-wsa = System voices/);
        assert.match(preferences, /pref-general-engine-webSpeech =\s+\.label = System voices/);
        assert.match(preferences, /pref-sect-advanced = Substitutions & omissions/);
        assert.match(preferences, /pref-sect-ignoreAnnotations = Per document ommissions/);
        assert.match(tts, /\[webSpeech\] System voices/);
        assert.doesNotMatch(preferences + tts, /Web Speech|WSA engine/);
    }
});
test('the preferences registration loads scoped disclosure styling', () => {
    let registered;
    const hooks = load('src/modules/prefsWindow.ts', {
        '../../package.json': require('../package.json'), './utils/locale': {},
        './utils/prefs': {}, './favourites': {},
    }, {
        rootURI: 'chrome://zotts/',
        Zotero: {PreferencePanes: {register(options) {registered = options; return Promise.resolve();}}},
    });
    hooks.registerPrefsWindow();
    assert.equal(registered.src, 'chrome://zotts/chrome/content/preferences.xhtml');
    assert.deepEqual(Array.from(registered.stylesheets), ['chrome://zotts/chrome/content/preferences.css']);
    const css = fs.readFileSync(root + '/addon/chrome/content/preferences.css', 'utf8');
    assert.match(css, /#zotero-prefpane-zotts details:not\(\[open\]\) > \.settings-content\s*\{\s*display: none;/);
    assert.match(css, /summary:focus-visible/);
});
test('load and substitution refresh initialize attached controls while every disclosure is collapsed', async () => {
    const doc = parse();
    const disclosures = Array.from(doc.getElementsByTagNameNS(HTML, 'details'));
    assert.equal(disclosures.length, 9);
    for (const details of disclosures) details.removeAttribute('open');
    for (const node of Array.from(doc.getElementsByTagName('*'))) {
        node.style = {};
        node.value = '';
        node.replaceChildren = (...children) => {
            while (node.firstChild) node.removeChild(node.firstChild);
            children.forEach(child => node.appendChild(child));
        };
    }
    const overall = doc.getElementById('zotts-pref-subs-citationsOverall');
    const subitems = ['Parenthetical', 'Numeric'].map(name => doc.getElementById('zotts-pref-subs-citations' + name));
    subitems[0].checked = true;
    subitems[1].checked = false;
    doc.querySelectorAll = selector => selector === '.modifier' ? [] : subitems;
    const values = {'subs.customSubs': '"old":"rule"', favouritesList: '[]'};
    let populated = false;
    const hooks = load('src/modules/prefsWindow.ts', {
        '../../package.json': require('../package.json'), './utils/locale': {getString: () => 'Test sentence'},
        './utils/prefs': prefs(values), './favourites': {},
    }, {
        setTimeout: fn => fn(), Zotero: {isMac: true}, ztoolkit: {log() {}},
        addon: {data: {tts: {engines: {webSpeech: {status: 'ready', extras: {populateVoiceList(received) {
            assert.equal(received, doc); populated = true;
        }}}}}}},
    });
    hooks.prefsLoadHook('load', doc);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(populated, true);
    const input = doc.getElementById('zotts-advanced-subs-input');
    assert.equal(input.value, values['subs.customSubs']);
    assert.equal(overall.indeterminate, true);
    overall.checked = true;
    hooks.prefsRefreshHook('subs-cite-overall', doc);
    assert.ok(subitems.every(node => node.checked));
    input.value = '"new":"rule"';
    hooks.prefsRefreshHook('subs-text', doc);
    assert.equal(values['subs.customSubs'], input.value);
    for (const details of Array.from(doc.getElementsByTagNameNS(HTML, 'details'))) assert.ok(!details.hasAttribute('open'));
});
