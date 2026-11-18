import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const plain = value => JSON.parse(JSON.stringify(value));
const file = (path, on = null) => ({ path, root: "/repo", on });
const tabs = (...files) => ({ files, active: files.at(-1)?.path ?? null });
function element(kind = "div") {
  const data = { kind, nodes: [], styles: {}, handlers: {} };
  const proxy = new Proxy(data, { get(target, key) {
    if (key in target) return target[key];
    return (...args) => {
      if (key === "children") target.nodes.push(...args[0]);
      else if (key === "child" || key === "content" || key === "trigger") target.nodes.push(args[0]);
      else if (key === "when") { if (args[0]) args[1](proxy); }
      else if (key.startsWith("on_")) target.handlers[key] = args.at(-1);
      else target.styles[key] = args[0];
      return proxy;
    };
  } });
  return proxy;
}
const all = node => node && typeof node === "object" ? [node, ...(node.nodes ?? []).flatMap(all)] : [];
const byId = (node, id) => all(node).find(item => item.styles.id === id);

async function harness(saved = {}) {
  const state = { space: "alpha", machine: null, folder: "/repo", saved, actions: [], pending: [], writes: [], reads: [] };
  const second = { id: "editor-2", hidden: true };
  const context = vm.createContext({}), modules = new Map();
  const ui = {
    View: class {}, div: element, svg: () => element("svg"), image: () => element("image"),
    h_flex: element, v_flex: element, v_virtual_list: element, TextView: {}, Editor: {}, Scrollbar: {},
    Popover: { new: () => element("popover") }, ScrollHandle: { new: () => ({ scroll_to_item() {} }) },
    EditorState: { new: options => ({ value: () => options.value, on() {}, release() {} }) },
  };
  const host = {
    spaces: () => state.space ? [{ id: state.space, active: true, machine: state.machine, folder: state.folder, tabs: [] }] : [],
    shared: key => state.saved[key], setShared: (key, value) => { state.saved[key] = value; },
    layout: () => ({ id: "work", children: [second] }), props: () => ({}),
    run: (name, args) => {
      state.actions.push([name, plain(args)]);
      if (args.id === second.id && ["layout.show", "layout.hide"].includes(name)) second.hidden = name === "layout.hide";
    },
    readTextFile: async (path, options) => {
      state.reads.push([path, options]);
      if (state.readError) throw new Error(state.readError);
      return "module top; endmodule";
    },
    writeTextFile: async (...args) => state.writes.push(args),
    nextCommand: () => new Promise(() => {}), settings: () => ({}), exec() {}, appHome: () => "/app", theme: () => ({}),
  };
  async function load(url) {
    if (modules.has(url)) return modules.get(url);
    const promise = (async () => {
      const module = new vm.SourceTextModule(await readFile(new URL(url), "utf8"), { context, identifier: url });
      await module.link((name, parent) => {
        if (name.startsWith(".")) return load(new URL(name, parent.identifier).href);
        const exports = name === "herdr" ? host : ui;
        return new vm.SyntheticModule(Object.keys(exports), function () {
          for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
        }, { context });
      });
      return module;
    })();
    modules.set(url, promise);
    return promise;
  }
  const main = await load(new URL("../main.js", import.meta.url).href);
  await main.evaluate();
  const session = (await load(new URL("../editor-state.js", import.meta.url).href)).namespace;
  const cx = { notify() {}, stop_propagation() {}, spawn(fn) { state.pending.push(fn(cx)); } };
  function view(group = 1) {
    const editor = new main.namespace.default();
    editor.group = group; editor.docs = new Map(); editor.docsBySpace = new Map();
    editor.tabScroll = ui.ScrollHandle.new(); editor.menuHandle = {}; editor.wrap = false;
    return editor;
  }
  return { state, second, session, view, cx, settle: async () => { await Promise.all(state.pending.splice(0)); } };
}

