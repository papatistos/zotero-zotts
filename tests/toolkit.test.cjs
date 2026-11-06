const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const esbuild = require("esbuild");
const {root} = require("./helpers.cjs");
test("bundled BasicTool uses Console ES module when ChromeUtils.import is absent", () => {
    const code = esbuild.buildSync({stdin: {contents: 'import {BasicTool} from "zotero-plugin-toolkit"; globalThis.tool = new BasicTool();', resolveDir: root}, bundle: true, write: false, platform: "browser", format: "iife"}).outputFiles[0].text;
    const calls = [];
    const context = {ChromeUtils: {importESModule(uri) {calls.push(uri); return {ConsoleAPI: class {}};}}};
    vm.runInNewContext(code, context);
    assert.ok(context.tool);
    assert.ok(calls.includes("resource://gre/modules/Console.sys.mjs"));
    assert.ok(context.tool._console);
});

test("bundled BasicTool prefers ES modules when Zotero exposes a legacy import shim", () => {
    const code = esbuild.buildSync({stdin: {contents: 'import {BasicTool} from "zotero-plugin-toolkit"; globalThis.tool = new BasicTool();', resolveDir: root}, bundle: true, write: false, platform: "browser", format: "iife"}).outputFiles[0].text;
    const calls = [];
    let legacyCalls = 0;
    const context = {ChromeUtils: {
        import(uri) {legacyCalls++; throw new Error("Deprecated ChromeUtils.import: " + uri);},
        importESModule(uri) {calls.push(uri); return {ConsoleAPI: class {}};},
    }};
    vm.runInNewContext(code, context);
    assert.equal(legacyCalls, 0, "Zotero's compatibility shim must never be called");
    assert.ok(calls.includes("resource://gre/modules/Console.sys.mjs"));
    assert.ok(context.tool._console);
});
