const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {load, prefs, root} = require("./helpers.cjs");
function setup(values = {}) {
    return load("src/modules/prefsWindow.ts", {
        "../../package.json": require("../package.json"), "./utils/locale": {getString: () => "invalid"},
        "./utils/prefs": prefs(values), "./favourites": {},
    }, {setTimeout: fn => fn()});
}
test("malformed regex is rejected and never reaches preprocessing", () => {
    const result = setup().validateSubs('/[/:"x"\n"good":"ok"');
    assert.equal(result.valid, false);
    assert.deepEqual(Array.from(result.errors), [1]);
    assert.equal(result.subs.length, 1);
    assert.equal(result.subs[0][0], "good");
});
test("leading blank lines do not discard following substitutions", () => {
    const result = setup().validateSubs('\n\n# comment\n/foo/:"bar"\n"a":"b"');
    assert.equal(result.valid, true);
    assert.equal(result.subs.length, 2);
    assert.equal(result.subs[0][0], "foo");
});
test("textarea input persists pasted valid text but keeps last valid prefs for invalid text", () => {
    const xhtml = fs.readFileSync(path.join(root, "addon/chrome/content/preferences.xhtml"), "utf8");
    const textarea = xhtml.match(/<html:textarea[\s\S]*?advanced-subs-input[\s\S]*?<\/html:textarea>/)?.[0];
    assert.ok(textarea && textarea.includes("oninput="));
    assert.ok(!textarea.includes("onkeypress="));
    const values = {"subs.customSubs": '"old":"rule"'};
    const input = {value: '\n"pasted":"text"'};
    const warning = {style: {}};
    const doc = {getElementById: id => id.endsWith("warning") ? warning : input};
    const module = setup(values);
    module.prefsRefreshHook("subs-text", doc);
    assert.equal(values["subs.customSubs"], input.value);
    assert.equal(warning.style.visibility, "hidden");
    input.value = '/[/:"bad"';
    module.prefsRefreshHook("subs-text", doc);
    assert.equal(values["subs.customSubs"], '\n"pasted":"text"');
    assert.equal(warning.style.visibility, "visible");
});