test("Global tabs migrate once into one Space, preserving both groups and their active files", async () => {
  const legacy = tabs(file("/repo/a.v", "chip"));
  const saved = { "vsc.editor": legacy, "vsc.editor.2": tabs(file("/repo/b.nix")), "vsc.group": 2 };
  const { state, session } = await harness(saved);
  assert.deepEqual(plain(session.readEditor(1)), legacy);
  assert.equal(session.readEditor(2).active, "/repo/b.nix");
  assert.equal(session.activeGroup(), 2);
  assert.strictEqual(saved["vsc.editor"], legacy);
  state.space = "beta";
  assert.deepEqual(plain(session.readEditor(1)), tabs());
  assert.deepEqual(plain(session.readEditor(2)), tabs());
  assert.equal(session.activeGroup(), 1);
  session.writeEditor(tabs(file("/repo/a.v", "other")), 1);
  state.space = "alpha";
  assert.equal(session.readEditor(1).files[0].on, "chip");
  assert.equal(saved["vsc.editor.migrated"], "alpha");
});

test("Each Space restores its tabs, selection and split after recreating editor views", async () => {
  const { state, session, view, second } = await harness();
  session.writeEditor(tabs(file("/repo/a.v"), file("/repo/b.v")), 1);
  session.writeEditor(tabs(file("/repo/right.v")), 2);
  session.setActiveGroup(2);
  const editor = view(); editor.state();
  assert.equal(second.hidden, false);
  state.space = "beta"; editor.state();
  assert.equal(second.hidden, true);
  session.writeEditor(tabs(file("/repo/beta.nix")), 1);
  const restarted = await harness(plain(state.saved));
  assert.equal(restarted.session.readEditor(1).active, "/repo/b.v");
  restarted.view().state();
  assert.equal(restarted.second.hidden, false);
  assert.equal(restarted.session.activeGroup(), 2);
  restarted.state.space = "beta";
  assert.equal(restarted.session.readEditor(1).active, "/repo/beta.nix");
});

test("Switching Spaces retains separate unsaved buffers for identical file paths", async () => {
  const { state, session, view } = await harness();
  session.writeEditor(tabs(file("/repo/top.v", "chip-a")));
  const editor = view(); editor.state();
  const alpha = { dirty: true, code: { value: () => "alpha unsaved" } };
  editor.docs.set("/repo/top.v", alpha);
  state.space = "beta"; state.machine = "chip-b";
  assert.equal(editor.state().files.length, 0);
  assert.equal(editor.docs.size, 0);
  session.writeEditor(tabs(file("/repo/top.v", "chip-b")));
  const beta = { dirty: true, code: { value: () => "beta unsaved" } };
  editor.docs.set("/repo/top.v", beta);
  state.space = "alpha";
  assert.equal(editor.state().files[0].on, "chip-a");
  assert.strictEqual(editor.docs.get("/repo/top.v"), alpha);
  state.space = "beta"; editor.state();
  assert.strictEqual(editor.docs.get("/repo/top.v"), beta);
  assert.equal(state.writes.length, 0);
});

test("Right-click Close Others keeps the clicked tab and affects only its Space and editor group", async () => {
  const { state, session, view, cx } = await harness();
  session.writeEditor(tabs(file("/repo/keep.v"), file("/repo/close.md")), 1);
  session.writeEditor(tabs(file("/repo/right.v")), 2);
  session.writeEditor(tabs(file("/repo/other.v")), 1, "beta");
  const editor = view(); editor.state();
  const tab = editor.tab(file("/repo/keep.v"), false, {});
  assert.equal(tab.styles.mouse_button, "right");
  tab.handlers.on_open_change(true, cx);
  assert.equal(editor.tabMenu, "/repo/keep.v");
  byId(tab, "file-action-1").handlers.on_click({}, cx);
  assert.deepEqual(plain(session.readEditor(1)), tabs(file("/repo/keep.v")));
  assert.equal(session.readEditor(2).active, "/repo/right.v");
  assert.equal(session.readEditor(1, "beta").active, "/repo/other.v");
  assert.equal(editor.tabMenu, null);
  assert.equal(state.writes.length, 0);
});

