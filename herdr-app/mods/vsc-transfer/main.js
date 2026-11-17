import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { appHome, checking, closeOverlay, exec, home, machines, notify, pickFolder, props, setShared, shared, spaces, theme } from "herdr";

const label = on => on ?? "本机";
const destinationKey = on => on === null ? "local" : `ssh:${on}`;

export default class FileTransfer extends View {
  init(_props, cx) {
    this.source = props()?.source;
    this.error = null;
    if (!this.source || typeof this.source.path !== "string" || !this.source.path.startsWith("/") || !(this.source.on === null || typeof this.source.on === "string")) {
      this.source = { on: null, path: "", name: "未选择文件" };
      if (!checking()) this.error = "未提供有效的源文件，请从文件树点击文件旁的传输按钮";
    }
    this.handle = cx.focus_handle();
    this.busy = false;
    this.saved = null;
    this.copied = false;
    const choices = this.choices();
    this.target = choices.find(machine => machine.name !== this.source.on && machine.layout === "ready")?.name ?? null;
    this.folder = InputState.new({ value: this.defaultFolder(this.target), placeholder: "目标机器上已有目录，例如 ~/Downloads 或 /data" });
    this.folder.on("submit", (_event, cx) => this.primary(cx));
    this.folder.on("change", (_event, cx) => { this.error = null; this.saved = null; this.copied = false; cx.notify(); });
    if (!checking()) this.folder.focus();
  }

  choices() {
    const list = machines();
    return list.some(machine => machine.name === null) ? list : [{ name: null, layout: "ready" }, ...list];
  }

  defaultFolder(on) {
    return shared("vsc.transfer.destinations")?.[destinationKey(on)]
      || spaces().find(space => (space.machine ?? null) === on && space.active)?.folder
      || spaces().find(space => (space.machine ?? null) === on)?.folder
      || (on === null ? home() : "~");
  }

  choose(on, cx) {
    if (this.busy) return;
    this.target = on;
    this.error = null;
    this.saved = null;
    this.copied = false;
    this.folder.set_value(this.defaultFolder(on));
    this.folder.focus();
    cx.notify();
  }

  browse(cx) {
    cx.spawn(async cx => {
      try {
        const folder = await pickFolder({ prompt: "选择传输目标目录" });
        if (folder) { this.folder.set_value(folder); this.error = null; this.saved = null; this.copied = false; }
      } catch (error) { this.error = String(error); }
      cx.notify();
    });
  }

  start(cx) {
    if (this.busy || this.saved) return;
    const folder = this.folder.value().trim(), target = this.target;
    if (!this.source.path) this.error = "请从文件树选择要传输的文件";
    else if (target === this.source.on) this.error = "请选择另一台目标机器";
    else if (!this.choices().some(machine => machine.name === target && machine.layout === "ready")) this.error = "目标机器未连接，请先恢复 SSH 连接";
    else if (!folder) this.error = "请输入目标目录";
    else this.error = null;
    if (this.error) { cx.notify(); return; }
    this.copied = false;
    this.busy = true;
    cx.notify();
    const request = { source_on: this.source.on, source_path: this.source.path, destination_on: target, folder };
    cx.spawn(async cx => {
      try {
        const result = await exec("python3", ["-B", `${appHome()}/mods/vsc-explorer/transfer.py`, JSON.stringify(request)], { timeout: 600000 });
        if (result.code !== 0) throw new Error(result.stderr.trim() || `传输失败，退出码 ${result.code}`);
        const saved = JSON.parse(result.stdout);
        if (saved.on !== target || typeof saved.path !== "string" || !saved.path.startsWith("/") || !Number.isSafeInteger(saved.size) || saved.size < 0 || typeof saved.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(saved.sha256)) throw new Error("传输程序没有返回有效的目标路径和校验信息");
        this.saved = saved;
        const parent = saved.path.slice(0, saved.path.lastIndexOf("/")) || "/";
        setShared("vsc.transfer.destinations", { ...shared("vsc.transfer.destinations"), [destinationKey(target)]: parent });
        setShared("vsc.transfer.completed", { ...saved, folder: parent, token: Date.now() });
        notify({ title: "文件传输完成", body: `${label(target)} · ${saved.path}`, level: "info" });
      } catch (error) {
        this.error = String(error);
        notify({ title: "文件传输失败", body: this.error, level: "error" });
      } finally {
        this.busy = false;
        cx.notify();
      }
    });
  }

  primary(cx) {
    if (this.busy) return;
    if (this.saved) closeOverlay(props().overlay);
    else this.start(cx);
  }

