import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

test("Usage failures replace the previous reading with a visible error, and a later success recovers", async () => {
  const state = { "vsc.usage": { claude: { five_hour: { utilization: 15 } } } };
  let response;
  const context = vm.createContext({});
  const host = {
    theme() {}, run() {}, spaces() {}, layout() {}, window() {},
    exec: async () => { if (response instanceof Error) throw response; return response; },
    appHome: () => "/home/example/.config/herdr-app",
    shared: key => state[key], setShared: (key, value) => { state[key] = value; },
    props: () => ({}), openOverlay() {}, closeOverlay() {}, checking: () => true,
  };
  const ui = { View: class {}, div() {}, svg() {}, h_flex() {} };
  const module = new vm.SourceTextModule(await readFile(new URL("../main.js", import.meta.url), "utf8"), { context });
  await module.link(name => {
    const exports = name === "herdr" ? host : ui;
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  const view = new module.namespace.default(), pending = [];
  const cx = { spawn(fn) { pending.push(fn(cx)); }, notify() {} };
  for (const [result, error] of [
    [{ code: 0, stdout: '{"error":"not logged in"}' }, /not logged in/],
    [{ code: 1, stdout: "" }, /helper failed/],
    [{ code: 0, stdout: "{}" }, /missing five_hour/],
    [{ code: 0, stdout: "invalid JSON" }, /JSON|Unexpected/],
    [new Error("network unavailable"), /network unavailable/],
  ]) {
    response = result;
    view.fetch(cx);
    await Promise.all(pending.splice(0));
    assert.match(state["vsc.usage"].claude.error, error);
    assert.equal(state["vsc.usage"].claude.five_hour, undefined);
  }
  response = { code: 0, stdout: '{"five_hour":{"utilization":20},"seven_day":{"utilization":30}}' };
  view.fetch(cx);
  await Promise.all(pending);
  assert.equal(state["vsc.usage"].claude.five_hour.utilization, 20);
  assert.equal(state["vsc.usage"].claude.error, undefined);
});
