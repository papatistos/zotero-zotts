const test = require("node:test");
const assert = require("node:assert/strict");
const {load, prefs} = require("./helpers.cjs");
for (const initial of [0, undefined]) {
    test(initial === 0 ? "Web Speech retains saved zero preferences" : "Web Speech sets missing defaults", () => {
        const values = {"webSpeech.pitch": initial, "webSpeech.rate": initial, "webSpeech.volume": initial, "webSpeech.voice": "Test"};
        const engine = load("src/modules/tts/webSpeech.ts", {"../utils/prefs": prefs(values), "../utils/wait": {}}, {});
        engine.setDefaultPrefs();
        assert.equal(values["webSpeech.pitch"], initial ?? 100);
        assert.equal(values["webSpeech.rate"], initial ?? 100);
        assert.equal(values["webSpeech.volume"], initial ?? 50);
    });
}
