// Run: node --experimental-vm-modules --test tests/explorer.test.mjs
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import vm from "node:vm";
import test from "node:test";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

function uiElement() {
  const target = { nodes: [], styles: {}, handlers: {} };
  const proxy = new Proxy(target, { get(obj, key) {
    if (key in obj) return obj[key];
    return (...args) => {
      if (key === "child") obj.nodes.push(args[0]);
      else if (key === "children") obj.nodes.push(...args[0]);
      else if (key === "when") { if (args[0]) args[1](proxy); }
      else if (key.startsWith("on_")) obj.handlers[key] = args[0];
      else obj.styles[key] = args[0];
      return proxy;
    };
  } });
  return proxy;
}

async function harness(cwd, machine = null) {
  const state = { cwd, machine, calls: [], pending: [], shared: {}, overlays: [] };
  state.exec = async (cmd, args, options) => {
    try { return { code: 0, ...await run(cmd, args, { cwd: options.cwd }) }; }
    catch (e) { return { code: e.code, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message }; }
  };
  const host = {
    spaces: () => [{ active: true, folder: state.cwd, machine: state.machine }],
    panes: () => [{ pane: "pane", cwd: state.cwd }], focused: () => ({ pane: "pane" }),
    shared: name => state.shared[name], setShared: (name, value) => { state.shared[name] = value; },
    layout: () => ({ id: "editor-2", hidden: true }), run() {}, checking: () => true,
    exec: (...args) => { state.calls.push(args); return state.exec(...args); },
    watchFolder: async () => { throw new Error("Watching is outside these regression tests"); },
    theme: () => ({}), openOverlay: value => state.overlays.push(value),
  };
  const ui = { View: class {}, div: uiElement, svg: uiElement, v_flex: uiElement, h_flex: uiElement,
    ScrollHandle: { new: () => ({ scroll_to_item() {} }) } };
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
  const view = new main.namespace.default();
  const cx = { notify() {}, timer: { every() {} }, spawn(fn) { state.pending.push(fn(cx)); } };
  view.init(null, cx);
  view.watch = () => {};
  state.drain = async () => { while (state.pending.length) await Promise.all(state.pending.splice(0)); };
  state.refresh = async () => { view.refresh(cx); await state.drain(); };
  state.expand = async folder => { view.toggle(folder, cx); await state.drain(); };
  return { state, view, cx };
}

async function fixture(t) {
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "herdr-ignored-")));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const repo = path.join(temporary, "repo");
  await run("git", ["init", "-q", repo]);
  const git = args => run("git", args, { cwd: repo });
  await writeFile(path.join(repo, ".gitignore"), "*.log\n!keep.log\ncache/\n");
  await mkdir(path.join(repo, "cache"));
  await writeFile(path.join(repo, "cache", "child.txt"), "ignored child\n");
  await mkdir(path.join(repo, "nested"));
  await writeFile(path.join(repo, "nested", ".gitignore"), "*.tmp\n!keep.tmp\n");
  for (const name of ["debug.log", "keep.log", "tracked.log", "normal.txt", "odd \n'$(touch BAD).log", "-option.log", "中文.log", "global.secret", "private.local", "nested/drop.tmp", "nested/keep.tmp"]) {
    await writeFile(path.join(repo, name), `${name}\n`);
  }
  await writeFile(path.join(temporary, "global.ignore"), "*.secret\n");
  await git(["config", "core.excludesFile", path.join(temporary, "global.ignore")]);
  await writeFile(path.join(repo, ".git", "info", "exclude"), "*.local\n");
  await git(["add", ".gitignore", "nested/.gitignore", "normal.txt"]);
  await git(["add", "-f", "tracked.log"]);
  return { repo, temporary, git };
}

const entry = (view, name, folder = "") => view.entries.get(folder)?.find(e => e.name === name);

