import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const plain = value => JSON.parse(JSON.stringify(value));
const file = (path, on = null) => ({ path, root: "/repo", on });
function element(kind = "div") {
  const data = { kind, nodes: [], styles: {}, handlers: {} };
  const proxy = new Proxy(data, { get(target, key) {
    if (key in target) return target[key];
    return (...args) => {
      if (["child", "content", "trigger"].includes(key)) target.nodes.push(args[0]);
      else if (key === "children") target.nodes.push(...args[0]);
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
  const state = { saved, actions: [], pending: [], reads: [], writes: [], created: 0, notices: [], space: "alpha",
    spaces: ["alpha", "beta"].map(id => ({ id, tabs: [{id:id+"-terminal", active:true}], machine:null, folder:"/repo" })),
    panes: ["alpha", "beta"].map(id => ({pane:id+"-shell",tab:id+"-terminal",terminal:id+"/t1",cwd:"/repo"})),
    props: {}, text: "original\n" };
  const ui = { View: class {}, div: element, svg: element, image: element, h_flex: element, v_flex: element, v_virtual_list: element,
    Popover: {new:()=>element("popover")}, TextView:{markdown:element}, Scrollbar:{vertical:element}, Editor:{new:element},
    ScrollHandle:{new:()=>({scroll_to_item(){}})},
    EditorState:{new:options=>({options,text:options.value,value(){return this.text;},on(name,fn){this[name]=fn;},release(){this.released=true;}})} };
  const host = {
    spaces: () => state.spaces.map(s=>({...s,active:s.id===state.space})), panes: () => state.panes,
    focused: () => ({pane:state.focus??"alpha-shell"}), shared:key=>state.saved[key], setShared:(key,value)=>{state.saved[key]=value;},
    props:()=>state.props, appHome:()=>"/app", theme:()=>({}), settings:()=>({}), checking:()=>false, layout:()=>({}), notify:v=>state.notices.push(v),
    run:(name,args)=>{
      state.actions.push([name,plain(args)]);
      if(name==="tab.select") for(const s of state.spaces) if(s.tabs.some(t=>t.id===args.id)) for(const t of s.tabs)t.active=t.id===args.id;
      if(name==="pane.focus") state.focus=args.pane;
      if(name==="tab.close") { for(const s of state.spaces)s.tabs=s.tabs.filter(t=>t.id!==args.id); state.panes=state.panes.filter(p=>p.tab!==args.id); }
    },
    exec:async(cmd,args)=>{
      if(cmd==="python3") {
        if(state.bindError)return {code:1,stderr:state.bindError,stdout:""};
        state.props.preview_pane=state.bindPane;
        return {code:0,stderr:"",stdout:'{"bound":1}'};
      }
      assert.equal(cmd,"env"); const request=JSON.parse(args.at(-1));
      if(state.gate)await state.gate;
      if(state.createError)return {code:1,stderr:state.createError,stdout:""};
      const id=++state.created,tab="native-tab-"+id,pane="native-pane-"+id;
      state.spaces.find(s=>s.id===request.space).tabs.push({id:tab,name:request.name,active:false});
      state.panes.push({pane,tab,mod:request.mod,terminal:null,focused:false});
      return {code:0,stderr:"",stdout:JSON.stringify({space:request.space,tab,pane})};
    },
    readTextFile:async(path,options)=>{state.reads.push([path,plain(options)]);if(state.readError)throw new Error(state.readError);return state.text;},
    writeTextFile:async(...args)=>{if(state.saveError)throw new Error(state.saveError);state.writes.push(plain(args));},
    nextCommand:()=>new Promise(()=>{}), openOverlay(){},
  };
  const context=vm.createContext({}),cache=new Map();
  async function load(url){
    if(cache.has(url))return cache.get(url);
    const promise=(async()=>{
      const mod=new vm.SourceTextModule(await readFile(new URL(url),"utf8"),{context,identifier:url});
      await mod.link((name,parent)=>{
        if(name.startsWith("."))return load(new URL(name,parent.identifier).href);
        const exports=name==="herdr"?host:ui;
        return new vm.SyntheticModule(Object.keys(exports),function(){for(const[k,v]of Object.entries(exports))this.setExport(k,v);},{context});
      });return mod;
    })();cache.set(url,promise);return promise;
  }
  async function namespace(relative){const m=await load(new URL(relative,import.meta.url).href);await m.evaluate();return m.namespace;}
  const files=await namespace("../files.js"),Main=(await namespace("../main.js")).default;
  const Bar=(await namespace("../../vsc-panelbar/main.js")).default;
  const cx={notify(){},stop_propagation(){},focus_handle:()=>({focus(){}}),timer:{every(){},after(){}},spawn(fn){state.pending.push(fn(cx));}};
  const settle=async()=>{while(state.pending.length)await Promise.all(state.pending.splice(0));};
  function editor(opened){
    state.props={file:opened.file,preview_pane:opened.pane.split("/").pop()};
    const v=new Main();Object.assign(v,{file:opened.file,pane:opened.pane,space:opened.space,wrap:false,handle:{}});return v;
  }
  return {state,host,files,cx,settle,editor,bar:()=>{const b=new Bar();b.init(null,cx);return b;}};
}

test("File tabs deduplicate within a Space by machine and path, while native selection stays per Space",async()=>{
  const {state,files}=await harness();
  const a=await files.openFile(file("/repo/same.v"));
  assert.equal((await files.openFile(file("/repo/same.v"))).pane,a.pane);
  await files.openFile(file("/repo/same.v","chip"));
  state.space="beta";await files.openFile(file("/repo/same.v"));
  assert.equal(state.created,3);
  assert.equal(files.filePanes("alpha").length,2);
  assert.equal(files.filePanes("beta").length,1);
  assert.equal(state.spaces[0].tabs.find(t=>t.active).id,"native-tab-2");
});
test("A creation finishing after a Space switch stays in its captured Space without stealing focus",async()=>{
  const {state,files}=await harness();let release;state.gate=new Promise(r=>{release=r;});
  const opening=files.openFile(file("/repo/a.txt"));state.space="beta";release();await opening;
  assert.equal(state.actions.length,0);assert.equal(files.filePanes("alpha").length,1);
});
test("Duplicate clicks cannot create two panes and failed native commands remain retryable",async()=>{
  const {state,files}=await harness();let release;state.gate=new Promise(r=>{release=r;});
  const opening=files.openFile(file("/repo/a.txt"));
  await assert.rejects(files.openFile(file("/repo/a.txt")),/already opening/);release();await opening;
  state.gate=null;state.createError="Remote layout unavailable";
  await assert.rejects(files.openFile(file("/repo/b.txt")),/Remote layout unavailable/);
  state.createError=null;await files.openFile(file("/repo/b.txt"));assert.equal(state.created,2);
});
test("A closed native pane never leaves a stale deduplication target",async()=>{
  const {state,files}=await harness();const a=await files.openFile(file("/repo/a.txt"));
  state.panes=state.panes.filter(p=>p.pane!==a.pane);await files.openFile(file("/repo/a.txt"));assert.equal(state.created,2);
});
test("File splits pass captured props to Herdr's native split and do not create editor groups",async()=>{
  const {state,files}=await harness();const opened=await files.openFile(file("/repo/a.v","chip"));
  files.splitFile(opened.pane,"down");
  assert.deepEqual(state.actions.at(-1),["pane.split",{pane:opened.pane,direction:"down",mod:"vsc-editor",props:{file:file("/repo/a.v","chip")}}]);
});
test("Diff tabs retain a separate identity and refresh an existing pane instead of duplicating it",async()=>{
  const {state,files}=await harness();await files.openFile(file("/repo/a.txt"));
  const diff={...file("git-diff:a"),kind:"diff",sourcePath:"/repo/a.txt",relativePath:"a.txt",revision:"1"};
  const d=await files.openFile(diff);await files.openFile({...diff,revision:"2"});
  assert.equal(state.created,2);assert.equal(files.filePanes()[1].file.revision,"2");assert.equal(files.activeFile().path,diff.path);
});
test("Restoring many legacy tabs is lazy, preserves source lists, and does not change focus",async()=>{
  const legacy={files:Array.from({length:76},(_,i)=>file(`/repo/a${i}.txt`)),active:"/repo/a75.txt"};
  const {state,bar,cx,settle}=await harness({"vsc.editor.space:alpha:1":legacy});
  bar().migrate("alpha",cx);await settle();
  assert.equal(state.created,76);assert.equal(state.reads.length,0);assert.equal(state.actions.length,0);
  assert.strictEqual(state.saved["vsc.editor.space:alpha:1"],legacy);assert.equal(state.saved["vsc.files.migrated:alpha"],true);
});
test("Malformed legacy state reports an error before partial migration and stays untouched",async()=>{
  const bad={files:"invalid",active:null},saved={"vsc.editor.space:alpha:1":{files:[file("/a.txt")],active:"/a.txt"},"vsc.editor.space:alpha:2":bad};
  const {state,bar,cx,settle}=await harness(saved);const b=bar();b.migrate("alpha",cx);await settle();
  assert.equal(state.created,0);assert.match(b.errors.get("alpha"),/Invalid saved editor tabs/);assert.strictEqual(saved["vsc.editor.space:alpha:2"],bad);
});
test("Inactive file panes do not read files; read failures surface and recover on retry",async()=>{
  const {state,files,editor,cx,settle}=await harness();const opened=await files.openFile(file("/repo/a.txt"),{focus:false});
  const view=editor(opened);view.render(cx);await settle();assert.equal(state.reads.length,0);
  state.spaces[0].tabs.forEach(t=>t.active=t.id===opened.tab);state.readError="permission denied";
  let tree=view.render(cx);await settle();tree=view.render(cx);assert.match(view.doc.error,/permission denied/);
  state.readError=null;byId(tree,"retry-file").handlers.on_click({},cx);await settle();assert.equal(view.doc.code.value(),state.text);
});
test("Content mods without an injected pane ID attach through persisted native metadata",async()=>{
  const {state,files,editor,cx,settle}=await harness();const opened=await files.openFile(file("/repo/a.txt"));
  const view=editor(opened);delete state.props.preview_pane;state.bindPane=opened.pane;
  view.render(cx);await settle();view.render(cx);await settle();
  assert.equal(view.pane,opened.pane);assert.equal(view.doc.code.value(),state.text);
});
test("Failed native pane attachment shows its real error and offers an explicit retry",async()=>{
  const {state,files,editor,cx,settle}=await harness();const opened=await files.openFile(file("/repo/a.txt"));
  const view=editor(opened);delete state.props.preview_pane;state.bindPane=opened.pane;state.bindError="Remote layout unavailable";
  view.render(cx);await settle();const tree=view.render(cx);
  assert.match(view.bindingError,/Remote layout unavailable/);assert.equal(state.reads.length,0);
  state.bindError=null;byId(tree,"retry-pane").handlers.on_click({},cx);view.render(cx);await settle();view.render(cx);await settle();
  assert.equal(view.doc.code.value(),state.text);
});
test("Close Others preserves unsaved files, terminal work and other Spaces",async()=>{
  const {state,files}=await harness();const a=await files.openFile(file("/a.txt")),b=await files.openFile(file("/b.txt")),c=await files.openFile(file("/c.txt"));
  state.space="beta";await files.openFile(file("/d.txt"));files.setFileDirty(b.pane,true);state.actions=[];
  files.closeOtherFiles(a.tab,"alpha");assert.deepEqual(state.actions,[["tab.close",{id:c.tab}]]);
  assert.equal(files.closeFileTab(b.tab),false);assert.match(state.notices.at(-1).body,/Save/);
});
test("Unsaved edits survive pane recreation, save conflicts keep buffers, and successful saves clear them",async()=>{
  const {state,files,editor,cx,settle}=await harness();const a=await files.openFile(file("/repo/a.txt"));const first=editor(a);
  first.load(a.file,cx);await settle();first.doc.code.text="unsaved\n";first.doc.code.change({},cx);
  await first.close();const second=editor(a);second.load(a.file,cx);await settle();
  assert.equal(second.doc.code.value(),"unsaved\n");assert.equal(second.doc.dirty,true);
  state.saveError="file changed on disk";assert.equal(await second.save(cx),false);assert.match(second.doc.saveError,/file changed on disk/);
  assert.ok(state.saved[files.bufferKey("alpha",a.file)]);state.saveError=null;assert.equal(await second.save(cx),true);
  assert.deepEqual(state.writes,[["/repo/a.txt","unsaved\n","original\n"]]);assert.equal(state.saved[files.bufferKey("alpha",a.file)],null);
});
test("Corrupt recovered buffers and metadata are explicit errors and are never discarded on close",async()=>{
  const {state,files,editor,cx,settle}=await harness();const a=await files.openFile(file("/repo/a.txt")),key=files.bufferKey("alpha",a.file);
  const corrupt={text:17};state.saved[key]=corrupt;const v=editor(a);v.load(a.file,cx);await settle();await v.close();
  assert.match(v.doc.error,/Invalid saved unsaved buffer/);assert.strictEqual(state.saved[key],corrupt);
  state.saved["vsc.file-panes"]=[];assert.throws(()=>files.filePanes(),/Invalid saved file pane index/);
});
test("Clean native splits cannot erase sibling edits and divergent split buffers recover independently",async()=>{
  const {state,files,editor,cx,settle}=await harness();const a=await files.openFile(file("/repo/a.txt"));
  const first=editor(a);first.load(a.file,cx);await settle();
  const copy={...a,pane:"copy-pane"};state.panes.push({pane:copy.pane,tab:a.tab,mod:"vsc-editor"});files.registerFile(a.file,copy.pane);
  const second=editor(copy);second.load(a.file,cx);await settle();
  first.doc.code.text="first edit";first.doc.code.change({},cx);await second.close();
  assert.equal(state.saved[files.bufferKey("alpha",a.file)].text,"first edit");
  second.doc.code.text="second edit";second.doc.code.change({},cx);await first.close();
  const recoveredFirst=editor(a);recoveredFirst.load(a.file,cx);await settle();
  const recoveredCopy=editor(copy);recoveredCopy.load(a.file,cx);await settle();
  assert.equal(recoveredFirst.doc.code.value(),"first edit");assert.equal(recoveredCopy.doc.code.value(),"second edit");
});
test("Mod-local helpers and SSH download verification remain identical across consumers",async()=>{
  const helper=await readFile(new URL("../files.js",import.meta.url),"utf8");
  for(const mod of ["vsc-explorer","vsc-changes","vsc-jump","vsc-panelbar","vsc-pane"])
    assert.equal(await readFile(new URL(`../../${mod}/files.js`,import.meta.url),"utf8"),helper);
  assert.equal(await readFile(new URL("../download.py",import.meta.url),"utf8"),await readFile(new URL("../../vsc-explorer/download.py",import.meta.url),"utf8"));
});
