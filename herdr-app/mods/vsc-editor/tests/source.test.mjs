import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const plain = value => JSON.parse(JSON.stringify(value));
const sourceText = rows => rows.map(row => row.map(piece => piece.text).join("")).join("\n");
const has = (rows, kind, text) => rows.flat().some(piece => piece.kind === kind && piece.text.includes(text));

async function harness() {
  const context = vm.createContext({}), modules = new Map(), reads = [], writes = [];
  const ui = {
    View: class {}, div() {}, svg() {}, image() {}, h_flex() {}, v_flex() {}, v_virtual_list() {},
    Editor: {}, TextView: {}, Scrollbar: {}, ScrollHandle: {},
    EditorState: { new(options) {
      return {
        options, text: options.value, value() { return this.text; },
        on(event, callback) { this[event] = callback; }, release() { this.released = true; },
      };
    } },
  };
  const host = {
    readTextFile: async (path, options) => { reads.push({ path, options }); return host.text; },
    writeTextFile: async (...args) => { writes.push(args); }, theme() {}, shared() {}, setShared() {},
    nextCommand() {}, settings() {}, layout() {}, exec() {}, run() {}, spaces() {}, props() {},
    appHome() {},
  };
  async function load(url) {
    if (modules.has(url)) return modules.get(url);
    const loading = (async () => {
      const module = new vm.SourceTextModule(await readFile(new URL(url), "utf8"), { context, identifier: url });
      await module.link((name, parent) => {
      if (name.startsWith(".")) return load(new URL(name, parent.identifier).href);
      const exports = name === "herdr" ? host : ui;
      return new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [key, value] of Object.entries(exports)) this.setExport(key,
          typeof value === "function" && key !== "View" ? (...args) => exports[key](...args) : value);
      }, { context });
      });
      return module;
    })();
    modules.set(url, loading);
    return loading;
  }
  const editor = await load(new URL("../main.js", import.meta.url).href);
  await editor.evaluate();
  const syntax = (await load(new URL("../source-syntax.js", import.meta.url).href)).namespace;
  const preview = (await load(new URL("../source-preview.js", import.meta.url).href)).namespace;
  const pending = [], cx = { notify() {}, spawn(fn) { pending.push(fn(cx)); } };
  const view = new editor.namespace.default();
  view.docs = new Map(); view.wrap = false;
  return { ...syntax, ...preview, view, host, reads, writes, cx,
    async settle() { await Promise.all(pending.splice(0)); } };
}

test("Recognizes Nix, RTL and circuit-netlist extensions without taking over other previews", async () => {
  const { sourceLanguage } = await harness();
  for (const [language, extensions] of Object.entries({
    nix: ["nix"], verilog: ["v", "vh", "sv", "svh", "verilog"],
    "verilog-ams": ["va", "vams"], vhdl: ["vhd", "vhdl"],
    spice: ["sp", "spi", "spice", "cir", "ckt", "cdl", "spf", "dspf", "net", "netlist"],
    spectre: ["scs", "spectre"],
  })) for (const extension of extensions) {
    assert.equal(sourceLanguage("/remote folder/chip." + extension.toUpperCase()).id, language);
  }
  for (const path of ["file.js", "file.md", "file.pdf", "file.ipynb", "file.lib", "file.spef", "file.constructor", "nix"])
    assert.equal(sourceLanguage(path), null);
});

test("Nix comments, paths, interpolation and indented strings preserve all source bytes", async () => {
  const { highlightSource } = await harness();
  const source = '# 配置\r\nlet\r\n\troot = ./rtl;\r\n\tscript = \'\'\r\n\t  echo \${if true then "你好" else "bye"}\r\n\t\'\';\r\nin import root\r\n';
  const rows = highlightSource(source, "nix");
  assert.equal(sourceText(rows), source);
  for (const [kind, text] of [["comment", "# 配置"], ["keyword", "let"], ["keyword", "if"],
    ["boolean", "true"], ["string", "echo "], ["string", "你好"], ["function", "import"]])
    assert.ok(has(rows, kind, text), kind + ": " + text);
  assert.deepEqual(plain(rows.at(-1)), []);
});