test("Closing other tabs preserves unsaved edits visibly and releases closed notebook resources", async () => {
  const { session, view, cx } = await harness();
  const keep = file("/repo/keep.v"), dirty = file("/repo/dirty.v"), book = file("/repo/run.ipynb");
  session.writeEditor(tabs(keep, dirty, book));
  const editor = view(); editor.state();
  editor.docs.set(keep.path, {}); editor.docs.set(dirty.path, { dirty: true });
  const released = [];
  editor.docs.set(book.path, { nb: { release: () => released.push("release"), shutdown: () => released.push("shutdown") } });
  editor.closeOthers(keep.path);
  assert.deepEqual(plain(session.readEditor().files), [keep, dirty]);
  assert.equal(session.readEditor().active, keep.path);
  assert.match(editor.notice, /1 unsaved tab/);
  editor.sync(editor.state(), cx);
  assert.deepEqual(released, ["release", "shutdown"]);
  editor.closeFile(dirty.path);
  assert.ok(session.readEditor().files.some(item => item.path === dirty.path));
});

test("An open context menu cannot close matching tabs in a newly selected Space", async () => {
  const { state, session, view, cx } = await harness();
  const files = tabs(file("/repo/a.v"), file("/repo/b.v"));
  session.writeEditor(files); session.writeEditor(files, 1, "beta");
  const editor = view(); editor.state();
  const menu = editor.tab(files.files[0], false, {});
  state.space = "beta";
  byId(menu, "file-action-1").handlers.on_click({}, cx);
  assert.deepEqual(plain(session.readEditor()), files);
  assert.deepEqual(plain(session.readEditor(1, "alpha")), files);
});

test("Restoring many tabs reads only the selected file, and read failures retain their actual cause", async () => {
  const { state, session, view, cx, settle } = await harness();
  const files = Array.from({ length: 76 }, (_, i) => file(`/repo/file-${i}.v`, "chip"));
  session.writeEditor(tabs(...files));
  const editor = view(); editor.sync(editor.state(), cx); await settle();
  assert.equal(state.reads.length, 1);
  assert.equal(state.reads[0][0], files.at(-1).path);
  assert.equal(state.reads[0][1].on, "chip");
  state.readError = "herdr.exec: 16 execs are running already";
  session.writeEditor({ files, active: files[0].path });
  editor.sync(editor.state(), cx); await settle();
  assert.equal(state.reads.length, 2);
  assert.match(editor.docs.get(files[0].path).error, /16 execs are running already/);
  state.readError = null;
  editor.load(files[0], cx); await settle();
  assert.equal(editor.docs.get(files[0].path).error, null);
  assert.ok(editor.docs.get(files[0].path).code);
});

test("Corrupt saved tabs raise explicit errors without overwriting state or partially migrating", async () => {
  const saved = { "vsc.editor": tabs(file("/repo/good.v")), "vsc.editor.2": { files: "broken", active: null } };
  const before = plain(saved), { session } = await harness(saved);
  assert.throws(() => session.readEditor(), /Invalid saved editor tabs/);
  assert.deepEqual(saved, before);
  saved["vsc.editor.2"] = tabs();
  session.readEditor();
  saved[session.editorKey(1)] = { files: [file("/repo/a.v")], active: "/missing" };
  assert.throws(() => session.readEditor(), /Invalid saved editor tabs/);
});

test("All four mod copies share the same persisted editor contract; no active Space rejects writes", async () => {
  const canonical = await readFile(new URL("../editor-state.js", import.meta.url), "utf8");
  for (const mod of ["vsc-explorer", "vsc-changes", "vsc-jump"]) {
    assert.equal(await readFile(new URL(`../../${mod}/editor-state.js`, import.meta.url), "utf8"), canonical);
  }
  const { state, session } = await harness(); state.space = null;
  assert.deepEqual(plain(session.readEditor()), tabs());
  assert.throws(() => session.writeEditor(tabs(file("/repo/a.v"))), /No active Space/);
});