test("Actual Git rules dim ignored entries, honor negations and preserve tracked files and literal names", async t => {
  const { repo } = await fixture(t);
  const { state, view } = await harness(repo);
  await state.refresh();
  assert.equal(view.error, null);
  assert.equal(view.folderErrors.size, 0);
  for (const name of ["debug.log", "cache", "global.secret", "private.local", "odd \n'$(touch BAD).log", "-option.log", "中文.log"]) {
    assert.equal(entry(view, name)?.ignored, true, name);
  }
  for (const name of ["keep.log", "tracked.log", "normal.txt", "nested"]) assert.equal(entry(view, name)?.ignored, false, name);
  assert.equal(entry(view, ".git"), undefined);
  assert.equal(entry(view, "BAD"), undefined);
  await state.expand("cache");
  assert.equal(entry(view, "child.txt", "cache")?.ignored, true);
  await state.expand("nested");
  assert.equal(entry(view, "drop.tmp", "nested")?.ignored, true);
  assert.equal(entry(view, "keep.tmp", "nested")?.ignored, false);
});

test("Ignored rows keep file opening, directory expansion and transfers, with dim labels and icons", async t => {
  const { repo } = await fixture(t);
  const { state, view, cx } = await harness(repo);
  await state.refresh();
  const tints = { dim: "#777777", foreground: "#ffffff", muted: "#aaaaaa", ansi2: "#00ff00" };
  const file = view.row({ e: entry(view, "debug.log"), path: "debug.log", depth: 0 }, tints, path.join(repo, "debug.log"));
  assert.equal(file.nodes[1].styles.text_color, tints.dim);
  assert.equal(file.nodes[2].styles.text_color, tints.dim);
  file.handlers.on_click({}, cx);
  assert.equal(state.shared["vsc.editor"].active, path.join(repo, "debug.log"));
  file.nodes[3].handlers.on_click({}, { stop_propagation() {} });
  assert.equal(state.overlays[0].props.source.path, path.join(repo, "debug.log"));
  const folder = view.row({ e: entry(view, "cache"), path: "cache", depth: 0 }, tints, null);
  assert.equal(folder.nodes[0].styles.text_color, tints.dim);
  assert.equal(folder.nodes[1].styles.text_color, tints.dim);
  folder.handlers.on_click({}, cx);
  await state.drain();
  assert.equal(entry(view, "child.txt", "cache").ignored, true);
});

test("Rules refresh after .gitignore changes and apply in Git worktrees", async t => {
  const { repo, temporary, git } = await fixture(t);
  const { state, view } = await harness(repo);
  await state.refresh();
  await writeFile(path.join(repo, ".gitignore"), "normal.txt\n");
  await state.refresh();
  assert.equal(entry(view, "debug.log").ignored, false);
  assert.equal(entry(view, "normal.txt").ignored, false); // Already tracked.
  await git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]);
  const worktree = path.join(temporary, "worktree");
  await git(["worktree", "add", "-q", "-b", "fixture-worktree", worktree]);
  await writeFile(path.join(worktree, "debug.log"), "worktree ignored\n");
  state.cwd = worktree;
  await state.refresh();
  assert.equal(view.folderErrors.size, 0);
  assert.equal(entry(view, "debug.log").ignored, true);
});

test("Browsing a plain folder remains valid, and expanding a repository discovers its rules", async t => {
  const { temporary } = await fixture(t);
  const { state, view } = await harness(temporary);
  await state.refresh();
  assert.equal(view.error, null);
  assert.equal(view.folderErrors.size, 0);
  assert.equal(entry(view, "repo").ignored, false);
  await state.expand("repo");
  assert.equal(entry(view, "debug.log", "repo").ignored, true);
});

test("Ignore checks cover multiple batches without interpreting path names as patterns", async t => {
  const { repo } = await fixture(t);
  await Promise.all(Array.from({ length: 260 }, (_, n) => writeFile(path.join(repo, `batch-${n}.log`), "ignored\n")));
  const { state, view } = await harness(repo);
  await state.refresh();
  assert.equal(view.folderErrors.size, 0);
  const ignored = view.entries.get("").filter(e => e.name.startsWith("batch-"));
  assert.equal(ignored.length, 260);
  assert(ignored.every(e => e.ignored));
  assert(state.calls.filter(([_cmd, args]) => args.includes("git-ignore")).length >= 3);
});

