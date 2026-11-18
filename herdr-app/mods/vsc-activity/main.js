// VS Code-style activity bar: picks what the side bar shows; clicking the
// shown one again hides the side bar.
import { View, div, svg, image, PathBuilder } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, run, layout, agents, spaces, machines, shared, setAgentOrder, nextCommand } from "herdr";
import { Resources, INTERVAL, STALE, gib, resourceColor } from "./resources.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) { const f = find(c, id); if (f) return f; }
  return null;
}

const VIEWS = [
  { id: "explorer", icon: "files", title: "Explorer" },
  { id: "changes", icon: "git-branch", title: "Source Control" },
  { id: "spaces", icon: "layers", title: "Spaces" },
];

const STATUS = {
  working: { label: "Working", color: "#39c67a" },
  blocked: { label: "Needs you", color: "#ef5b5b" },
  done: { label: "Done", color: "#4c9dff" },
  idle: { label: "Seen" },
  unknown: { label: "Unknown" },
};
const RANK = { blocked: 4, done: 3, working: 2, idle: 1, unknown: 0 };
const ROW_HEIGHT = 36, ROW_GAP = 2, RAIL_PADDING = 4;

function pick(view) {
  const L = layout(), side = find(L, "side"), body = find(L, "side-body");
  if (!side?.hidden && body?.active === view) { run("layout.hide", { id: "side" }); return; }
  run("layout.select", { stack: "side-body", child: view });
  run("layout.show", { id: "side" });
}

export default class VscActivity extends View {
  init(_props, cx) {
    this.resources = new Resources();
    this.resourceAt = new Map();
    cx.timer.every(1000, cx => this.refreshResources(cx));
    cx.spawn(async cx => {
      for (;;) {
        if (await nextCommand() === "agents") { this.toggleAgents(); cx.notify(); }
      }
    });
  }

  refreshResources(cx) {
    const space = spaces().find(s => s.active);
    if (!space) return;
    const on = space.machine ?? null;
    const machine = on ? machines().find(m => m.name === on && !m.temporary) : null;
    if (on && machine?.layout !== "ready") {
      if (this.resources.states.get(on)?.error !== "Machine is offline") { this.resources.offline(on); cx.notify(); }
      return;
    }
    const state = this.resources.states.get(on);
    // A second startup sample establishes a CPU interval; subsequent probes are thirty seconds apart.
    const interval = state?.value?.cpu === null ? 3000 : INTERVAL;
    if (this.resources.pending.has(on) || Date.now() - (this.resourceAt.get(on) ?? 0) < interval) return;
    this.resourceAt.set(on, Date.now());
    cx.spawn(async cx => { await this.resources.sample(on); cx.notify(); });
  }

  meters(on, t) {
    const state = this.resources.states.get(on), stale = state && Date.now() - state.at > STALE;
    const value = !state?.error && !stale ? state?.value : null;
    const host = on ?? "This computer";
    const title = state?.error ? `${host} · Resources unavailable\n${state.error}\nClick to retry`
      : `${host} · Host resources · refreshes every 30 seconds\nYellow ≥ 60% · Red ≥ 90%`
        + (value ? `\nMemory: ${gib(value.used)} / ${gib(value.total)} GB (1024³ bytes)` : "")
        + (stale ? "\nReading expired · Refreshing…" : !value || value.cpu === null ? "\nCollecting CPU baseline…" : "");
    const ring = (id, label, fraction, text, unit = "") => {
      const color = fraction == null ? t.muted : resourceColor(fraction);
      const gauge = div().id(id).size(38).flex_none().relative().rounded(19).border(3).border_color(t.border)
        .flex().items_center().justify_center()
        .child(v_flex().items_center().justify_center().text_color(color)
          .child(div().text_size(unit ? 10 : 11).font_medium().child(text))
          .when(Boolean(unit), el => el.child(div().text_size(8).child(unit))));
      if (fraction > 0) {
        const f = Math.max(0, Math.min(1, fraction)), path = PathBuilder.stroke(3).move_to(19, 1.5);
        if (f === 1) path.arc_to(17.5, 17.5, 0, false, true, 19, 36.5).arc_to(17.5, 17.5, 0, false, true, 19, 1.5);
        else path.arc_to(17.5, 17.5, 0, f > 0.5, true, 19 + Math.sin(f * Math.PI * 2) * 17.5, 19 - Math.cos(f * Math.PI * 2) * 17.5);
        // Path coordinates are local to this 38 px box, independent of the rail's position.
        gauge.child(window.paint_path(path.build(), color).absolute().top(-3).left(-3).size(38));
      }
      return v_flex().w_full().items_center().gap(3)
        .child(div().text_size(9).text_color(t.muted).child(label)).child(gauge);
    };
    const empty = state?.error ? "!" : stale ? "—" : "…";
    return v_flex().id("host-resources").w_full().h(124).flex_none().py(6).gap(8).tooltip(title)
      .when(Boolean(state?.error), el => el.cursor_pointer().hover(s => s.bg(t.hover)).on_click((_e, cx) => {
        this.resourceAt.delete(on); this.refreshResources(cx);
      }))
      .child(ring("host-cpu", "CPU", value?.cpu == null ? null : value.cpu / 100, value?.cpu == null ? empty : `${Math.round(value.cpu)}%`))
      .child(ring("host-memory", "MEM", value ? value.used / value.total : null, value ? gib(value.used) : empty, value ? "GB" : ""));
  }

