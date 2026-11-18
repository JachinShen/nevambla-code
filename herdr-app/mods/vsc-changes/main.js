import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { exec, watchFolder, theme, checking, run } from "herdr";
import { location } from "./navigation.js";
import { targetGroup, setActiveGroup, readEditor, writeEditor } from "./editor-state.js";
import { fileIcon, ICON_FONT } from "./icons.js";
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
// Diff tabs have a separate identity from editable files, including their machine.
const diffKey = (on, root, path) => `git-diff:${encodeURIComponent(JSON.stringify([on ?? null, root, path]))}`;

export default class Changes extends View {
  init(_props, cx) {
    this.files = []; this.rootOpen = true; this.message = ""; this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.cwd = cwd; this.on = on; this.root = null; this.files = []; this.open = null;
      this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null; this.limited = false;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) throw new Error((top.stderr || top.stdout).trim() || `Cannot inspect repository (exit ${top.code})`);
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const stats = {};
        const results = head.code === 0 ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        const files = [];
        const entries = status.stdout.split("\0").filter(Boolean);
        for (const entry of entries.slice(0, 1000)) {
          const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          const stat = stats[path] ?? { add: 0, del: 0 };
          files.push({ path, status: s, fresh, ...stat });
        }
        if (key() !== context) return;
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.files = files; this.limited = entries.length > 1000; this.error = null;
        this.watch(root, cx);
        if (this.open && !files.some(f => f.path === this.open)) this.open = null;
      } catch (e) {
        if (key() === context) {
          this.root = null; this.files = []; this.open = null; this.error = String(e);
        }
      }
      finally { this.loading = false; cx.notify(); }
    });
  }

  pick(path, cx) {
    if (!this.root || this.context !== key() || !this.files.some(f => f.path === path)) return;
    const group = targetGroup(), state = readEditor(group);
    const id = diffKey(this.on, this.root, path);
    const file = { path: id, kind: "diff", sourcePath: `${this.root}/${path}`, root: this.root, on: this.on ?? null,
      relativePath: path, revision: `${Date.now()}-${this.revision = (this.revision ?? 0) + 1}` };
    writeEditor({ files: state.files.some(f => f.path === id)
      ? state.files.map(f => f.path === id ? file : f) : [...state.files, file], active: id }, group);
    setActiveGroup(group);
    run("layout.show", { id: "editor" });
    this.open = path;
    cx.notify();
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (key() === context) this.note = `Commit failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  row(file, t, active) {
    const parts = file.path.split("/"), name = parts.pop();
    const selected = active === diffKey(this.on, this.root, file.path);
    const mark = file.fresh ? "U" : file.status;
    const color = file.status === "U" || file.status === "D" ? t.ansi1 : file.status === "A" ? t.ansi2 : t.blocked;
    const [glyph, iconColor] = fileIcon(name);
    return h_flex().id(`change-${file.path}`).h(22).flex_none().pl(12).pr(10).gap(5).items_center().cursor_pointer()
      .when(selected, el => el.bg(t.selected)).hover(style => style.bg(selected ? t.selected : t.hover))
      .tooltip(file.path).on_click((_e, cx) => this.pick(file.path, cx))
      .child(div().w(14).flex_none())
      .child(div().w(16).flex_none().flex().justify_center().font_family(ICON_FONT).text_size(14).text_color(iconColor).child(glyph))
      .child(h_flex().flex_1().min_w(0).gap(6).items_center()
        .child(div().flex_shrink_0().max_w(200).truncate().text_color(color).child(name))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(parts.join("/"))))
      .child(div().flex_none().text_size(11).text_color(color).child(mark));
  }

  render(cx) {
    if (!checking() && key() !== this.context) this.refresh(cx);
    const t = theme(), enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    const active = readEditor().active;
    const folder = this.root ?? this.cwd ?? "", name = folder.split("/").filter(Boolean).pop();
    return v_flex().id("changes").size_full().min_h(0).bg(t.chrome).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(35).flex_none().px(20).gap(8).items_center().text_size(11).text_color(t.muted)
        .child(div().child("SOURCE CONTROL"))
        .child(div().flex_1().min_w(0).truncate().child(this.on ? `SSH · ${this.on}` : ""))
        .child(div().id("refresh-changes").w(18).text_size(14).text_color(this.loading ? t.dim : t.muted)
          .cursor_pointer().tooltip("刷新更改").hover(style => style.text_color(t.foreground))
          .on_click((_e, cx) => this.refresh(cx)).child("↻")))
      .child(h_flex().id("changes-root").h(22).flex_none().pl(4).pr(10).gap(4).items_center().cursor_pointer().text_size(11).font_semibold()
        .tooltip(`${this.on ?? "本机"} · ${folder}`)
        .on_click((_e, cx) => { this.rootOpen = !this.rootOpen; cx.notify(); })
        .child(svg(`mods/vsc-changes/chevron-${this.rootOpen ? "down" : "right"}.svg`).size(14).text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(name?.toUpperCase() || "NO FOLDER"))
        .child(div().font_normal().text_color(t.dim).child(String(this.files.length))))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("changes-list").absolute().inset_0().overflow_y_scroll().pb(8)
          .children(this.rootOpen ? this.files.map(file => this.row(file, t, active)) : [])
          .when(this.rootOpen && !this.files.length, el => el.child(div().px(20).py(6).text_size(12).text_color(this.error ? t.ansi1 : t.dim)
            .child(this.error || (this.loading ? "Loading…" : this.root ? "No uncommitted changes" : "No folder")))))
        .child(Scrollbar.vertical("changes-list").absolute().inset_0()))
      .when(this.limited, el => el.child(div().px(20).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .when(Boolean(this.note), el => el.child(div().px(12).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      .child(h_flex().flex_none().px(12).py(8).gap(6).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(28).px(8).flex().items_center().rounded(3).bg(t.background)
          .border_1().border_color(this.typing ? t.accent : t.border).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("commit").h(28).px(10).flex().items_center().rounded(3).border_1().border_color(t.border)
          .bg(enabled ? t.surface : t.chrome).text_color(enabled ? t.foreground : t.dim).text_size(11)
          .tooltip("暂存全部改动并提交")
          .when(enabled, el => el.cursor_pointer().hover(style => style.bg(t.hover)))
          .on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit")));
  }
}
