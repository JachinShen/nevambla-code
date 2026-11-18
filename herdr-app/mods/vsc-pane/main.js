// Native pane chrome with file names and the same split/zoom controls as terminals.
import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, theme, home } from "herdr";
import { filePanes, fileName, splitFile, closeFilePane } from "./files.js";

export default class VscPane extends View {
  button(id, icon, title, action, t) {
    return div().id(id).p(3).rounded(3).cursor_pointer().tooltip(title).text_color(t.dim)
      .hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); action(); })
      .child(svg(`mods/pane/${icon}.svg`).size(14));
  }
  render() {
    const t = theme(), pane = props()?.pane, p = panes().find(p => p.pane === pane);
    if (!p) return div();
    const entry = filePanes().find(e => e.pane === pane), file = entry?.file;
    const name = file ? fileName(file) : ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || "shell";
    const path = file ? file.sourcePath ?? file.path : p.cwd ?? "";
    const cwd = !file?.on && path.startsWith(home() + "/") ? "~" + path.slice(home().length) : path;
    const split = direction => file ? splitFile(pane, direction) : run("pane.split", { pane, direction });
    const pic = p.program?.icon;
    return h_flex().id(`pane-head-${pane}`).size_full().px(10).gap(7).items_center().bg(t.background)
      .border_b(1).border_color(t.border).text_size(12).on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), el => el.child(p.program.tint ? svg(pic).size(14).flex_none().text_color(t.muted) : image(pic).w(14).h(14).flex_none()))
      .child(div().flex_none().max_w(220).truncate().text_color(t.foreground).child(name))
      .when(Boolean(entry?.dirty), el => el.child(div().size(5).flex_none().rounded(3).bg(t.foreground)))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).tooltip(path).child(cwd))
      .child(this.button(`ph-r-${pane}`, "split-right", file ? "Split file right" : "Split terminal right", () => split("right"), t))
      .child(this.button(`ph-d-${pane}`, "split-down", file ? "Split file down" : "Split terminal down", () => split("down"), t))
      .child(this.button(`ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "Zoom pane", () => run("pane.zoom", { pane }), t))
      .child(this.button(`ph-x-${pane}`, "close", "Close pane", () => file ? closeFilePane(pane) : run("pane.close", { pane }), t));
  }
}
