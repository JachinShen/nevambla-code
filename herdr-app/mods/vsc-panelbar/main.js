// Terminal tabs start on the left, with panel actions on the right.
import { View, div, svg } from "gpui-kit";
import { h_flex, ScrollHandle } from "gpui-base";
import { theme, run, spaces, layout, nextCommand, checking, openOverlay } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) { const f = find(c, id); if (f) return f; }
  return null;
}
const DOT = { working: "working", blocked: "blocked", done: "done" };

// The editor and the terminals share "work": a column puts the panel at the
// bottom, a row puts it on the right. Flipping rewrites this personal layout.
const onRight = () => find(layout(), "work")?.type === "row";
function flip() {
  const tree = JSON.parse(JSON.stringify(layout())), work = find(tree, "work");
  if (!work) return;
  work.type = work.type === "row" ? "column" : "row";
  run("layout.set", { layout: tree });
  run(work.type === "row" ? "vsc-editor.wrap" : "vsc-editor.nowrap");
}

export default class VscPanelbar extends View {
  init(_p, cx) {
    this.scroll = ScrollHandle.new();
    if (checking()) return;
    cx.spawn(async cx => { for (;;) { if (await nextCommand() === "flip") flip(); cx.notify(); } });
  }

  icon(id, file, title, action) {
    const t = theme();
    return div().id(id).size(28).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer().tooltip(title)
      .text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).on_click(action)
      .child(svg(`mods/vsc-panelbar/${file}.svg`).size(16));
  }

  render() {
    const t = theme(), space = spaces().find(s => s.active);
    const tabs = (space?.tabs ?? []).filter(x => !x.settled || x.active);
    const active = tabs.findIndex(tab => tab.active), selected = tabs[active]?.id;
    if (selected !== this.selected || active !== this.selectedIndex) {
      this.selected = selected;
      this.selectedIndex = active;
      if (active >= 0) this.scroll.scroll_to_item(active);
    }
    const maximized = find(layout(), "editor")?.hidden;
    return h_flex().id("panelbar").size_full().min_w(0).items_center().bg(t.chrome).text_size(14).border_b(1).border_color(t.border)
      .child(h_flex().id("ptabs").flex_1().min_w(0).h_full().items_center().overflow_x_scroll().track_scroll(this.scroll)
        .on_size_change((_size, cx) => { if (active >= 0) { this.scroll.scroll_to_item(active); cx.notify(); } })
        .children(tabs.map(x => h_flex().id(`pt-${x.id}`).flex_none().w(160).h_full().px(16).gap(8).items_center().cursor_pointer().relative()
          .border_r(1).border_color(t.border).bg(x.active ? t.surface : t.chrome)
          .text_color(x.active ? t.foreground : t.muted).hover(s => s.bg(x.active ? t.surface : t.hover).text_color(t.foreground))
          .tooltip(`${x.name} · 双击重命名 · 右键菜单`)
          .on_click(() => run("tab.select", { id: x.id }))
          // Double-click renames, like Herdr's own tab bar (F2 renames the shown tab).
          .on_mouse_down("left", (e) => { if (e.click_count === 2) run("tab.rename", { id: x.id }); })
          .on_mouse_down("right", (_e, cx) => {
            cx.stop_propagation();
            openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: x.id, space: space.id } } });
          })
          .when(Boolean(DOT[x.status]), el => el.child(div().size(6).flex_none().rounded(3).bg(t[DOT[x.status]])))
          .child(div().flex_1().min_w(0).truncate().when(x.active, el => el.font_semibold()).child(x.name))
          .when(x.active, el => el.child(div().absolute().left(0).right(0).bottom(0).h(2).bg(t.accent)))))
        .child(this.icon("p-new", "plus", "New terminal", () => run("tab.new"))))
      .child(h_flex().flex_none().px(8).gap(4).items_center()
        .child(this.icon("p-split", "split", "Split", () => run("pane.split", { direction: onRight() ? "down" : "right" })))
        .child(this.icon("p-pos", onRight() ? "panel-bottom" : "panel-right", "Move panel", () => flip()))
        .child(this.icon("p-max", maximized ? "chevron-down" : "chevron-up", "Maximize", () => run("layout.toggle", { id: "editor" }))));
  }
}