test("SystemVerilog handles RTL keywords, signed and unknown literals, and time units", async () => {
  const { highlightSource } = await harness();
  const source = String.fromCharCode(96) + 'timescale 1ns/1ps\nmodule top;\n logic [7:0] q;\n always_ff @(posedge clk) q <= 8\'shff;\n assign z = 4\'b10xz;\n initial begin q = \'0; #10ns $display("q=%h", q); end\nendmodule // RTL\n';
  const rows = highlightSource(source, "verilog");
  assert.equal(sourceText(rows), source);
  for (const [kind, text] of [["keyword", "module"], ["keyword", "logic"], ["keyword", "always_ff"],
    ["number", "8'shff"], ["number", "4'b10xz"], ["number", "'0"], ["number", "10ns"],
    ["string", "q=%h"], ["comment", "// RTL"]]) assert.ok(has(rows, kind, text), kind + ": " + text);
});

test("Verilog-A/AMS and VHDL get their own language rules", async () => {
  const { highlightSource } = await harness();
  const ams = "module resistor(p,n);\nelectrical p,n;\nanalog V(p,n) <+ 1k * I(p,n);\nendmodule\n";
  const a = highlightSource(ams, "verilog-ams");
  assert.equal(sourceText(a), ams);
  for (const word of ["module", "electrical", "analog"]) assert.ok(has(a, "keyword", word), word);
  assert.ok(has(a, "number", "1k"));
  const vhdl = 'ENTITY counter IS\nEND counter;\narchitecture rtl of counter is\nbegin\n q <= x"FF"; -- reset\nend rtl;\n';
  const b = highlightSource(vhdl, "vhdl");
  assert.equal(sourceText(b), vhdl);
  assert.ok(has(b, "keyword", "ENTITY"));
  assert.ok(has(b, "keyword", "architecture"));
  assert.ok(has(b, "comment", "-- reset"));
  assert.ok(has(b, "number", 'x"FF"'));
});

test("SPICE/CDL highlight directives, devices, engineering suffixes and circuit comments", async () => {
  const { highlightSource } = await harness();
  const source = "* inverter 网表\n.SUBCKT inv A Y VDD VSS\nM1 Y A VDD VDD pmos W=1.2u L=.18u $ pullup\n+ AD=2e-12\nRload Y VSS 10meg\n.MODEL pmos PMOS (VTO=-0.4)\n.param gain='2 * 3' ; expression\n.ENDS inv\n";
  const rows = highlightSource(source, "spice");
  assert.equal(sourceText(rows), source);
  for (const [kind, text] of [["comment", "* inverter"], ["comment", "$ pullup"], ["comment", "; expression"],
    ["keyword", ".SUBCKT"], ["keyword", ".MODEL"], ["keyword", ".ENDS"], ["function", "M1"],
    ["function", "Rload"], ["variable", "W"], ["number", "1.2u"], ["number", ".18u"],
    ["number", "2e-12"], ["number", "10meg"], ["string", "'2 * 3'"]])
    assert.ok(has(rows, kind, text), kind + ": " + text);
});

test("Spectre syntax includes unprefixed directives and slash comments", async () => {
  const { highlightSource } = await harness();
  const source = 'simulator lang=spectre\n// amplifier\ninclude "models.scs"\nsubckt amp (in out)\nparameters r=10k\nR0 (in out) resistor r=r\nends amp\ntran1 tran stop=10n\n';
  const rows = highlightSource(source, "spectre");
  assert.equal(sourceText(rows), source);
  for (const word of ["simulator", "include", "subckt", "parameters", "ends", "tran"])
    assert.ok(has(rows, "keyword", word), word);
  assert.ok(has(rows, "comment", "// amplifier"));
  assert.ok(has(rows, "number", "10n"));
});

