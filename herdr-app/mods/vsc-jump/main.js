import { View, div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { checking, closeOverlay, exec, props, run, setShared, spaces, panes, focused, theme } from "herdr";
import { targetGroup, readEditor, writeEditor } from "./editor-state.js";

// Herdr isolates each mod's imports. Keep the shared-state source signature
// ({cwd, on}) identical to the Explorer's navigation module.
function terminalLocation() {
  const space = spaces().find(s => s.active), focus = focused();
  const pane = focus?.pane ? panes().find(p => p.pane === focus.pane) : null;
  const on = focus?.pane === null && focus.terminal
    ? (focus.terminal.includes("/") ? focus.terminal.split("/")[0] : null)
    : space?.machine ?? null;
  return { cwd: pane?.cwd || focus?.cwd || space?.folder, on };
}

export const RESOLVE_PATH = String.raw`
import json, os, re, shlex, socket, sys
from urllib.parse import urlsplit, unquote
try:
    text, cwd = sys.argv[1].strip(), sys.argv[2]
    if not text or len(text) > 4096 or any(ord(c) < 32 or ord(c) == 127 for c in text):
        raise ValueError("请输入一个文件或目录路径")
    if len(text) > 1 and text[0] == text[-1] and text[0] in "\"'\x60":
        text = text[1:-1]
    if text.startswith("file://"):
        url = urlsplit(text)
        if url.netloc not in ("", "localhost", socket.gethostname(), socket.getfqdn()):
            raise ValueError("file:// 链接属于另一台机器，请先切换到对应的终端")
        text = unquote(url.path)
    def absolute(value):
        value = os.path.expanduser(value)
        return os.path.abspath(value if os.path.isabs(value) else os.path.join(cwd, value))
    path = absolute(text)
    if not os.path.exists(path):
        match = re.fullmatch(r"(.+?):[1-9][0-9]*(?::[1-9][0-9]*)?", text)
        if match:
            path = absolute(match.group(1))
        elif "\\" in text:
            words = shlex.split(text)
            if len(words) == 1:
                path = absolute(words[0])
    if not os.path.exists(path):
        raise FileNotFoundError("路径不存在：" + path)
    directory = os.path.isdir(path)
    if not directory and not os.path.isfile(path):
        raise ValueError("该路径不是普通文件或目录：" + path)
    print(json.dumps({"path": path, "folder": path if directory else os.path.dirname(path), "directory": directory}, ensure_ascii=False))
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
`;

export default class PathJump extends View {
  init(_props, cx) {
    this.source = terminalLocation();
    this.space = spaces().find(s => s.active)?.id;
    const clipboard = checking() ? "" : cx.read_from_clipboard() ?? "";
    const path = clipboard.length <= 4096 && !/[\r\n\0]/.test(clipboard) && /^(?:["'`]?\/?~?\/|\.{1,2}\/|file:\/\/)/.test(clipboard) ? clipboard : "";
    this.input = InputState.new({ value: path, placeholder: "输入文件或目录路径，支持 /、~/ 和 ./" });
    this.input.on("submit", (_event, cx) => this.submit(cx));
    this.input.on("change", (_event, cx) => { this.error = null; cx.notify(); });
    this.handle = cx.focus_handle();
    this.busy = false;
    this.error = null;
    if (!checking()) {
      if (path) this.input.set_selected_range({ start: 0, end: path.length });
      this.input.focus();
    }
  }

  submit(cx) {
    if (this.busy) return;
    const path = this.input.value().trim();
    if (!path) { this.error = "请输入文件或目录路径"; cx.notify(); return; }
    if (!this.source.cwd) { this.error = "无法确定终端当前目录，请先聚焦目标终端后重试"; cx.notify(); return; }
    const group = targetGroup();
    this.busy = true;
    this.error = null;
    cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await exec("python3", ["-c", RESOLVE_PATH, path, this.source.cwd], { on: this.source.on });
        if (result.code !== 0) throw new Error(result.stderr.trim() || `路径检查失败，退出码 ${result.code}`);
        const resolved = JSON.parse(result.stdout);
        if (typeof resolved.path !== "string" || !resolved.path.startsWith("/") || typeof resolved.folder !== "string" || typeof resolved.directory !== "boolean") throw new Error("路径检查未返回有效的文件信息");
        if (spaces().find(s => s.active)?.id !== this.space) throw new Error("当前工作区已切换，请在目标终端重新打开路径跳转");
        if (!resolved.directory) {
          const editor = readEditor(group, this.space);
          if (editor.files.some(file => file.path === resolved.path && (file.on ?? null) !== this.source.on)) throw new Error("该路径已在另一台机器的编辑标签页中打开，请先关闭那个标签页后重试");
          const files = editor.files.some(file => file.path === resolved.path) ? editor.files : [...editor.files, { path: resolved.path, root: resolved.folder, on: this.source.on }];
          writeEditor({ files, active: resolved.path }, group, this.space);
        }
        setShared("vsc.explorer.jump", { source: JSON.stringify(this.source), folder: resolved.folder, file: resolved.directory ? null : resolved.path, token: Date.now() });
        run("layout.show", { id: "side" });
        run("layout.select", { stack: "side-body", child: "explorer" });
        closeOverlay(props().overlay);
      } catch (error) {
        this.busy = false;
        this.error = String(error);
        cx.notify();
      }
    });
  }

  close() { this.input?.release(); }

  render() {
    const t = theme();
    return v_flex().id("path-jump").track_focus(this.handle).w_full().min_h(0).p(18).gap(10).bg(t.popover).text_color(t.foreground)
      .on_key_down((event, cx) => { if (event.key === "escape") { cx.stop_propagation(); closeOverlay(props().overlay); } })
      .child(h_flex().items_center().justify_between().child(div().text_size(15).font_semibold().child("跳转到路径"))
        .child(div().text_size(11).text_color(t.muted).child("⌘⇧O · Esc 关闭")))
      .child(div().text_size(11).text_color(t.muted).truncate().tooltip(this.source.cwd ?? "").child(`${this.source.on ? `SSH · ${this.source.on}` : "本机"} · ${this.source.cwd ?? "未找到终端目录"}`))
      .child(Input.new(this.input).h(36).px(10).rounded(8).border_1().border_color(t.input).bg(t.background).text_color(t.foreground).text_size(13).disabled(this.busy))
      .child(div().text_size(11.5).text_color(t.muted).child("文件在编辑器打开，目录在左侧文件树定位。"))
      .when(Boolean(this.error), element => element.child(div().max_h(65).overflow_y_scrollbar().text_size(12).text_color(t.ansi1).child(this.error)))
      .child(h_flex().justify_end().child(div().id("jump-open").h(31).px(14).flex().items_center().rounded(7).bg(t.solid).text_color(t.solid_foreground)
        .text_size(12).cursor_pointer().disabled(this.busy).on_click((_event, cx) => this.submit(cx)).child(this.busy ? "正在查找…" : "打开 ↵")));
  }
}
