// A single file in a native Herdr pane. Tabs, splits and Space persistence belong to Herdr.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { Notebook } from "./notebook.js";
import { Pdf } from "./pdf.js";
import { GitDiff } from "./diff.js";
import { ImagePreview, isImage } from "./image-preview.js";
import { sourceLanguage } from "./source-syntax.js";
import { SourcePreview } from "./source-preview.js";
import { theme, readTextFile, writeTextFile, nextCommand, exec, run, spaces, panes, props, checking, shared, setShared, appHome } from "herdr";
import { registerFile, setFileDirty, bufferKey, closeFilePane } from "./files.js";

const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", cjs: "js", toml: "yaml", yml: "yaml",
  jsonc: "json", svelte: "html", vue: "html", astro: "html", htm: "html", sh: "bash", zsh: "bash", py: "python", rs: "rust",
  md: "markdown", h: "c", hpp: "cpp", cc: "cpp" };
// VS Code Dark Modern token colors.
const SYNTAX = { keyword: "#c586c0", string: "#ce9178", "string.escape": "#d7ba7d", comment: "#6a9955", function: "#dcdcaa",
  type: "#4ec9b0", number: "#b5cea8", constant: "#4fc1ff", boolean: "#569cd6", variable: "#9cdcfe", operator: "#d4d4d4", punctuation: "#d4d4d4" };
const ext = p => { const n = p.split("/").pop(); return n.includes(".") ? n.split(".").pop().toLowerCase() : ""; };
const base = p => p.split("/").pop();
// Code font for files, notebook cells and outputs (ships with Herdr).
const CODE_FONT = "JetBrains Mono";
const isMd = p => ["md", "markdown", "mdx"].includes(ext(p));

