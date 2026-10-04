const test = require("node:test");
const assert = require("node:assert/strict");
const {load, prefs} = require("./helpers.cjs");
test("preprocessing collapses repeated whitespace without changing literal s characters", () => {
    const module = load("src/modules/utils/text.ts", {"../prefsWindow": {validateSubs: () => ({subs: []})}, "./prefs": prefs({}), "./locale": {}});
    assert.equal(module.preprocessText("A   B\n\nC\t\tD"), "A B\nC\tD");
    assert.equal(module.preprocessText("assess e\u0301"), "assess é");
});