test("Git failures are visible, preserve browsing, and recover when the read succeeds", async t => {
  const { repo } = await fixture(t);
  const { state, view, cx } = await harness(repo);
  const realExec = state.exec;
  state.exec = async (cmd, args, options) => args.includes("git-ignore")
    ? { code: 128, stderr: "permission denied reading index", stdout: "" } : realExec(cmd, args, options);
  await state.refresh();
  assert(entry(view, "debug.log"));
  assert.match(view.folderErrors.get(""), /permission denied reading index/);
  const tree = view.render(cx);
  assert.match(tree.nodes.at(-1).nodes[0], /permission denied reading index/);
  state.exec = realExec;
  await state.refresh();
  assert.equal(view.folderErrors.size, 0);
  assert.equal(entry(view, "debug.log").ignored, true);
  state.exec = async (cmd, args, options) => args.includes("status")
    ? { code: 128, stderr: "Git status read failed", stdout: "" } : realExec(cmd, args, options);
  await state.refresh();
  assert.match(view.error, /Git status read failed/);
  assert.equal(Object.keys(view.marks).length, 0);
});

test("Remote reads and expansions retain the captured machine, and discard stale classification", async () => {
  const { state, view, cx } = await harness("/repo-a", "ssh-a");
  let release;
  state.exec = async (_cmd, args) => {
    if (args.includes("git-ignore")) return new Promise(resolve => { release = resolve; });
    if (args.includes("status")) return { code: 0, stdout: "", stderr: "" };
    if (args[1]?.includes("rev-parse")) return { code: 0, stdout: "/repo-a\n", stderr: "" };
    return { code: 0, stdout: "f\0old.log\0d\0cache\0", stderr: "" };
  };
  view.refresh(cx);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert(state.calls.every(([_cmd, _args, options]) => options.on === "ssh-a" && options.cwd !== "/repo-b"));
  state.cwd = "/repo-b"; state.machine = "ssh-b";
  state.exec = async (_cmd, args) => ({ code: 0, stderr: "", stdout: args.includes("git-ignore") ? "./new.log\0"
    : args.includes("status") ? "" : args[1]?.includes("rev-parse") ? "/repo-b\n" : "f\0new.log\0d\0cache\0" });
  view.refresh(cx);
  release({ code: 0, stdout: "./old.log\0", stderr: "" });
  await state.drain();
  assert.equal(entry(view, "old.log"), undefined);
  assert.equal(entry(view, "new.log").ignored, true);
  const before = state.calls.length;
  await state.expand("cache");
  assert(state.calls.slice(before).every(([_cmd, _args, options]) => options.on === "ssh-b" && (options.cwd === "/repo-b/cache" || !options.cwd)));
});

test("A missing Git executable is an explicit error rather than an unignored tree", async t => {
  const { repo } = await fixture(t);
  const { state, view } = await harness(repo);
  const realExec = state.exec;
  state.exec = (cmd, args, options) => args[0] === "-c" && args[1].includes("LC_ALL=C git")
    ? Promise.resolve({ code: 127, stdout: "", stderr: "sh: git: command not found" }) : realExec(cmd, args, options);
  await state.refresh();
  assert(entry(view, "debug.log"));
  assert.match(view.folderErrors.get(""), /git: command not found/);
  assert.match(view.error, /git: command not found/);
});

test("Git discovery stopping at a filesystem boundary is a normal non-repository folder", async () => {
  const { state, view } = await harness("/gpfs/plain", "ssh-a");
  state.exec = async (_cmd, args) => args[0] === "-c" && args[1].includes("LC_ALL=C git")
    ? { code: 128, stdout: "", stderr: "fatal: not a git repository (or any parent up to mount point /gpfs)\nStopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).\n" }
    : { code: 0, stdout: "f\0ordinary.txt\0", stderr: "" };
  await state.refresh();
  assert.equal(view.error, null);
  assert.equal(view.folderErrors.size, 0);
  assert.equal(entry(view, "ordinary.txt").ignored, false);
});
