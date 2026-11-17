import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";
import test from "node:test";

const run = promisify(execFile);
const plain = value => JSON.parse(JSON.stringify(value));
async function harness() {
  const calls = [], context = vm.createContext({});
  const host = {
    exec: async (cmd, args, options) => {
      calls.push({ cmd, args, options });
      try { return { code: 0, ...await run(cmd, args, { cwd: options.cwd }) }; }
      catch (e) { return { code: e.code, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message }; }
    },
    readTextFile: filename => readFile(filename, "utf8"), settings: () => ({}),
  };
  const ui = { div() {}, h_flex() {}, v_flex() {}, v_virtual_list() {}, Scrollbar: {} };
  const module = new vm.SourceTextModule(await readFile(new URL("../diff.js", import.meta.url), "utf8"), { context });
  await module.link(name => {
    const exports = name === "herdr" ? host : ui;
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, typeof value === "function" ? (...args) => exports[key](...args) : value);
    }, { context });
  });
  await module.evaluate();
  return { ...module.namespace, calls, host };
}
async function repository(t) {
  const root = await mkdtemp(path.join(tmpdir(), "herdr-diff-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await run("git", ["init", "-q", root]);
  return root;
}
const file = (root, relativePath, on = null) => ({ root, relativePath, sourcePath: `${root}/${relativePath}`, on });
async function commit(root) {
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], { cwd: root });
}

test("Reads staged plus unstaged changes, deletion, and a new file without requiring HEAD", async t => {
  const root = await repository(t), { readDiff } = await harness();
  await writeFile(`${root}/new.txt`, "new\n");
  let result = await readDiff(file(root, "new.txt"));
  assert.equal(result.rows[1].kind, "+");
  assert.equal(result.rows[1].text, "new");
  await run("git", ["add", "new.txt"], { cwd: root });
  assert.equal((await readDiff(file(root, "new.txt"))).rows[1].text, "new");
  await commit(root);
  await writeFile(`${root}/new.txt`, "staged\n");
  await run("git", ["add", "new.txt"], { cwd: root });
  await writeFile(`${root}/new.txt`, "working\n");
  result = await readDiff(file(root, "new.txt"));
  assert.deepEqual(plain(result.rows.filter(row => ["+", "-"].includes(row.kind)).map(row => row.text)), ["new", "working"]);
  await unlink(`${root}/new.txt`);
  result = await readDiff(file(root, "new.txt"));
  assert.equal(result.rows[1].kind, "-");
  assert.equal(result.rows[1].text, "new");
});

test("Binary and truncated diffs are explicit, and a committed new file stops showing an addition", async t => {
  const root = await repository(t), { readDiff } = await harness();
  await writeFile(`${root}/binary`, Buffer.from([0, 1, 2]));
  assert.match((await readDiff(file(root, "binary"))).message, /Binary/);
  await writeFile(`${root}/large.txt`, "x\n".repeat(1600));
  let result = await readDiff(file(root, "large.txt"));
  assert.equal(result.limited, true);
  assert.equal(result.rows.length, 1500);
  await commit(root);
  result = await readDiff(file(root, "large.txt"));
  assert.equal(result.rows.length, 0);
  assert.equal(result.message, "No uncommitted changes");
});

test("SSH reads keep the file's captured machine and propagate read failures", async () => {
  const { readDiff, host, calls } = await harness();
  host.exec = async (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return { code: 0, stderr: "", stdout: args.includes("status") ? "?? file.txt\0" : "head" };
  };
  let seen;
  host.readTextFile = async (name, options) => { seen = [name, options]; throw new Error("SSH connection lost"); };
  await assert.rejects(readDiff(file("/remote/repo", "file.txt", "ssh-a")), /SSH connection lost/);
  assert.equal(calls[0].options.on, "ssh-a");
  assert.equal(calls[0].options.cwd, "/remote/repo");
  assert.deepEqual(plain(seen), ["/remote/repo/file.txt", { on: "ssh-a" }]);
});

test("A failed refresh clears the old diff and exposes the error", async () => {
  const { GitDiff } = await harness();
  const view = new GitDiff(file("/folder-does-not-exist", "file.txt", "ssh-a"));
  view.rows = [{ text: "stale" }];
  const pending = [], cx = { spawn(fn) { pending.push(fn(cx)); }, notify() {} };
  view.refresh(cx);
  await Promise.all(pending);
  assert.equal(view.rows.length, 0);
  assert.match(view.error, /Cannot load diff:.*(ENOENT|No such file)/);
});

test("Diff line numbers advance independently on each side", async () => {
  const { diffRows } = await harness();
  assert.deepEqual(plain(diffRows(["@@ -3,2 +3,2 @@", " same", "-old", "+new"])), [
    { kind: "@", text: "@@ -3,2 +3,2 @@" },
    { kind: " ", old: 3, next: 3, text: "same" },
    { kind: "-", old: 4, text: "old" },
    { kind: "+", next: 4, text: "new" },
  ]);
});
