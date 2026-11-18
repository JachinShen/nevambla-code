// VS Code-style activity bar: picks what the side bar shows; clicking the
// shown one again hides the side bar.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, run, layout, agents, shared, setAgentOrder } from "herdr";

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
  working: { label: "Working", color: "working" },
  blocked: { label: "Needs you", color: "blocked" },
  done: { label: "Done", color: "done" },
  idle: { label: "Idle", color: "idle" },
  unknown: { label: "Unknown", color: "unknown" },
};
const RANK = { blocked: 4, done: 3, working: 2, idle: 1, unknown: 0 };
const ROW_HEIGHT = 36, ROW_GAP = 2, RAIL_PADDING = 4;

function toggleAgents() {
  const L = layout(), side = find(L, "side"), panel = find(L, "agents-list");
  if (!side || !panel) throw new Error("The layout is missing its Agents panel");
  if (side.hidden || panel.hidden) {
    run("layout.show", { id: "agents-list" });
    if (side.hidden) run("layout.show", { id: "side" });
  } else run("layout.hide", { id: "agents-list" });
}

function pick(view) {
  const L = layout(), side = find(L, "side"), body = find(L, "side-body");
  if (!side?.hidden && body?.active === view) { run("layout.hide", { id: "side" }); return; }
  run("layout.select", { stack: "side-body", child: view });
  run("layout.show", { id: "side" });
}

export default class VscActivity extends View {
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
        .child(div().id(`agent-light-${a.address}`).absolute().top(0).right(0).size(8).rounded(4)
          .border(1.5).border_color(t.chrome).bg(t[status.color])
          .when(a.status === "working" || a.status === "blocked", el => el.loop("opacity", {
            from: 0.35, to: 1, period: a.status === "blocked" ? 1400 : 2400, easing: "ease-in-out",
          }))));
  }

  render() {
    const t = theme(), L = layout();
    const sideHidden = Boolean(find(L, "side")?.hidden), panel = find(L, "agents-list");
    const shown = sideHidden ? null : find(L, "side-body")?.active;
    const open = Boolean(panel && !sideHidden && !panel.hidden);
    const list = [...agents()].sort((a, b) => Number(b.pinned) - Number(a.pinned)
      || (shared("agents.sort") === "grouped" ? 0 : (RANK[b.status] ?? 0) - (RANK[a.status] ?? 0) || b.seq - a.seq));
    const waiting = list.filter(a => a.status === "blocked" || a.status === "done").length;
    if (!open) setAgentOrder(list.map(a => a.address));
    return v_flex().id("activity").size_full().min_h(0).bg(t.chrome).border_r(1).border_color(t.border)
      .children(VIEWS.map(v => this.item(v, shown === v.id, 0)))
      .child(v_flex().flex_1().min_h(0).justify_end()
        // Scrollbar wrappers fill their box; bound that box so a short list stays at the bottom.
        .when(!open && list.length > 0, el => el.child(div().w_full().min_h(0).max_h_full()
          .h(list.length * (ROW_HEIGHT + ROW_GAP) - ROW_GAP + RAIL_PADDING * 2)
          .child(v_flex().id("agent-rail").size_full().min_h(0).overflow_y_scrollbar().px(RAIL_PADDING).py(RAIL_PADDING).gap(ROW_GAP)
            .children(list.map(a => this.compactAgent(a, t)))))))
      .child(this.item({ id: "agents", icon: "bot", title: open ? "Hide Agents" : "Show Agents" }, open, waiting, toggleAgents))
      .child(div().id("act-settings").w_full().h(48).flex_none().flex().items_center().justify_center().cursor_pointer().tooltip("Settings")
        .text_color(t.dim).hover(s => s.text_color(t.foreground)).on_click(() => run("app.settings"))
        .child(svg("mods/vsc-activity/settings.svg").size(22)));
  }
}
