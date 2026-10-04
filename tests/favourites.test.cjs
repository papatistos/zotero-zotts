const test = require("node:test");
const assert = require("node:assert/strict");
const {load, prefs} = require("./helpers.cjs");
for (const [engine, settings] of Object.entries({
    azure: {voice: "en-US-JennyNeural", language: "en-US", volume: 0, rate: 120, minSegmentSize: 16},
    openai: {voice: "alloy", model: "tts-1-hd", volume: 0, rate: 130},
    local: {apiUrl: "http://localhost:8880", voice: "bm_fable", model: "model", volume: 0, rate: 90},
    kokoro: {apiUrl: "http://kokoro.test", voice: "af_heart", model: "kokoro", language: "en", volume: 0, rate: 110},
    webSpeech: {voice: "Test", pitch: 100, volume: 0, rate: 100},
})) {
    test(engine + " favourites preserve settings, distinguish voices and restore settings", () => {
        const values = {"ttsEngine.current": engine, favouritesList: "[]"};
        for (const [key, value] of Object.entries(settings)) values[engine + "." + key] = value;
        values[engine + ".apiKey"] = "test-only-secret";
        values[engine + ".subscriptionKey"] = "test-only-secret";
        const fav = load("src/modules/favourites.ts", {"./utils/prefs": prefs(values), "./utils/notify": {notifyGeneric() {}}, "./utils/locale": {getString: k => k}}, {addon: {data: {tts: {engines: {}}}}, ztoolkit: {log() {}}});
        fav.addFavourite();
        const first = JSON.parse(values.favouritesList)[0];
        assert.deepEqual(first, {engine, ...settings});
        fav.addFavourite();
        assert.equal(JSON.parse(values.favouritesList).length, 1);
        values[engine + ".voice"] = "second-voice";
        fav.addFavourite();
        assert.equal(JSON.parse(values.favouritesList).length, 2);
        fav.cycleFavourites();
        assert.equal(values[engine + ".voice"], settings.voice);
        values[engine + ".rate"] = 55;
        fav.cycleFavourites();
        assert.equal(values[engine + ".rate"], settings.rate);
    });
}
