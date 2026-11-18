import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const snapshot = (total = 1000, idle = 700) => ({ version: 1, boot: "boot-one", total_ticks: total,
  idle_ticks: idle, cpus: 8, memory_total: 16 * 1073741824, memory_available: 10 * 1073741824 });
const plain = v => JSON.parse(JSON.stringify(v));
function element() {
  const target = { nodes: [], styles: {}, handlers: {} };
  const proxy = new Proxy(target, { get(o, k) {
    if (k in o) return o[k];
    return (...args) => {
      if (k === "child") o.nodes.push(args[0]);
      else if (k === "children") o.nodes.push(...args[0]);
      else if (k === "when") { if (args[0]) args[1](proxy); }
      else if (k.startsWith("on_")) o.handlers[k] = args[0];
      else o.styles[k] = args[0];
      return proxy;
    };
  } });
  return proxy;
}
async function harness() {
  const state = { calls: [], reads: 0, pending: [], visible: true, active: true, value: snapshot(),
    machine:"chip", machines: [{name:null,layout:"ready"},{name:"chip",layout:"ready"},{name:"away",layout:"unavailable"},{name:"temp",layout:"ready",temporary:true}] };
  const host = {
    exec: async (cmd, args, options) => {
      state.calls.push([cmd, args, plain(options)]);
      if (state.gate) await state.gate;
      if (state.error) throw new Error(state.error);
      return {code:0,stdout:state.output ?? JSON.stringify(state.value),stderr:""};
    },
    readTextFile: async () => { state.reads++; if (state.readError) throw new Error(state.readError); return "print('probe')"; },
    agents: () => [], setAgentOrder() {}, nextCommand: () => new Promise(()=>{}), appHome: () => "/app", machines: () => state.machines, spaces: () => state.noSpace?[]:[{active:true,machine:state.machine}], panes: () => [], shared: () => ({}), setShared() {},
    run() {}, openOverlay() {}, watchFolder() {}, window: () => ({ active: state.active }),
    layout: () => ({ id:"side", hidden:!state.visible, children:[{id:"side-body",active:state.visible?"spaces":"explorer"}] }),
    hc: async () => ({code:0,stdout:JSON.stringify({machines:[]})}), theme: () => ({}),
  };
  const ui = {View:class {},div:element,svg:element,image:element,h_flex:element,v_flex:element,
    PathBuilder:{stroke:()=>({move_to(){return this;},arc_to(){return this;},build(){return {};}})},ScrollHandle:{new:()=>({scroll_to_item(){}})}};
  const storage = new Map();
  const context = vm.createContext({window:{paint_path:(path,color)=>element().id("arc").bg(color)},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)}}), cache = new Map();
  async function load(url) {
    if (cache.has(url)) return cache.get(url);
    const promise = (async () => {
      const m = new vm.SourceTextModule(await readFile(new URL(url),"utf8"),{context,identifier:url});
      await m.link((name,parent) => {
        if (name.startsWith(".")) return load(new URL(name,parent.identifier).href);
        const values = name === "herdr" ? host : ui;
        return new vm.SyntheticModule(Object.keys(values),function(){for(const[k,v]of Object.entries(values))this.setExport(k,v);},{context});
      }); return m;
    })(); cache.set(url,promise); return promise;
  }
  const m = await load(new URL("../main.js",import.meta.url).href); await m.evaluate();
  const resources = await load(new URL("../resources.js",import.meta.url).href); await resources.evaluate();
  const cx = { notify(){},timer:{every(){}},spawn(fn){state.pending.push(fn(cx));} };
  const view = new m.namespace.default(); view.resources=new resources.namespace.Resources();view.resourceAt=new Map();
  const settle = async () => { while(state.pending.length)await Promise.all(state.pending.splice(0)); };
  await settle(); return {state,view,cx,settle,...resources.namespace};
}

