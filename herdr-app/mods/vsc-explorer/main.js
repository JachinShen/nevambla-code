// VS Code-style Explorer: the focused pane's folder as a tree. Clicking a file
// opens it as a native tab in the current Space.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { fileIcon, folderIcon, ICON_FONT } from "./icons.js";
import { exec, watchFolder, theme, shared, setShared, layout, checking, run, openOverlay, closeOverlay, props, spaces, panes, focused } from "herdr";
import { findNode, terminalLocation, browsingLocation as location } from "./navigation.js";
import { activeFile, currentSpace, openFile } from "./files.js";
import { gitRoot, withGitIgnores } from "./git.js";

const key = () => JSON.stringify(location());
const join = (cwd, path) => `${cwd.replace(/\/+$/, "")}/${path}`;
const PER_FOLDER = 500, TOTAL = 5000;
const HIDE = new Set([".git", ".DS_Store"]);

async function directory(path, on) {
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  const r = await exec("sh", ["-c", script, "files", path], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const f = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < f.length; i += 2) if (!HIDE.has(f[i + 1])) out.push({ name: f[i + 1], dir: f[i] === "d" });
  return out;
}

export default class VscExplorer extends View {
  init(_p, cx) {
    if (typeof props()?.copyPath === "string") {
      this.menuIndex = 0;
      this.menuFocus = cx.focus_handle();
      this.menuFocus.focus();
      return;
    }
    this.saved = new Map(); this.entries = new Map(); this.folders = new Set(); this.marks = {}; this.rootOpen = true;
    this.folderErrors = new Map(); this.folderLoads = new Map();
    this.scroll = ScrollHandle.new();
    if (checking()) return;
    this.refresh(cx);
    // The folder watcher catches changes as they happen; this is only a fallback (remote
    // folders, missed events), and it skips work while the side bar is hidden.
    cx.timer.every(60000, cx => { if (findNode(layout(), "side")?.hidden !== true) this.refresh(cx); });
  }

  current(ctx) { return this.context === ctx && key() === ctx.key; }

  async loadFolder(path, ctx) {
    if (!this.current(ctx) || (path && !this.folders.has(path))) return;
    const request = Symbol();
    const loads = this.folderLoads;
    loads.set(path, request);
    const current = () => this.current(ctx) && loads.get(path) === request;
    const cwd = path ? join(ctx.cwd, path) : ctx.cwd;
    try {
      const entries = (await directory(cwd, ctx.on)).slice(0, PER_FOLDER)
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
      if (!current()) return;
      // Keep files browsable if Git fails, with an explicit error below the tree.
      this.entries.set(path, entries);
      const classified = await withGitIgnores(entries, cwd, ctx.on);
      if (!current()) return;
      this.entries.set(path, classified); this.folderErrors.delete(path);
    } catch (e) { if (current()) this.folderErrors.set(path, String(e)); }
    finally { if (loads.get(path) === request) loads.delete(path); }
  }

