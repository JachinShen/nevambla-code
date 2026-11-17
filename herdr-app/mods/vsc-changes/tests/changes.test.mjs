// Run: node --experimental-vm-modules --test tests/changes.test.mjs
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import vm from "node:vm";
import test from "node:test";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const plain = value => JSON.parse(JSON.stringify(value));

async function harness(cwd = "/home", machine = null) {
  const state = { cwd, machine, jump: null, focus: { pane: "pane" }, calls: [], pending: [], shared: {}, actions: [], layout: { id: "editor-2", hidden: true } };
  state.exec = async (cmd, args, options) => {
    try {
      const result = await run(cmd, args, { cwd: options.cwd });
      return { code: 0, ...result };
    } catch (error) { return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message }; }
  };
  class InputState {
    static new() { return new InputState(); }
    on() {}
    value() { return this.text ?? ""; }
    set_value(value) { this.text = value; }
  }
  const host = {
    spaces: () => [{ active: true, folder: state.cwd, machine: state.machine }],
    panes: () => [{ pane: "pane", cwd: state.cwd }], focused: () => state.focus,
    shared: name => name === "vsc.explorer.jump" ? state.jump : state.shared[name],
    setShared: (name, value) => { state.shared[name] = value; },
    layout: () => state.layout,
    run: (name, args) => state.actions.push([name, args]),
    checking: () => true,
    exec: async (...args) => { state.calls.push(args); return state.exec(...args); },
    readTextFile: filename => readFile(filename, "utf8"),
    watchFolder: async () => { throw new Error("Filesystem watching is outside these regression tests"); },
    theme: () => ({}), settings: () => ({}),
  };
  const ui = { View: class {}, div() {}, v_flex() {}, h_flex() {}, InputState, Input: {}, Scrollbar: {}, v_virtual_list() {} };
  const context = vm.createContext({ console });
  const cache = new Map();
  async function load(filename) {
    if (cache.has(filename)) return cache.get(filename);
    const module = new vm.SourceTextModule(await readFile(filename, "utf8"), { context, identifier: filename });
    cache.set(filename, module);
    await module.link(async (specifier, parent) => {
      if (specifier.startsWith(".")) return load(path.resolve(path.dirname(parent.identifier), specifier));
      const exports = specifier === "herdr" ? host : ui;
      return new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
      }, { context });
    });
    return module;
  }
  const main = await load(path.join(root, "main.js"));
  await main.evaluate();
  const navigation = cache.get(path.join(root, "navigation.js")).namespace;
  const view = new main.namespace.default();
  const cx = { focus_handle() {}, notify() {}, timer: { every() {} }, spawn(fn) { state.pending.push(fn(cx)); } };
  view.init(null, cx);
  view.watch = () => {}; // No persistent watcher is needed to verify directory selection.
  state.refresh = async () => {
    view.refresh(cx);
    while (state.pending.length) await Promise.all(state.pending.splice(0));
  };
  state.pin = folder => { state.jump = { source: JSON.stringify({ cwd: state.cwd, on: state.machine }), folder }; };
  return { state, view, navigation, cx };
}

test("Git follows the same pinned Explorer directory and releases it when the terminal moves", async () => {
  const { state, navigation } = await harness();
  state.pin("/home/nixos-config");
  assert.deepEqual(plain(navigation.location()), { cwd: "/home/nixos-config", on: null });
  state.cwd = "/other";
  assert.deepEqual(plain(navigation.location()), { cwd: "/other", on: null });
  state.jump = null;
  assert.deepEqual(plain(navigation.location()), { cwd: "/other", on: null });
});

test("Local navigation does not leak to SSH; a remote mod focus retains its machine", async () => {
  const { state, navigation } = await harness();
  state.pin("/home/nixos-config");
  state.machine = "remote";
  state.cwd = "/root";
  state.focus = { pane: null, terminal: null };
  assert.deepEqual(plain(navigation.location()), { cwd: "/root", on: "remote" });
  state.pin("/root/repo");
  assert.deepEqual(plain(navigation.location()), { cwd: "/root/repo", on: "remote" });
  state.focus = { pane: null, terminal: "t7", cwd: "/local" };
  assert.deepEqual(plain(navigation.location()), { cwd: "/local", on: null });
});

