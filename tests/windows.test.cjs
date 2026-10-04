const test = require("node:test");
const assert = require("node:assert/strict");
const {load} = require("./helpers.cjs");
test("window unload removes only its menus and global registrations occur once", async () => {
    const menus = new Map();
    const counts = {prefs: 0, shortcuts: 0, readers: 0, unregister: 0};
    const toolkit = {unregisterAll() {counts.unregister++;}};
    const addon = {data: {ztoolkit: toolkit, tts: {engines: {}}}};
    const hooks = load("src/hooks.ts", {
        "../package.json": {config: {addonInstance: "ZoTTS", addonID: "test"}},
        "./modules/utils/prefs": {}, "zotero-plugin-toolkit": {ZoteroToolkit: class {}},
        "./modules/menu": {registerMenu(win) {menus.set(win, true); return () => menus.delete(win);}},
        "./modules/prefsWindow": {registerPrefsWindow() {counts.prefs++;}},
        "./modules/shortcuts": {registerShortcuts() {counts.shortcuts++;}},
        "./modules/reader": {registerReaderListeners() {counts.readers++;}},
        "./modules/favourites": {}, "./modules/utils/locale": {},
        "./modules/tts": {}, "./modules/tts/ttsHooks": {},
        "./modules/utils/icons": {}, "./modules/utils/notify": {notifyStatus() {}},
    }, {addon, ztoolkit: toolkit, Zotero: {Reader: {_unregisterEventListenerByPluginID() {}}}}).default;
    const first = {document: {readyState: "complete"}};
    const second = {document: {readyState: "complete"}};
    await hooks.onMainWindowLoad(first);
    await hooks.onMainWindowLoad(second);
    await hooks.onMainWindowLoad(first);
    assert.equal(counts.shortcuts, 1);
    assert.equal(counts.readers, 1);
    assert.equal(counts.prefs, 1);
    assert.equal(addon.data.ztoolkit, toolkit);
    await hooks.onMainWindowUnload(first);
    assert.equal(menus.has(first), false);
    assert.equal(menus.has(second), true);
    assert.equal(counts.unregister, 0);
    hooks.onShutdown();
    assert.equal(menus.size, 0);
    assert.equal(counts.unregister, 1);
});
test("menus use their owning window selection and cleanup removes their nodes", () => {
    const {config} = require("../package.json");
    const spoken = [];
    const nodes = [];
    const win = {ZoteroPane: {getSelectedItems: () => [23]}, document: {
        getElementById: () => ({appendChild(node) {nodes.push(node);}}),
        createXULElement: tag => ({tag, attributes: {}, setAttribute(k,v) {this.attributes[k]=v;}, addEventListener(k,v) {this[k]=v;}, remove() {this.removed=true;}}),
    }};
    const menu = load("src/modules/menu.ts", {"../../package.json": {config}, "./utils/locale": {getString: k => k}}, {
        Zotero: {Items: {get(id) {assert.equal(id, 23); return {getField: k => k + " text"};}}},
        addon: {hooks: {onSpeak: text => spoken.push(text)}},
    });
    const cleanup = menu.registerMenu(win);
    assert.equal(nodes.length, 3);
    nodes[1].command(); nodes[2].command();
    assert.deepEqual(spoken, ["title text", "abstractNote text"]);
    cleanup();
    assert.ok(nodes.every(node => node.removed));
});