  watch(ctx, cx) {
    if (ctx.on || this.watched === ctx.cwd) return;
    this.watched = ctx.cwd;
    cx.spawn(async cx => {
      try { while (this.context === ctx) { await watchFolder(ctx.cwd); if (this.current(ctx)) this.refresh(cx); } }
      catch { if (this.context === ctx) this.watched = null; }
    });
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, this.folders);
      this.context = { key: next, cwd, on }; this.entries = new Map(); this.folders = new Set(this.saved.get(next));
      this.marks = {}; this.folderErrors = new Map(); this.folderLoads = new Map(); this.watched = null; this.error = null; this.loading = false;
    }
    if (!cwd || this.loading) return;
    const ctx = this.context; this.loading = true;
    cx.spawn(async cx => {
      try {
        for (const p of ["", ...this.folders]) { if (!this.current(ctx)) return; await this.loadFolder(p, ctx); }
        const top = await gitRoot(cwd, on);
        const marks = {};
        if (top) {
          const st = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on });
          if (st.code !== 0) throw new Error(st.stderr || "Cannot read Git status");
          for (const e of st.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = e.slice(0, 2), full = `${top}/${e.slice(3)}`;
            const m = xy === "??" ? "U" : xy.includes("A") ? "A" : xy.includes("D") ? "D" : "M";
            marks[full] = m;
            // Folders containing changes get a dot, like VS Code.
            for (let d = full.slice(0, full.lastIndexOf("/")); d.length > cwd.length; d = d.slice(0, d.lastIndexOf("/"))) marks[d] ??= "•";
          }
        }
        if (!this.current(ctx)) return;
        this.marks = marks; this.error = null;
        if (this.revealPath) {
          const index = this.flatten("", 0, []).findIndex(item => join(ctx.cwd, item.path) === this.revealPath);
          if (index >= 0) this.scroll.scroll_to_item(index);
          this.revealPath = null;
        }
      } catch (e) { if (this.current(ctx)) { this.marks = {}; this.error = String(e); } }
      finally { if (this.context === ctx) this.loading = false; if (this.current(ctx)) this.watch(ctx, cx); cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const f of [...this.folders]) if (f === path || f.startsWith(path + "/")) {
        this.folders.delete(f); this.entries.delete(f); this.folderErrors.delete(f); this.folderLoads.delete(f);
      }
    } else {
      this.folders.add(path);
      const ctx = this.context;
      cx.spawn(async cx => { await this.loadFolder(path, ctx); cx.notify(); });
    }
    cx.notify();
  }

  open(path, cx) {
    const ctx = this.context, space = currentSpace();
    const file = { path: join(ctx.cwd, path), root: ctx.cwd, on: ctx.on ?? null };
    cx.spawn(async cx => {
      try { await openFile(file, { space }); }
      catch (e) { this.error = `Could not open file: ${e.message ?? e}`; }
      cx.notify();
    });
  }

  // The open tree as plain data; only the visible rows become elements.
  flatten(prefix, depth, out) {
    for (const e of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      out.push({ e, path, depth });
      if (e.dir && this.folders.has(path)) this.flatten(path, depth + 1, out);
    }
    return out;
  }

  glyph([char, color]) {
    return div().w(16).flex_none().flex().justify_center().font_family(ICON_FONT).text_size(14).text_color(color).child(char);
  }

  canDragPaths() {
    const space = spaces().find(s => s.active);
    const tab = space?.tabs.find(t => t.active);
    const on = this.context?.on ?? null;
    if (!this.context?.cwd || !tab || space.machine !== on) return false;

    const onSource = address => (address.includes("/") ? address.split("/")[0] : null) === on;
    const focus = focused();
    const terminal = focus?.shown ?? focus?.terminal;
    const tabTerminals = panes().filter(p => p.tab === tab.id && p.terminal);
    return Boolean(terminal || tabTerminals.length) && (!terminal || onSource(terminal))
      && tabTerminals.every(p => onSource(p.terminal));
  }

  pathActions(row, path, canDrag, fileName) {
    const on = this.context.on ?? null;
    return row.when(canDrag, el => el.drag_paths([path], { on }))
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        const source = fileName ? { on, path, name: fileName } : null;
        openOverlay({ mod: "vsc-explorer", kind: "popup", width: 168, props: { copyPath: path, source } });
      });
  }

  pathMenu({ copyPath, overlay, source }) {
    const t = theme();
    const items = [{ id: "copy-path", label: "复制路径", action: cx => cx.write_to_clipboard(copyPath) }];
    if (source) items.push({
      id: "transfer-file", label: "传到另一台机器…",
      action: () => openOverlay({ mod: "vsc-transfer", kind: "dialog", modal: true, width: 590, height: 410, props: { source } }),
    });
    const choose = (index, cx) => {
      closeOverlay(overlay);
      items[index].action(cx);
    };
    return v_flex().id("path-menu").role("menu").track_focus(this.menuFocus).w_full().p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "enter") {
          cx.stop_propagation();
          choose(this.menuIndex, cx);
        } else if (e.key === "down" || e.key === "up") {
          cx.stop_propagation();
          this.menuIndex = (this.menuIndex + items.length + (e.key === "down" ? 1 : -1)) % items.length;
          cx.notify();
        }
      })
      .children(items.map(({ id, label }, index) => h_flex().id(id).role("menu_item").h(31).px(8).items_center()
        .rounded(7).text_color(t.foreground).cursor_pointer()
        .when(index === this.menuIndex, el => el.bg(t.selected).aria_active_descendant())
        .hover(s => s.bg(t.hover)).on_click((_e, cx) => choose(index, cx)).child(label)));
  }

  row({ e, path, depth }, t, active, canDrag) {
    const abs = join(this.context.cwd, path), open = this.folders.has(path);
    const mark = this.marks[abs], sel = abs === active;
    const markColor = e.ignored ? t.dim : mark === "U" || mark === "A" ? t.ansi2 : mark === "D" ? t.ansi1 : t.blocked;
    const [glyph, color] = e.dir ? folderIcon(open) : fileIcon(e.name);
    return this.pathActions(h_flex().id(`f-${path}`), abs, canDrag, e.dir ? null : e.name)
      .h(22).flex_none().pl(12 + depth * 12).pr(10).gap(5).items_center().cursor_pointer()
      .when(sel, el => el.bg(t.selected)).hover(s => s.bg(sel ? t.selected : t.hover))
      .on_click((_e, cx) => e.dir ? this.toggle(path, cx) : this.open(path, cx))
      .child(e.dir ? svg(`mods/vsc-explorer/chevron-${open ? "down" : "right"}.svg`).size(14).flex_none().text_color(e.ignored ? t.dim : t.muted)
                   : div().w(14).flex_none())
      .child(this.glyph([glyph, e.ignored ? t.dim : color]))
      .child(div().flex_1().min_w(0).truncate().text_color(e.ignored ? t.dim : mark && mark !== "•" ? markColor : t.foreground).child(e.name))
      .when(Boolean(mark), el => el.child(div().flex_none().text_size(11).text_color(markColor).child(mark)));
  }

  render(cx) {
    if (this.menuFocus) return this.pathMenu(props());
    if (!checking() && key() !== this.context?.key) this.refresh(cx);
    const completed = shared("vsc.transfer.completed");
    if (!checking() && completed && this.completedToken !== completed.token) {
      this.completedToken = completed.token;
      if ((this.context?.on ?? null) === completed.on && this.context?.cwd === completed.folder) this.refresh(cx);
    }
    const jump = shared("vsc.explorer.jump"), pinned = jump?.source === JSON.stringify(terminalLocation());
    if (!checking() && pinned && this.revealToken !== jump.token) {
      this.revealToken = jump.token;
      this.revealPath = jump.file;
      this.rootOpen = true;
      this.refresh(cx);
    }
    const t = theme(), selected = activeFile();
    const active = (selected?.on ?? null) === (this.context?.on ?? null) ? selected?.path : null;
    const name = (this.context?.cwd ?? "").split("/").filter(Boolean).pop() ?? "";
    const items = this.rootOpen ? this.flatten("", 0, []) : [];
    const error = [this.error, ...this.folderErrors.values()].filter(Boolean).join("\n");
    const canDrag = this.canDragPaths();
    return v_flex().id("explorer").size_full().min_h(0).bg(t.chrome).text_color(t.foreground).text_size(13)
      .child(h_flex().h(35).flex_none().px(20).gap(8).items_center().text_size(11).text_color(t.muted).child("EXPLORER")
        .child(div().flex_1().min_w(0).truncate().child(this.context?.on ? `SSH · ${this.context.on}` : ""))
        .when(pinned, el => el.child(div().id("follow-terminal").size(24).flex_none().flex().items_center().justify_center().rounded(4)
          .cursor_pointer().tooltip("返回终端当前目录").hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click((_event, cx) => { setShared("vsc.explorer.jump", null); this.refresh(cx); })
          .child(svg("mods/vsc-explorer/corner-up-left.svg").size(16))))
        .when(Boolean(this.context?.cwd), el => el.child(div().id("refresh-explorer").size(24).flex_none().flex().items_center().justify_center().rounded(4)
          .text_size(16).text_color(this.loading ? t.dim : t.muted)
          .tooltip(this.loading ? "正在刷新文件列表…" : "刷新文件列表")
          .when(!this.loading, button => button.cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_event, cx) => { this.refresh(cx); cx.notify(); }))
          .child("↻")))
        .child(div().id("jump-path").size(24).flex_none().flex().items_center().justify_center().rounded(4)
          .cursor_pointer().tooltip("跳转到路径 ⌘⇧O").hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("mod.open", { name: "vsc-jump" }))
          .child(svg("mods/vsc-explorer/arrow-up-right.svg").size(16))))
      .child(h_flex().id("root").h(22).flex_none().px(4).gap(4).items_center().cursor_pointer().text_size(11).font_semibold()
        .when(Boolean(this.context?.cwd), el => this.pathActions(el, this.context.cwd, canDrag))
        .on_click((_e, cx) => { this.rootOpen = !this.rootOpen; cx.notify(); })
        .child(svg(`mods/vsc-explorer/chevron-${this.rootOpen ? "down" : "right"}.svg`).size(14).text_color(t.muted))
        .child(div().truncate().child(name.toUpperCase() || "NO FOLDER")))
      .when(this.rootOpen && items.length > 0, el => el.child(v_flex().id("tree").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll).pb(8)
        .children(items.map(it => this.row(it, t, active, canDrag)))))
      .when(this.rootOpen && (Boolean(error) || !items.length), el => el.child(div().px(20).py(6).text_size(12).text_color(error ? t.ansi1 : t.dim)
        .child(error || (this.loading ? "Loading…" : "Empty folder"))));
  }
}
