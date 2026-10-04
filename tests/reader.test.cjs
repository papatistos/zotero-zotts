const test = require("node:test");
const assert = require("node:assert/strict");
const {load, prefs} = require("./helpers.cjs");
test("detached Play reads its reader rather than a library tab", async () => {
    const reader = {id: "detached"};
    const spoken = [];
    const hooks = load("src/modules/tts/ttsHooks.ts", {
        ".": {checkStatus: () => true}, "../utils/locale": {},
        "../utils/prefs": prefs({}), "../utils/text": {preprocessText: s => s}, "../utils/notify": {},
        "../utils/readerUtils": {getSelectedAnnotations(r) {assert.equal(r, reader); return [];}, getFullText: async r => {assert.equal(r, reader); return "detached text";}},
    }, {Zotero_Tabs: {selectedType: "library"}, Zotero: {getActiveZoteroPane() {throw Error("Wrong library context");}}, ztoolkit: {Reader: {getSelectedText: () => ""}}, addon: {data: {tts: {state: "idle", current: "azure", engines: {azure: {speak: t => spoken.push(t)}}}}}});
    hooks.speakOrResume(undefined, reader);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(spoken, ["detached text"]);
});
test("toolbar Play passes the event reader to the speech hook", () => {
    const events = {};
    let options;
    const reader = {id: "detached"};
    const calls = [];
    const module = load("src/modules/reader.ts", {
        "../../package.json": {config: {addonID: "test"}}, "./utils/locale": {}, "./utils/readerUtils": {}, "./utils/prefs": prefs({}),
    }, {Zotero: {Reader: {_unregisterEventListenerByPluginID() {}, registerEventListener(name, fn) {events[name]=fn;}}},
        ztoolkit: {UI: {createElement(doc, tag, value) {options=value; return {};}}}, addon: {data: {ui: {icons: {}, toolbars: []}}, hooks: {onSpeakOrResume: (...args) => calls.push(args)}}});
    module.registerReaderListeners();
    events.renderToolbar({reader, doc: {}, append() {}});
    options.children[3].listeners[0].listener();
    assert.equal(calls[0][0], undefined);
    assert.equal(calls[0][1], reader);
});