test("CPU uses interval tick deltas and memory excludes available cache",async()=>{
  const {usage} = await harness();
  assert.equal(usage(snapshot()).cpu,null);
  const u = usage(snapshot(1200,750),snapshot());
  assert.equal(u.cpu,75); assert.equal(u.used,6*1073741824); assert.equal(u.cpus,8);
  assert.equal(usage({...snapshot(),boot:"new-boot"},snapshot()).cpu,null);
});
test("Malformed counters and counter resets surface explicit errors",async()=>{
  const {usage,validate} = await harness();
  for(const value of [{}, {...snapshot(),memory_available:Infinity}, {...snapshot(),memory_total:-1}, {...snapshot(),cpus:0}])
    assert.throws(()=>validate(value),/invalid host resource/);
  assert.throws(()=>usage(snapshot(900,700),snapshot()),/did not advance/);
});
test("Only the active Space's machine is sampled, including local macOS",async()=>{
  const {state,view,cx,settle} = await harness();
  state.noSpace=true;view.refreshResources(cx);await settle();assert.equal(state.calls.length,0);
  state.noSpace=false;state.machine=null;view.refreshResources(cx);await settle();assert.equal(state.calls[0][2].on,null);
  state.machine="chip";state.active=false;view.refreshResources(cx);await settle();
  assert.deepEqual(state.calls.map(c=>c[2].on),[null,"chip"]);
  view.refreshResources(cx);await settle();assert.equal(state.calls.length,2);
  assert.equal(view.resources.states.has("away"),false);
  state.machine="away";view.refreshResources(cx);await settle();assert.equal(state.calls.length,2);
  assert.match(view.resources.states.get("away").error,/offline/);
});
test("Failures clear readings and CPU baseline; retry preserves the captured machine",async()=>{
  const {state,view} = await harness(), r=view.resources;
  await r.sample("chip");state.value=snapshot(1200,750);await r.sample("chip");assert.equal(r.states.get("chip").value.cpu,75);
  state.error="SSH disconnected";await r.sample("chip");
  assert.equal(r.states.get("chip").value,undefined);assert.match(r.states.get("chip").error,/SSH disconnected/);
  state.error=null;await r.sample("chip");assert.equal(r.states.get("chip").value.cpu,null);
  assert.ok(state.calls.every(c=>c[2].on==="chip"));
});
test("Missing probe artifacts and malformed JSON remain visible and retryable",async()=>{
  const {state,view} = await harness(), r=view.resources;
  state.readError="probe file missing";await r.sample("chip");assert.match(r.states.get("chip").error,/probe file missing/);
  assert.equal(state.calls.length,0);
  state.readError=null;state.output="invalid JSON";await r.sample("chip");assert.ok(r.states.get("chip").error);
  state.output=null;await r.sample("chip");assert.ok(r.states.get("chip").value);assert.equal(state.reads,2);
});
test("Overlapping requests never launch a second process for the same machine",async()=>{
  const {state,view} = await harness();let release;state.gate=new Promise(r=>{release=r;});
  const first=view.resources.sample("chip");await view.resources.sample("chip");release();await first;
  assert.equal(state.calls.length,1);
});
test("Rings show CPU percent and used GB, with independent 60/90 percent warnings",async()=>{
  const {view,INTERVAL,STALE}=await harness();assert.equal(INTERVAL,5000);
  view.resources.states.set("chip",{value:{cpu:25,used:8*1073741824,total:16*1073741824},at:Date.now()});
  const all=n=>n&&typeof n==="object"?[n,...n.nodes.flatMap(all)]:[];
  const find=(tree,id)=>all(tree).find(n=>n.styles.id===id);
  const text=tree=>all(tree).flatMap(n=>n.nodes.filter(v=>typeof v==="string")).join(" ");
  let tree=view.meters("chip",{});
  assert.equal(text(tree),"25% 8.0 G");
  assert.equal(find(tree,"host-cpu").styles.size,40);
  assert.equal(find(find(tree,"host-cpu"),"arc").styles.bg,"#8daec8");
  view.resources.states.set("chip",{value:{cpu:60,used:9,total:10},at:Date.now()});tree=view.meters("chip",{});
  assert.equal(find(find(tree,"host-cpu"),"arc").styles.bg,"#e3b341");
  assert.equal(find(find(tree,"host-memory"),"arc").styles.bg,"#ef5b5b");
  view.resources.states.set("chip",{error:"Probe disconnected",at:Date.now()});tree=view.meters("chip",{});
  assert.match(tree.styles.tooltip,/Probe disconnected/);assert.equal(find(tree,"arc"),undefined);assert.equal(text(tree),"! !");
  view.resources.states.set("chip",{value:{cpu:99,used:8,total:16},at:Date.now()-STALE-1});
  assert.equal(text(view.meters("chip",{})),"— —");
  assert.match(view.meters(null,{}).styles.tooltip,/This computer/);
});
test("Warning thresholds include exactly 60 and 90 percent, with zero usage healthy",async()=>{
  const {resourceColor}=await harness();
  assert.equal(resourceColor(0),"#8daec8");assert.equal(resourceColor(.59999),"#8daec8");
  assert.equal(resourceColor(.6),"#e3b341");assert.equal(resourceColor(.89999),"#e3b341");
  assert.equal(resourceColor(.9),"#ef5b5b");assert.equal(resourceColor(1),"#ef5b5b");
});
