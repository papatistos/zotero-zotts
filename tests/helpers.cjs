const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
function load(relative, imports = {}, globals = {}, expose = "") {
    const source = fs.readFileSync(path.join(root, relative), "utf8") + "\n" + expose;
    const code = ts.transpileModule(source, {compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    }}).outputText;
    const module = {exports: {}};
    vm.runInNewContext(code, {module, exports: module.exports,
        require(id) {
            if (!(id in imports)) throw new Error("Unexpected import " + id);
            return imports[id];
        }, ...globals}, {filename: relative});
    return module.exports;
}
function prefs(values) {
    return {getPref: key => values[key], setPref: (key, value) => {values[key] = value;}};
}
module.exports = {load, prefs, root};