  copyDestination(cx) {
    if (!this.saved) return;
    try {
      cx.write_to_clipboard(this.saved.path);
      this.copied = true;
      this.error = null;
    } catch (error) {
      this.copied = false;
      this.error = `复制目标路径失败：${String(error)}`;
    }
    cx.notify();
  }

  close() { this.folder?.release(); }

  render() {
    const t = theme();
    return v_flex().id("file-transfer").track_focus(this.handle).w_full().min_h(0).p(20).gap(12).bg(t.popover).text_color(t.foreground).text_size(13)
      .on_key_down((event, cx) => {
        if (event.key === "escape") { cx.stop_propagation(); if (!this.busy) closeOverlay(props().overlay); }
      })
      .child(h_flex().items_center().justify_between().child(div().text_size(16).font_semibold().child("传输文件"))
        .child(div().id("transfer-close").px(8).py(4).rounded(4).text_color(t.muted).cursor_pointer().disabled(this.busy)
          .hover(s => s.bg(t.hover)).on_click(() => closeOverlay(props().overlay)).child("关闭")))
      .child(v_flex().gap(3).child(div().font_semibold().truncate().child(this.source.name || this.source.path.split("/").pop()))
        .child(div().text_size(11).text_color(t.muted).truncate().tooltip(this.source.path).child(`来自 ${label(this.source.on)} · ${this.source.path}`)))
      .child(div().text_size(11).text_color(t.muted).child("目标机器"))
      .child(h_flex().flex_wrap().gap(6).children(this.choices().map(machine => {
        const unavailable = machine.name === this.source.on || machine.layout !== "ready";
        return div().id(`target-${destinationKey(machine.name)}`).px(12).py(7).rounded(6).border_1().border_color(machine.name === this.target ? t.accent : t.border)
          .bg(machine.name === this.target ? t.selected : t.surface).text_color(unavailable ? t.dim : t.foreground).cursor_pointer().disabled(this.busy || unavailable)
          .tooltip(machine.name === this.source.on ? "源文件所在机器" : machine.layout !== "ready" ? "机器未连接" : `传到 ${label(machine.name)}`)
          .on_click((_event, cx) => this.choose(machine.name, cx)).child(label(machine.name));
      })))
      .child(h_flex().items_center().justify_between().child(div().text_size(11).text_color(t.muted).child("目标目录"))
        .when(this.target === null, el => el.child(div().id("choose-local-folder").text_size(11).text_color(t.accent).cursor_pointer().disabled(this.busy)
          .on_click((_event, cx) => this.browse(cx)).child("选择文件夹…"))))
      .child(Input.new(this.folder).h(36).px(10).rounded(7).border_1().border_color(t.input).bg(t.background).text_color(t.foreground).text_size(13).disabled(this.busy))
      .child(div().text_size(11).text_color(t.muted).child("重名自动另存，传输后校验完整性。当前支持单个文件。"))
      .when(Boolean(this.error), el => el.child(div().max_h(65).overflow_y_scrollbar().text_size(12).text_color(t.ansi1).child(this.error)))
      .when(Boolean(this.saved), el => el.child(v_flex().gap(5).text_size(12)
        .child(div().text_color(t.ansi2).child(`已完成并校验 · ${label(this.saved.on)}（${this.saved.size.toLocaleString()} 字节）`))
        .child(h_flex().items_center().gap(8)
          .child(div().flex_1().min_w(0).truncate().tooltip(this.saved.path).child(this.saved.path))
          .child(div().id("copy-destination-path").flex_none().px(9).py(5).rounded(5).bg(t.surface).text_color(t.accent).cursor_pointer()
            .hover(s => s.bg(t.hover)).tooltip("复制目标机器上的完整文件路径")
            .on_click((_event, cx) => this.copyDestination(cx)).child(this.copied ? "已复制" : "复制完整路径")))))
      .child(h_flex().items_center().justify_end().gap(8)
        .when(this.busy, el => el.child(svg("mods/workspace-chrome/spinner.svg").size(14).text_color(t.accent).spin(900)))
        .child(div().id("transfer-start").h(32).px(15).flex().items_center().rounded(7).bg(t.solid).text_color(t.solid_foreground).cursor_pointer().disabled(this.busy || (!this.saved && !this.source.path))
          .on_click((_event, cx) => this.primary(cx)).child(this.busy ? "正在传输并校验…" : this.saved ? "完成并关闭 ↵" : "开始传输 ↵")));
  }
}
