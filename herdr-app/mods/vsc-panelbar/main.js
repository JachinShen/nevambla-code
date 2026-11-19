// One strip for native Herdr tabs, including file and terminal panes.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, ScrollHandle, Scrollbar, Popover } from "gpui-base";
import { theme, run, spaces, panes, focused, checking, openOverlay, shared, setShared } from "herdr";
import { filePanes, openFile, closeFileTab, closeOtherFiles } from "./files.js";
import { readEditor } from "./legacy-files.js";

const DOT_STATUSES = new Set(["working", "blocked", "done"]);
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
  actionMenu(id, trigger, items, mouseButton = "left") {
    const t = theme();
    const choose = (index, cx) => {
      this.menu = null;
      items[index]?.[1]();
      cx.notify();
    };
    return Popover.new(id).mouse_button(mouseButton).anchor("bottom_left").track_focus(this.menuHandle)
      .open(this.menu === id).on_open_change((open, cx) => {
        if (open) {
          this.menu = id;
          this.menuAt = 0;
        } else if (this.menu === id) this.menu = null;
        cx.notify();
      })
      .trigger(trigger).content(v_flex().role("menu").w(190).p(5).bg(t.popover).text_size(12.8)
        .on_key_down((e, cx) => {
          if (e.key === "down") this.menuAt = ((this.menuAt ?? 0) + 1) % items.length;
          else if (e.key === "up") this.menuAt = ((this.menuAt ?? 0) + items.length - 1) % items.length;
          else if (e.key === "enter") choose(this.menuAt ?? 0, cx);
          else return;
          cx.stop_propagation(); cx.notify();
        }).children(items.map(([label], i) => div().id(`${id}-action-${i}`).role("menu_item").h(31).px(8).flex().items_center().rounded(4)
          .text_color(t.foreground).when(i === (this.menuAt ?? 0), el => el.bg(t.selected).aria_active_descendant()).hover(s => s.bg(t.hover))
          .cursor_pointer().on_click((_e, cx) => choose(i, cx)).child(label))));
  }
  newTerminalControls(space, pane, t) {
    const button = (id, width, icon, size, label) => div().id(id).w(width).h(28).flex_none().flex().items_center().justify_center()
      .rounded(4).cursor_pointer().role("button").accessibility_label(label).tooltip(label)
      .text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .child(svg(`mods/vsc-panelbar/${icon}.svg`).size(size));
    return h_flex().id("new-terminal-controls").flex_none().items_center()
      .child(button("p-new", 28, "plus", 16, "New terminal tab")
        .on_click(() => run("tab.new", space ? { space: space.id } : {})))
      .when(Boolean(pane), el => el.child(this.actionMenu(`split-terminal-${pane}`,
        button("p-new-menu", 20, "chevron-down", 12, "New terminal beside this pane"),
        [["New terminal to the right", () => run("pane.split", { pane, direction: "right" })],
          ["New terminal below", () => run("pane.split", { pane, direction: "down" })]])));
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
      .when(DOT_STATUSES.has(tab.status), el => el.child(div().size(6).flex_none().rounded(3).bg(t[tab.status])))
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
    return this.actionMenu(`tab-menu-${tab.id}`, button, items.map(([label, action]) => [label, () => {
      if (spaces().some(s => s.active && s.id === space.id && s.tabs.some(t => t.id === tab.id))) action();
    }]), "right");
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
        .child(div().flex_1().min_w(0).h_full().relative()
          .child(h_flex().id("ptabs").w_full().min_w(0).h_full().items_center().overflow_x_scroll().track_scroll(this.scroll)
            .on_size_change((_size, cx) => { if (active >= 0) { this.scroll.scroll_to_item(active); cx.notify(); } })
            .children(tabs.map(tab => this.tab(tab, space, files, t)))
            .child(this.newTerminalControls(space, pane, t)))
          .child(Scrollbar.horizontal("ptabs").absolute().inset_0().mode("always")))
        .when(Boolean(this.errors.get(space?.id)), el => el.child(div().id("restore-files").px(8).text_size(11).text_color(t.ansi1)
          .tooltip(this.errors.get(space.id)).cursor_pointer().on_click((_e, cx) => { this.errors.delete(space.id); this.migrate(space.id, cx); }).child("Restore files · Retry"))));
  }
}