export default class VscEditor extends View {
  init(_props, cx) {
    this.pane = null;
    this.file = props()?.file;
    this.wrap = false;
    this.handle = cx.focus_handle();
    if (checking()) return;
    cx.timer.every(300, cx => { if (this.doc?.nb?.kernel.state !== "off" && this.doc?.nb) cx.spawn(async cx => this.doc.nb.poll(cx)); });
    cx.timer.every(10000, cx => { if (this.visible()) this.doc?.diff?.refresh(cx); });
    cx.timer.every(600, cx => {
      if (this.visible() && this.doc?.pdf && !this.doc.pdf.done) cx.spawn(async cx => {
        try { if (await this.doc.pdf.poll()) cx.notify(); }
        catch (e) { this.doc.error = String(e); this.doc.pdf = null; cx.notify(); }
      });
    });
    cx.spawn(async cx => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") { this.handle.focus(); continue; }
        if (!panes().some(p => p.pane === this.pane && p.focused)) continue;
        if (c === "save") await this.save(cx);
        if (c === "close") closeFilePane(this.pane);
        if (c === "runfile") await this.runPython(cx);
        if (c === "preview") this.togglePreview(this.doc);
        if (c === "run") { const nb = this.doc?.nb; if (nb?.focused) await nb.run(nb.focused, cx); }
        cx.notify();
      }
    });
  }
  attach(cx) {
    const raw = props()?.preview_pane;
    const candidates = raw ? panes().filter(p => p.mod === "vsc-editor" && p.pane.split("/").pop() === raw) : [];
    if (candidates.length > 1) throw new Error("Native file pane ID is ambiguous across connected machines");
    if (candidates.length === 1) { this.pane = candidates[0].pane; return true; }
    if (!this.binding && !this.bindingError && !this.bindingDone) {
      this.binding = true;
      const on = spaces().find(s => s.active)?.machine ?? null;
      cx.spawn(async cx => {
        try {
          const result = await exec("python3", ["-B", `${appHome()}/mods/vsc-editor/bind-panes.py`, JSON.stringify({ on })]);
          if (result.code !== 0) throw new Error(result.stderr.trim() || "Could not attach native file pane metadata");
          const receipt = JSON.parse(result.stdout);
          if (!Number.isInteger(receipt.bound) || receipt.bound < 0) throw new Error("Invalid pane metadata receipt");
          this.bindingDone = true;
          cx.timer.after(2000, cx => {
            if (!props()?.preview_pane) this.bindingError = "Herdr did not apply the file pane metadata. Retry to reconnect this preview.";
            cx.notify();
          });
        } catch (e) { this.bindingError = String(e.message ?? e); }
        finally { this.binding = false; cx.notify(); }
      });
    }
    return false;
  }
  visible() {
    const p = panes().find(p => p.pane === this.pane), s = spaces().find(s => s.active);
    return Boolean(p && s?.tabs.some(t => t.id === p.tab && t.active)
      && (!s.tabs.find(t => t.active)?.zoomed || p.zoomed));
  }
  persistBuffer() {
    const d = this.doc;
    if (!d || (!d.code && !d.nb?.nb) || !this.space) return;
    const key = bufferKey(this.space, this.file);
    const saved = d.dirty ? { text: d.nb ? d.nb.toJSON() : d.code.value(), original: d.original ?? d.nb.original,
      kind: d.nb ? "notebook" : "text", owner: this.pane } : null;
    // Native splits can hold distinct edits. Each pane retains its own recovery copy;
    // a clean sibling must never erase another pane's unsaved file buffer.
    setShared(bufferKey(this.space, this.file, this.pane), saved);
    if (saved || shared(key)?.owner === this.pane) setShared(key, saved);
  }

  // The wrap setting is fixed per editor state, so a change rebuilds it with the current text.
  build(doc, text, wrap) {
    doc.code?.release();
    const e = ext(doc.file.path);
    doc.wrap = wrap;
    const language = sourceLanguage(doc.file.path);
    if (language) {
      doc.sourcePreview ??= new SourcePreview(doc.file, language, SYNTAX, CODE_FONT);
      doc.preview ??= true;
      if (doc.preview) doc.sourcePreview.update(text);
    }
    doc.code = EditorState.new({ language: language ? "txt" : LANG[e] ?? e ?? "txt", value: text, readonly: Boolean(doc.file.on), soft_wrap: wrap,
      font_family: CODE_FONT, font_size: 13, syntax: SYNTAX });
    doc.code.on("change", (_e, cx) => { const d = doc.code.value() !== doc.original; doc.dirty = d; this.persistBuffer(); setFileDirty(this.pane, d); cx.notify(); });
  }

  togglePreview(doc) {
    if (!doc?.code || (!isMd(doc.file.path) && !doc.sourcePreview)) return;
    doc.preview = !doc.preview;
    if (doc.preview) doc.sourcePreview?.update(doc.code.value());
  }

  load(f, cx) {
    const doc = { file: f, code: null, original: null, dirty: false, error: null };
    this.doc = doc;
    if (f.kind === "diff") { doc.diff = new GitDiff(f); doc.diff.refresh(cx); return; }
    cx.spawn(async cx => {
      try {
        const saved = shared(bufferKey(this.space, f, this.pane)) ?? shared(bufferKey(this.space, f));
        if (saved != null && (typeof saved.text !== "string" || typeof saved.original !== "string"
          || !["text", "notebook"].includes(saved.kind))) throw new Error("Invalid saved unsaved buffer; it has been left unchanged");
        if (saved && (saved.kind === "notebook") !== (ext(f.path) === "ipynb")) throw new Error("Saved buffer does not match this file's format; it has been left unchanged");
        if (isImage(f.path)) {
          doc.image = new ImagePreview(f);
          await doc.image.load();
        } else if (ext(f.path) === "pdf") {
          doc.pdf = new Pdf(f);
          await doc.pdf.load();
        } else if (ext(f.path) === "ipynb") {
          doc.nb = new Notebook(f, { instance: this.pane, syntax: SYNTAX, font: CODE_FONT, onDirty: () => {
            doc.dirty = true; this.persistBuffer(); setFileDirty(this.pane, true);
          } });
          await doc.nb.load(saved?.kind === "notebook" ? saved : null);
          doc.dirty = saved?.kind === "notebook";
        } else {
          const text = await readTextFile(f.path, { on: f.on });
          if (text === null) throw new Error("This file is no longer available");
          if (text.includes("\0")) throw new Error("This file is binary and can't be shown");
          doc.original = saved?.kind === "text" ? saved.original : text;
          this.build(doc, saved?.kind === "text" ? saved.text : text, this.wrap);
          doc.dirty = doc.code.value() !== doc.original;
        }
        if (saved) this.notice = "Recovered unsaved changes. Save to write them to the file.";
        if (doc.dirty) this.persistBuffer();
        setFileDirty(this.pane, doc.dirty);
      } catch (e) {
        doc.error = `Can't open this file: ${e.message ?? e}`;
        doc.pdf = null; doc.nb?.release(); doc.nb = null; doc.image = null;
      }
      cx.notify();
    });
  }
  async save(cx) {
    const doc = this.doc;
    if (!doc?.dirty) return true;
    try {
      if (doc.file.on) throw new Error("Saving remote files is not supported by this version of Herdr");
      if (doc.nb) await doc.nb.save();
      else if (doc.code) {
        const text = doc.code.value();
        await writeTextFile(doc.file.path, text, doc.original);
        doc.original = text;
        doc.dirty = doc.code.value() !== text;
      } else throw new Error("The file is not ready to save");
      if (doc.nb) doc.dirty = doc.nb.dirty;
      doc.saveError = null; this.notice = null;
      this.persistBuffer(); setFileDirty(this.pane, doc.dirty);
      return !doc.dirty;
    } catch (e) { doc.saveError = `Not saved: ${e.message ?? e}`; return false; }
    finally { cx.notify(); }
  }
  async runPython(cx) {
    const doc = this.doc;
    if (!doc || ext(doc.file.path) !== "py") return;
    try {
      if (!await this.save(cx)) return;
      const file = doc.file, space = spaces().find(s => s.id === this.space);
      if (!space || (space.machine ?? null) !== (file.on ?? null)) throw new Error("Open this file in a Space on its source machine before running it");
      const folder = file.path.slice(0, file.path.lastIndexOf("/"));
      const find = 'd="$1"; while [ "$d" != "/" ] && [ -n "$d" ]; do [ -x "$d/.venv/bin/python" ] && { echo "$d/.venv/bin/python"; exit 0; }; d=$(dirname "$d"); done; command -v python3';
      const result = await exec("sh", ["-c", find, "find", folder], { on: file.on });
      if (result.code !== 0 || !result.stdout.trim()) throw new Error(result.stderr.trim() || "Python was not found");
      run("tab.new", { space: this.space, name: `▶ ${base(file.path)}`, folder, argv: [result.stdout.trim(), file.path] });
    } catch (e) { doc.saveError = `Not run: ${e.message ?? e}`; cx.notify(); }
  }
  async close() {
    this.persistBuffer();
    this.doc?.code?.release();
    this.doc?.nb?.release();
    if (this.doc?.nb) await this.doc.nb.shutdown();
  }

  // Rendered Markdown, GitHub style: a readable centered column over the live text.
  markdown(doc, t) {
    return v_flex().id("md-scroll").flex_1().min_h(0).overflow_y_scrollbar().bg(t.background)
      .child(div().w_full().max_w(900).mx_auto().px(40).py(28).text_size(15).text_color(t.foreground)
        .child(TextView.markdown(`md-${doc.file.path}`, doc.code.value())));
  }

  render(cx) {
    const t = theme();
    if (checking()) return div().size_full().bg(t.background).child("File preview");
    if (!this.attach(cx)) return v_flex().size_full().p(16).gap(10).text_color(this.bindingError ? t.ansi1 : t.muted)
      .child(this.bindingError ?? "Connecting file preview…")
      .when(Boolean(this.bindingError), el => el.child(div().id("retry-pane").w(64).h(28).cursor_pointer()
        .on_click((_e, cx) => { this.bindingError = null; this.bindingDone = false; cx.notify(); }).child("Retry")));
    const entry = registerFile(this.file, this.pane);
    this.space = entry.space;
    this.file = entry.file;
    if (!this.doc && this.visible()) this.load(this.file, cx);
    const doc = this.doc, f = this.file;
    if (doc?.diff && doc.file.revision !== f.revision && this.visible()) {
      doc.file = f; doc.diff.refresh(cx);
    }
    const display = f.sourcePath ?? f.path;
    const rel = display.startsWith(f.root + "/") ? display.slice(f.root.length + 1) : display;
    return v_flex().id("file-preview").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .child(h_flex().h(26).flex_none().px(14).gap(4).items_center().text_size(12).text_color(t.muted)
        .tooltip(`${f.on ? `SSH · ${f.on} · ` : ""}${display}`)
        .child(div().flex_1().min_w(0).truncate().child(rel))
        .when(Boolean(f.on), el => el.child(div().text_size(11).child(`SSH · ${f.on} · Read only`)))
        .when(Boolean(doc?.dirty), el => el.child(div().text_size(11).child("Unsaved")))
        .child(div().id("copy-file-path").h(22).px(8).flex().items_center().cursor_pointer().tooltip("Copy full path")
          .hover(s => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => cx.write_to_clipboard(display)).child("Copy path")))
      .when(Boolean(doc?.sourcePreview || doc?.code && (isMd(f.path) || ext(f.path) === "py")), el => el.child(h_flex().h(26).flex_none().px(14).gap(4).items_center().text_size(12).text_color(t.muted)
        .when(ext(f.path) === "py" && Boolean(doc?.code), el => el.child(div().flex_1()).child(
          div().id("py-run").h(22).px(8).gap(6).flex().items_center().rounded(4).cursor_pointer().text_color(t.ansi10)
            .hover(st => st.bg(t.hover))
            .on_click((_e, cx) => { cx.spawn(async cx => this.runPython(cx)); })
            .child("▶ Run").child(div().text_color(t.dim).child("⌥⌘R"))))
        .when(Boolean(doc?.sourcePreview), el => el.child(div().flex_1()).child(
          div().text_size(11).text_color(t.dim).child(`${doc.sourcePreview.language.name} · ${doc.preview ? "Read only" : "Plain text"}`)))
        .when(Boolean(doc?.sourcePreview) && doc.preview, el => el.child(
          div().id("source-copy").h(22).px(8).flex().items_center().rounded(4).cursor_pointer().tooltip("Copy the complete source")
            .hover(st => st.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => cx.write_to_clipboard(doc.code.value())).child("Copy")))
        .when((isMd(f.path) || Boolean(doc?.sourcePreview)) && Boolean(doc?.code), el => el.when(!doc.sourcePreview, el => el.child(div().flex_1())).child(
          div().id("md-preview").h(22).px(8).flex().items_center().rounded(4).cursor_pointer()
            .bg(doc.preview ? t.selected : t.background).text_color(doc.preview ? t.foreground : t.muted)
            .hover(st => st.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { this.togglePreview(doc); cx.notify(); })
            .child(doc.preview ? "Edit  ⇧⌘V" : "Preview  ⇧⌘V")))))
      .when(Boolean(doc?.saveError), el => el.child(div().px(14).py(4).text_size(12).text_color(t.ansi1).child(doc.saveError)))
      .when(Boolean(this.notice), el => el.child(div().px(14).py(4).text_size(12).text_color(t.muted).child(this.notice)))
      .child(doc?.error ? v_flex().flex_1().p(16).gap(10).text_color(t.ansi1).child(doc.error)
        .child(div().id("retry-file").w(64).h(28).flex().items_center().justify_center().rounded(4)
          .text_color(t.foreground).bg(t.surface).cursor_pointer().hover(s => s.bg(t.hover))
          .on_click((_event, cx) => { doc.code?.release(); this.load(f, cx); cx.notify(); }).child("Retry"))
        : doc?.diff ? doc.diff.render(t)
        : doc?.image ? div().flex_1().min_h(0).child(doc.image.render(t))
        : doc?.pdf ? div().flex_1().min_h(0).child(doc.pdf.render(t))
        : doc?.nb ? div().flex_1().min_h(0).child(doc.nb.render(t))
        : doc?.code && doc.preview ? (doc.sourcePreview ? doc.sourcePreview.render(t) : this.markdown(doc, t))
        : doc?.code ? Editor.new(doc.code).flex_1().min_h(0)
        : div().flex_1().p(16).text_color(t.dim).child("Loading…"));
  }
}