  item(v, active, badge, action = () => pick(v.id)) {
    const t = theme();
    return div().id(`act-${v.id}`).relative().w_full().h(48).flex_none().flex().items_center().justify_center().cursor_pointer().tooltip(v.title)
      .text_color(active ? t.foreground : t.dim).hover(s => s.text_color(t.foreground))
      .on_click(action)
      .when(active, el => el.child(div().absolute().left(0).top(0).bottom(0).w(2).bg(t.accent)))
      .child(svg(`mods/vsc-activity/${v.icon}.svg`).size(22))
      .when(badge > 0, el => el.child(div().absolute().right(8).bottom(10).min_w(16).h(16).px(4).rounded(8)
        .bg(t.accent).text_color(t.accent_foreground).text_size(10).font_semibold()
        .flex().items_center().justify_center().child(String(badge))));
  }

  compactAgent(a, t) {
    const status = STATUS[a.status] ?? STATUS.unknown, p = a.program;
    const pic = p?.icon
      ? p.tint ? svg(p.icon).size(18).text_color(t.foreground) : image(p.icon).w(18).h(18)
      : svg("mods/vsc-activity/terminal.svg").size(18).text_color(t.foreground);
    return h_flex().id(`rail-agent-${a.address}`).w_full().h(ROW_HEIGHT).flex_none().items_center().justify_center().rounded(4)
      .bg(a.focused ? t.selected : t.chrome).cursor_pointer().hover(s => s.bg(t.hover))
      .tooltip(`${p?.name ?? a.app ?? "Agent"} · ${a.tab_name || a.title || a.address}\n${a.space_name} · ${status.label}\n${a.address}`)
      .on_click(() => run("agent.focus", { terminal: a.address }))
      .child(div().size(28).flex_none().relative().flex().items_center().justify_center()
        .child(pic.flex_none())
        .when(Boolean(status.color), el => el.child(div().id(`agent-light-${a.address}`).absolute().top(0).right(0).size(9).rounded(5)
          .border(1).border_color(t.chrome).bg(status.color))));
  }

  toggleAgents() {
    const L = layout(), side = find(L, "side"), panel = find(L, "agents-list");
    if (!side || !panel) throw new Error("The layout is missing its Agents panel");
    if (side.hidden || panel.hidden) {
      run("layout.show", { id: "agents-list" });
      if (side.hidden) run("layout.show", { id: "side" });
    } else run("layout.hide", { id: "agents-list" });
  }

  render(cx) {
    const t = theme(), L = layout();
    const sideHidden = Boolean(find(L, "side")?.hidden);
    const open = !sideHidden && find(L, "agents-list")?.hidden === false;
    const space = spaces().find(s => s.active), on = space?.machine ?? null;
    if (this.resources) this.refreshResources(cx);
    const shown = sideHidden ? null : find(L, "side-body")?.active;
    const list = [...agents()].sort((a, b) => Number(b.pinned) - Number(a.pinned)
      || (shared("agents.sort") === "grouped" ? 0 : (RANK[b.status] ?? 0) - (RANK[a.status] ?? 0) || b.seq - a.seq));
    if (!open) setAgentOrder(list.map(a => a.address));
    return v_flex().id("activity").size_full().min_h(0).bg(t.chrome).border_r(1).border_color(t.border)
      .children(VIEWS.map(v => this.item(v, shown === v.id, 0)))
      .when(Boolean(space), el => el.child(this.meters(on, t)))
      .child(v_flex().flex_1().min_h(0).justify_end()
        // Scrollbar wrappers fill their box; bound that box so a short list stays at the bottom.
        .when(list.length > 0, el => el.child(div().w_full().min_h(0).max_h_full()
          .h(list.length * (ROW_HEIGHT + ROW_GAP) - ROW_GAP + RAIL_PADDING * 2)
          .child(v_flex().id("agent-rail").size_full().min_h(0).overflow_y_scrollbar().px(RAIL_PADDING).py(RAIL_PADDING).gap(ROW_GAP)
            .children(list.map(a => this.compactAgent(a, t)))))))
      .child(div().id("agent-expand").w_full().h(28).flex_none().flex().items_center().justify_center().cursor_pointer()
        .tooltip(open ? "Collapse agents" : "Expand agents").text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => this.toggleAgents())
        .child(svg(`mods/workspace-chrome/chevron-${open ? "left" : "right"}.svg`).size(14)))
      .child(div().id("act-settings").w_full().h(48).flex_none().flex().items_center().justify_center().cursor_pointer().tooltip("Settings")
        .text_color(t.dim).hover(s => s.text_color(t.foreground)).on_click(() => run("app.settings"))
        .child(svg("mods/vsc-activity/settings.svg").size(22)));
  }
}
