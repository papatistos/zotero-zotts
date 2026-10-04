const test = require("node:test");
const assert = require("node:assert/strict");
const {load, prefs} = require("./helpers.cjs");
for (const isMac of [true, false]) {
    test(isMac ? "macOS uses Command" : "other platforms use Control", () => {
        const calls = [];
        let callback;
        const hooks = Object.fromEntries(["onSpeakOrResume", "onPause", "onStop", "onCycleFavourite", "onSpeedChange"].map(key => [key, (...args) => calls.push([key, ...args])]));
        const values = {"shortcuts.speak": "S", "shortcuts.pause": "P", "shortcuts.cancel": "C", "shortcuts.cycleFavourite": "Q", "shortcuts.speedUp": ">", "shortcuts.speedDown": "<"};
        load("src/modules/shortcuts.ts", {"./utils/prefs": prefs(values)}, {Zotero: {isMac}, addon: {hooks}, ztoolkit: {Keyboard: {register(fn) {callback = fn;}}}}).registerShortcuts();
        const ev = {metaKey: isMac, ctrlKey: !isMac, shiftKey: true};
        for (const key of ["S", "P", "C", "Q", ">", "<"]) callback({...ev, key}, {type: "keyup"});
        assert.deepEqual(calls, [["onSpeakOrResume", true], ["onPause"], ["onStop"], ["onCycleFavourite"], ["onSpeedChange", true], ["onSpeedChange", false]]);
        callback({...ev, key: "S"}, {type: "keydown"});
        callback({...ev, key: "S", metaKey: !isMac, ctrlKey: isMac}, {type: "keyup"});
        assert.equal(calls.length, 6);
    });
}