test("Tab stops span token boundaries, while source and CRLF remain unchanged", async () => {
  const { displayRow, highlightSource } = await harness();
  const rows = highlightSource("let\t中文\t=\t1;\r\n", "nix"), before = sourceText(rows);
  assert.equal(displayRow(rows[0]).map(piece => piece.text).join(""), "let 中文    =   1;");
  assert.equal(sourceText(rows), before);
});

test("A missing grammar fails explicitly and clears stale preview content", async () => {
  const { SourcePreview, highlightSource } = await harness();
  assert.throws(() => highlightSource("module top;", "missing"), /No preview grammar registered/);
  const preview = new SourcePreview({ path: "/file.nix" }, { id: "missing", name: "Nix" }, {}, "");
  preview.rows = [[{ text: "stale", kind: "text" }]];
  preview.update("let x = 1;");
  assert.equal(preview.rows.length, 0);
  assert.match(preview.error, /Cannot highlight Nix:.*No preview grammar.*Use Edit/);
});

test("Blank-line-heavy files up to the existing read limit do not overflow width calculation", async () => {
  const { SourcePreview, sourceLanguage } = await harness();
  const preview = new SourcePreview({ path: "/large.cdl" }, sourceLanguage("/large.cdl"), {}, "");
  preview.update("\n".repeat(1024 * 1024));
  assert.equal(preview.error, null);
  assert.equal(preview.rows.length, 1024 * 1024 + 1);
  assert.ok(Number.isFinite(preview.width));
});

test("Local and SSH reads use the captured machine, and preview uses the unsaved edit buffer", async () => {
  for (const on of [null, "ssh-chip"]) {
    const { view, host, reads, writes, cx, settle } = await harness();
    host.text = "let n = 1;\r\nin n\r\n";
    const file = { path: "/project/chip.nix", root: "/project", on };
    view.load(file, cx);
    await settle();
    const doc = view.docs.get(file.path);
    assert.deepEqual(plain(reads), [{ path: file.path, options: { on } }]);
    assert.equal(doc.preview, true);
    assert.equal(doc.code.options.readonly, false);
    assert.equal(sourceText(doc.sourcePreview.rows), host.text.replace(/\r\n/g, "\n"));
    view.togglePreview(doc);
    assert.equal(doc.preview, false);
    doc.code.text = "let n = 2;\r\nin n\r\n";
    doc.code.change({}, cx);
    assert.equal(doc.dirty, true);
    view.togglePreview(doc);
    assert.equal(sourceText(doc.sourcePreview.rows), doc.code.value().replace(/\r\n/g, "\n"));
    assert.equal(doc.original, host.text);
    if (!on) {
      view.save(file.path, cx);
      await settle();
      assert.deepEqual(plain(writes), [[file.path, doc.code.value(), host.text]]);
      assert.equal(doc.dirty, false);
    }
  }
});

test("Wrap rebuilds preserve edits and preview mode; native and Markdown behavior is retained", async () => {
  const { view } = await harness();
  const doc = { file: { path: "/chip.sv" }, original: "module chip;\nendmodule\n" };
  view.build(doc, doc.original, false);
  view.togglePreview(doc);
  const old = doc.code, edited = "// unsaved\n" + doc.original;
  view.build(doc, edited, true);
  assert.equal(old.released, true);
  assert.equal(doc.preview, false);
  assert.equal(doc.code.value(), edited);
  view.togglePreview(doc);
  assert.equal(sourceText(doc.sourcePreview.rows), edited);
  const js = { file: { path: "/file.ts" } };
  view.build(js, "const x = 1;", false);
  assert.equal(js.sourcePreview, undefined);
  assert.equal(js.code.options.language, "js");
  view.togglePreview(js);
  assert.equal(js.preview, undefined);
  const md = { file: { path: "/README.md" } };
  view.build(md, "# heading", false);
  view.togglePreview(md);
  assert.equal(md.preview, true);
  assert.equal(md.sourcePreview, undefined);
});