test("Reproduces Home not being Git, then loads a real repository selected in Explorer", async t => {
  const folder = await mkdtemp(path.join(tmpdir(), "herdr-git-context-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const repo = path.join(folder, "repo");
  await run("git", ["init", "-q", repo]);
  await writeFile(path.join(repo, "example.txt"), "new file\n");
  const { state, view } = await harness(folder);
  await state.refresh();
  assert.equal(view.root, null);
  assert.match(view.error, /not a git repository/);
  state.pin(repo);
  await state.refresh();
  assert.equal(view.root, await realpath(repo));
  assert.equal(view.error, null);
  assert.equal(view.files[0].path, "example.txt");
  assert.equal(state.shared["vsc.editor"], undefined); // Listing never opens a diff by itself.
  state.jump = null;
  await state.refresh();
  assert.equal(view.root, null);
  assert.equal(view.files.length, 0);
});

test("Remote Git commands use the Explorer path and the captured SSH machine", async () => {
  const { state, view } = await harness("/root", "remote");
  state.focus = { pane: null, terminal: null };
  state.pin("/root/repo");
  state.exec = async (_cmd, args) => ({ code: 0, stderr: "", stdout: args.includes("--show-toplevel") ? "/root/repo\n" : args.includes("--verify") ? "head\n" : "" });
  await state.refresh();
  assert.equal(view.root, "/root/repo");
  assert.equal(view.on, "remote");
  assert(state.calls.length > 1);
  assert(state.calls.every(([_cmd, _args, options]) => options.on === "remote" && options.cwd === "/root/repo"));
});

test("Failed Git reads show their actual error and clear stale files", async () => {
  const { state, view } = await harness();
  state.pin("/repo");
  state.exec = async (_cmd, args) => ({ code: 0, stderr: "", stdout: args.includes("--show-toplevel") ? "/repo\n" : "" });
  await state.refresh();
  view.files = [{ path: "stale.txt" }];
  state.exec = async (_cmd, args) => args.includes("status")
    ? { code: 128, stderr: "permission denied reading index", stdout: "" }
    : { code: 0, stderr: "", stdout: "/repo\n" };
  await state.refresh();
  assert.equal(view.root, null);
  assert.equal(view.files.length, 0);
  assert.match(view.error, /permission denied reading index/);
});

test("Changing Explorer during a pending read discards the old result and blocks stale commits", async () => {
  const { state, view, cx } = await harness();
  state.pin("/repo-a");
  let release;
  state.exec = () => new Promise(resolve => { release = resolve; });
  view.refresh(cx);
  state.pin("/repo-b");
  release({ code: 0, stdout: "/repo-a\n", stderr: "" });
  await Promise.all(state.pending.splice(0));
  assert.equal(view.root, null);
  view.root = "/repo-a";
  view.message = "should not commit";
  const before = state.calls.length;
  view.commit(cx);
  assert.equal(state.calls.length, before);
  state.exec = async (_cmd, args) => ({ code: 0, stderr: "", stdout: args.includes("--show-toplevel") ? "/repo-b\n" : "" });
  await state.refresh();
  assert.equal(view.root, "/repo-b");
});


test("Clicking a change opens a separate main editor diff and preserves editable tabs", async () => {
  const { state, view, cx } = await harness("/repo", "ssh-a");
  state.exec = async (_cmd, args) => ({ code: 0, stderr: "", stdout: args.includes("--show-toplevel") ? "/repo\n" : args.includes("status") ? " M file.txt\0" : "" });
  await state.refresh();
  state.shared["vsc.editor"] = { files: [{ path: "/repo/file.txt", on: "ssh-a" }], active: "/repo/file.txt" };
  view.pick("file.txt", cx);
  const editor = state.shared["vsc.editor"], file = editor.files[1];
  assert.equal(editor.files[0].path, "/repo/file.txt");
  assert.equal(file.kind, "diff");
  assert.equal(file.on, "ssh-a");
  assert.equal(file.sourcePath, "/repo/file.txt");
  assert.equal(editor.active, file.path);
  assert.notEqual(file.path, "/repo/file.txt");
  assert.deepEqual(plain(state.actions.at(-1)), ["layout.show", { id: "editor" }]);
  view.pick("file.txt", cx);
  assert.equal(state.shared["vsc.editor"].files.length, 2);
  assert.notEqual(state.shared["vsc.editor"].files[1].revision, file.revision);
  state.machine = "ssh-b";
  await state.refresh();
  view.pick("file.txt", cx);
  assert.equal(state.shared["vsc.editor"].files.length, 3);
  assert.notEqual(state.shared["vsc.editor"].active, file.path);
});

test("Diff opens in a visible second group, and rejects a stale directory click", async () => {
  const { state, view, cx } = await harness("/repo");
  state.exec = async (_cmd, args) => ({ code: 0, stderr: "", stdout: args.includes("--show-toplevel") ? "/repo\n" : args.includes("status") ? " D gone.txt\0" : "" });
  await state.refresh();
  state.layout.hidden = false;
  state.shared["vsc.group"] = 2;
  view.pick("gone.txt", cx);
  assert.equal(state.shared["vsc.editor.2"].files[0].relativePath, "gone.txt");
  assert.equal(state.shared["vsc.editor"], undefined);
  const before = state.shared["vsc.editor.2"];
  state.pin("/other");
  view.pick("gone.txt", cx);
  assert.equal(state.shared["vsc.editor.2"], before);
});
