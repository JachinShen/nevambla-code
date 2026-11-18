import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

function element(kind = "div", asset = null) {
  const target = { kind, asset, nodes: [], styles: {}, handlers: {} };
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
const all = node => typeof node === "object" && node ? [node, ...(node.nodes ?? []).flatMap(all)] : [];
const byId = (node, id) => all(node).find(node => node.styles.id === id);
function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const result = find(child, id); if (result) return result; }
}
const plain = value => JSON.parse(JSON.stringify(value));
const agent = (address, status, options = {}) => ({
  address, status, pane: "pane-" + address, space: "workspace", space_name: "Chip",
  tab_name: "Review RTL", program: { name: "Codex", icon: "icons/codex.svg", tint: true },
  seq: 1, pinned: false, focused: false, ...options,
});

async function harness(list = []) {
  const tree = JSON.parse(await readFile(new URL("../../../layouts/nevambla-code.json", import.meta.url), "utf8"));
  const state = { list, tree, calls: [], shared: {}, order: null };
  const context = vm.createContext({});
  const host = {
    theme: () => new Proxy({}, { get: (_target, key) => String(key) }),
    agents: () => state.list, layout: () => state.tree,
    shared: key => state.shared[key], setAgentOrder: order => { state.order = plain(order); },
    run: (name, args) => {
      state.calls.push([name, plain(args)]);
      if (name === "layout.show" || name === "layout.hide") {
        const node = find(state.tree, args.id);
        assert.ok(node, "Target layout node must exist");
        node.hidden = name === "layout.hide";
      } else if (name === "layout.select") find(state.tree, args.stack).active = args.child;
    },
  };
  const ui = { View: class {}, div: () => element(), h_flex: () => element(), v_flex: () => element(),
    svg: asset => element("svg", asset), image: asset => element("image", asset) };
  async function load(relative) {
    const module = new vm.SourceTextModule(await readFile(new URL(relative, import.meta.url), "utf8"), { context });
    await module.link(name => {
      const exports = name === "herdr" ? host : ui;
      return new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
      }, { context });
    });
    await module.evaluate();
    return module.namespace;
  }
  const Main = (await load("../main.js")).default;
  const view = new Main();
  return { state, draw: () => view.render(), sections: await load("../../vsc-agents/sections.js") };
}

test("Agents opens below the current view and hides without losing panel size or selection", async () => {
  const { state, draw } = await harness([agent("t1", "working")]);
  const body = find(state.tree, "side-body"), panel = find(state.tree, "agents-list");
  body.active = "changes";
  const size = plain(panel.size), tabState = plain(find(state.tree, "work"));
  let tree = draw();
  assert.ok(byId(tree, "agent-rail"));
  assert.equal(tree.nodes.at(-2).styles.id, "act-agents");
  assert.equal(tree.nodes.at(-1).styles.id, "act-settings");
  byId(tree, "act-agents").handlers.on_click();
  assert.equal(panel.hidden, false);
  assert.equal(body.active, "changes");
  tree = draw();
  assert.equal(byId(tree, "agent-rail"), undefined);
  byId(tree, "act-agents").handlers.on_click();
  assert.equal(panel.hidden, true);
  assert.deepEqual(plain(panel.size), size);
  assert.deepEqual(plain(find(state.tree, "work")), tabState);
  assert.deepEqual(state.calls, [
    ["layout.show", { id: "agents-list" }], ["layout.hide", { id: "agents-list" }],
  ]);
});

test("Compact status preserves identity across local and SSH agents and opens the captured target", async () => {
  const { state, draw } = await harness([agent("t1", "working"), agent("ssh-chip/t1", "blocked")]);
  const tree = draw(), remote = byId(tree, "rail-agent-ssh-chip/t1");
  assert.ok(byId(tree, "rail-agent-t1"));
  assert.match(remote.styles.tooltip, /Needs you/);
  assert.match(remote.styles.tooltip, /ssh-chip\/t1/);
  remote.handlers.on_click();
  assert.deepEqual(state.calls, [["agent.focus", { terminal: "ssh-chip/t1" }]]);
});

test("A corner status light breathes for working and blocked agents and stays steady otherwise", async () => {
  const statuses = ["working", "blocked", "done", "idle", "unknown"];
  const { state, draw } = await harness(statuses.map((status, i) => agent("t" + i, status)));
  state.list[0].program = { name: "Prime Agent", icon: "icons/prime.png", tint: false };
  state.list[4].program = null;
  const tree = draw();
  for (let i = 0; i < statuses.length; i++) {
    const row = byId(tree, "rail-agent-t" + i);
    assert.ok(row);
    const light = byId(row, "agent-light-t" + i);
    assert.ok(light);
    assert.equal(light.styles.spin, undefined);
    assert.equal(light.styles.loop, i < 2 ? "opacity" : undefined);
    assert.equal(light.styles.bg, statuses[i]);
  }
  assert.equal(byId(tree, "rail-agent-t0").nodes[0].nodes[0].kind, "image");
  assert.equal(byId(tree, "rail-agent-t1").nodes[0].nodes[0].kind, "svg");
  assert.match(byId(tree, "rail-agent-t4").styles.tooltip, /Unknown/);
});

test("Opening Agents restores a hidden sidebar without replacing its selected view", async () => {
  const { state, draw } = await harness([agent("t1", "idle")]);
  find(state.tree, "side").hidden = true;
  find(state.tree, "agents-list").hidden = false;
  find(state.tree, "side-body").active = "spaces";
  assert.ok(byId(draw(), "agent-rail"));
  byId(draw(), "act-agents").handlers.on_click();
  assert.equal(find(state.tree, "side").hidden, false);
  assert.equal(find(state.tree, "side-body").active, "spaces");
  assert.deepEqual(state.calls, [
    ["layout.show", { id: "agents-list" }], ["layout.show", { id: "side" }],
  ]);
});

test("The Agents header uses visibility and is independent of retired Spaces collapse state", async () => {
  const { state, sections } = await harness();
  state.shared["vsc.sections"] = { spaces: true, agents: true, sizes: {} };
  const panel = find(state.tree, "agents-list");
  panel.hidden = false;
  sections.toggleSection();
  assert.equal(panel.hidden, true);
  assert.equal(sections.isCollapsed(), true);
  sections.toggleSection();
  assert.equal(panel.hidden, false);
  assert.ok(state.calls.every(([name, args]) => name !== "layout.resize" && args.id === "agents-list"));
});

test("Spaces management has one panel, while compact navigation matches pinned and priority order", async () => {
  const { state, draw } = await harness([
    agent("idle", "idle"), agent("busy", "working"), agent("needs", "blocked"), agent("pin", "idle", { pinned: true }),
  ]);
  assert.equal(find(state.tree, "spaces").content.mod, "spaces");
  assert.equal(find(state.tree, "spaces-switch"), undefined);
  assert.equal(find(state.tree, "agents-dock"), undefined);
  draw();
  assert.deepEqual(state.order, ["pin", "needs", "busy", "idle"]);
  state.shared["agents.sort"] = "grouped";
  draw();
  assert.deepEqual(state.order, ["pin", "idle", "busy", "needs"]);
});

test("An empty rail stays quiet and a missing panel reports an explicit error", async () => {
  const { state, draw } = await harness();
  assert.equal(byId(draw(), "agent-rail"), undefined);
  const side = find(state.tree, "side");
  side.children = side.children.filter(node => node.id !== "agents-list");
  assert.throws(() => byId(draw(), "act-agents").handlers.on_click(), /missing its Agents panel/);
});
