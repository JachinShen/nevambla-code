import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const main = "/projects/example";
const linked = "/projects/example-ops with spaces";
const source = await readFile(new URL("../main.js", import.meta.url), "utf8");

async function menu({ machine = "ssh-ops", lock = "", listCode = 0, protection = [{ machine: "ssh-ops", root: main }] } = {}) {
  const records = [
    [`worktree ${main}`, "branch refs/heads/main"],
    [`worktree ${linked}`, "branch refs/heads/ops", ...(lock ? [lock] : [])],
  ].map((record) => record.join("\0"));
  const calls = [];
  const host = {
    checking: () => false,
    closeOverlay: () => {},
    openOverlay: (overlay) => calls.push(overlay.props.action),
    panes: () => [{ tab: "tab", cwd: "/root" }],
    spaces: () => [{ id: "ops", machine, folder: linked, tabs: [{ id: "tab" }] }],
    props: () => ({ space: "ops", protected_worktree_repos: protection }),
    run: (command, args) => calls.push([command, args]),
    theme: () => ({}),
    exec: async (_program, args, { cwd }) => {
      if (cwd === "/root") return { code: 128, stderr: "fatal: not a git repository" };
      assert.equal(cwd, linked);
      return args[0] === "rev-parse" ? { code: 0, stdout: linked + "\n" }
        : { code: listCode, stdout: records.join("\0\0") + "\0\0" };
    },
  };
  const modules = {
    "gpui-kit": { View: class {}, div: () => {} },
    "gpui-base": { v_flex: () => {} },
    herdr: host,
  };
  const mod = new vm.SourceTextModule(source);
  await mod.link((name) => new vm.SyntheticModule(Object.keys(modules[name]), function () {
    for (const [key, value] of Object.entries(modules[name])) this.setExport(key, value);
  }));
  await mod.evaluate();
  const view = new mod.namespace.default();
  let pending;
  const cx = { notify() {}, focus_handle: () => ({ focus() {} }), spawn(fn) { pending = fn(cx); } };
  view.init(null, cx);
  await pending;
  const item = (label) => view.items().find((item) => item.label === label);
  return { item, calls, view };
}

test("locked worktrees have no removal action and use the configured folder when the agent is in its home", async () => {
  for (const lock of ["locked", "locked Archive before removal"]) {
    const { item, calls, view } = await menu({ lock });
    assert.equal(item("Remove worktree"), undefined);
    view.choose(item("Worktree locked"));
    assert.deepEqual(calls, []);
    view.choose(item("Open worktree"));
    assert.deepEqual(calls, ["open"]);
    view.choose(item("New terminal in worktree"));
    assert.deepEqual(calls[1], ["tab.new", { space: "ops", folder: linked }]);
  }
});

test("managed worktrees require archiving even if unlocked and Git failures hide removal", async () => {
  const managed = await menu();
  assert.equal(managed.item("Remove worktree"), undefined);
  assert.equal(managed.item("Archive required before removal").action, undefined);
  const unavailable = await menu({ listCode: 1 });
  assert.equal(unavailable.item("Remove worktree"), undefined);
  assert.ok(unavailable.item("Worktree status unavailable"));
  const invalid = await menu({ protection: [{ machine: "ssh-ops" }] });
  assert.equal(invalid.item("Remove worktree"), undefined);
  assert.ok(invalid.item("Invalid worktree protection settings"));
});

test("an unlocked worktree outside the configured repositories retains the removal dialog", async () => {
  const { item, calls, view } = await menu({ machine: "unrelated" });
  view.choose(item("Remove worktree"));
  assert.deepEqual(calls, ["remove"]);
});
