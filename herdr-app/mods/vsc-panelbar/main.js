// One strip for native Herdr tabs, including file and terminal panes.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, ScrollHandle, Popover } from "gpui-base";
import { theme, run, spaces, panes, focused, checking, openOverlay, shared, setShared } from "herdr";
import { filePanes, openFile, closeFileTab, closeOtherFiles } from "./files.js";
import { readEditor } from "./legacy-files.js";

const DOT = { working: "#39c67a", blocked: "#ef5b5b", done: "#4c9dff" };
const migrationKey = space => `vsc.files.migrated:${encodeURIComponent(space)}`;

export default class VscPanelbar extends View {
  init(_p, cx) {
    this.scroll = ScrollHandle.new();
    this.menuHandle = cx.focus_handle();
    this.migrations = new Set(); this.errors = new Map();
  }
  migrate(space, cx) {
    if (!space || checking() || shared(migrationKey(space)) || this.migrations.has(space) || this.errors.has(space)) return;
    this.migrations.add(space);
    cx.spawn(async cx => {
      try {
        // Validate both saved groups before creating anything; leave source lists intact.
        const files = [...readEditor(1, space).files, ...readEditor(2, space).files];
        for (const file of files) await openFile(file, { space, focus: false });
        setShared(migrationKey(space), true);
      } catch (e) { this.errors.set(space, `Could not restore file tabs: ${e.message ?? e}`); }
      finally { this.migrations.delete(space); cx.notify(); }
    });
  }
  icon(id, file, title, action) {
    const t = theme();
    return div().id(id).size(28).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer().tooltip(title)
      .text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).on_click(action)
      .child(svg(`mods/vsc-panelbar/${file}.svg`).size(16));
  }
  tab(tab, space, files, t) {
    const parts = panes().filter(p => p.tab === tab.id), entries = files.filter(e => e.tab === tab.id);
    const fileOnly = parts.length > 0 && parts.every(p => p.mod === "vsc-editor") && entries.length === parts.length;
    const dirty = entries.some(e => e.dirty);
    const button = h_flex().id(`pt-${tab.id}`).flex_none().w(160).h_full().pl(14).pr(6).gap(6).items_center().cursor_pointer().relative()
      .border_r(1).border_color(t.border).bg(tab.active ? t.surface : t.chrome)
      .text_color(tab.active ? t.foreground : t.muted).hover(s => s.bg(tab.active ? t.surface : t.hover).text_color(t.foreground))
      .tooltip(`${tab.name} · 双击重命名 · 右键菜单`)
      .on_click(() => run("tab.select", { id: tab.id }))
      .on_mouse_down("left", e => { if (e.click_count === 2) run("tab.rename", { id: tab.id }); })
      .on_mouse_down("middle", () => closeFileTab(tab.id))
      .when(!fileOnly, el => el.on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: tab.id, space: space.id } } });
      }))
      .when(Boolean(DOT[tab.status]), el => el.child(div().size(6).flex_none().rounded(3).bg(DOT[tab.status])))
      .child(div().flex_1().min_w(0).truncate().when(tab.active, el => el.font_semibold()).child(tab.name))
      .when(fileOnly, el => el.child(div().id(`close-${tab.id}`).size(20).flex_none().flex().items_center().justify_center().rounded(3)
        .hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); closeFileTab(tab.id); })
        .child(dirty ? div().size(6).rounded(3).bg(t.foreground) : svg("mods/vsc-panelbar/x.svg").size(13))))
      .when(tab.active, el => el.child(div().absolute().left(0).right(0).bottom(0).h(2).bg(t.accent)));
    if (!fileOnly) return button;
    const items = [["Rename", () => run("tab.rename", { id: tab.id })],
      ["Close", () => closeFileTab(tab.id)], ["Close Others", () => closeOtherFiles(tab.id, space.id)]];
    const choose = (i, cx) => { this.menu = null; if (spaces().some(s => s.active && s.id === space.id && s.tabs.some(t => t.id === tab.id))) items[i]?.[1](); cx.notify(); };
    return Popover.new(`tab-menu-${tab.id}`).mouse_button("right").anchor("bottom_left").track_focus(this.menuHandle)
      .open(this.menu === tab.id).on_open_change((open, cx) => { this.menu = open ? tab.id : null; this.menuAt = 0; cx.notify(); })
      .trigger(button).content(v_flex().w(190).p(5).bg(t.popover).text_size(12.8)
        .on_key_down((e, cx) => {
          if (e.key === "down") this.menuAt = ((this.menuAt ?? 0) + 1) % items.length;
          else if (e.key === "up") this.menuAt = ((this.menuAt ?? 0) + items.length - 1) % items.length;
          else if (e.key === "enter") choose(this.menuAt ?? 0, cx);
          else return;
          cx.stop_propagation(); cx.notify();
        }).children(items.map(([label], i) => div().id(`tab-action-${i}`).h(31).px(8).flex().items_center().rounded(4)
          .text_color(t.foreground).when(i === (this.menuAt ?? 0), el => el.bg(t.selected)).hover(s => s.bg(t.hover))
          .cursor_pointer().on_click((_e, cx) => choose(i, cx)).child(label))));
  }
  render(cx) {
    const t = theme(), space = spaces().find(s => s.active);
    this.migrate(space?.id, cx);
    const tabs = (space?.tabs ?? []).filter(x => !x.settled || x.active), files = filePanes(space?.id);
    const active = tabs.findIndex(tab => tab.active), selected = tabs[active]?.id;
    if (selected !== this.selected || active !== this.selectedIndex) {
      this.selected = selected; this.selectedIndex = active;
      if (active >= 0) this.scroll.scroll_to_item(active);
    }
    const pane = focused()?.pane;
    return v_flex().size_full().min_h(0)
      .child(h_flex().id("panelbar").flex_1().min_h(0).w_full().min_w(0).items_center().bg(t.chrome).text_size(14).border_b(1).border_color(t.border)
        .child(h_flex().id("ptabs").flex_1().min_w(0).h_full().items_center().overflow_x_scrollbar().mode("always").track_scroll(this.scroll)
          .on_size_change((_size, cx) => { if (active >= 0) { this.scroll.scroll_to_item(active); cx.notify(); } })
          .children(tabs.map(tab => this.tab(tab, space, files, t)))
          .child(this.icon("p-new", "plus", "New terminal", () => run("tab.new", { space: space.id }))))
        .when(Boolean(this.errors.get(space?.id)), el => el.child(div().id("restore-files").px(8).text_size(11).text_color(t.ansi1)
          .tooltip(this.errors.get(space.id)).cursor_pointer().on_click((_e, cx) => { this.errors.delete(space.id); this.migrate(space.id, cx); }).child("Restore files · Retry")))
        .child(h_flex().flex_none().px(8).gap(4).items_center()
          .when(Boolean(pane), el => el
            .child(this.icon("p-split-right", "split", "Split terminal right", () => run("pane.split", { pane, direction: "right" })))
            .child(this.icon("p-split-down", "panel-bottom", "Split terminal down", () => run("pane.split", { pane, direction: "down" })))
            .child(this.icon("p-zoom", "maximize", "Zoom pane ⌘J", () => run("pane.zoom", { pane }))))));
  }
}
