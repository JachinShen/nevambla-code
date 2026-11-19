// Title bar with a sidebar toggle beside the traffic lights and a centered command palette.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, run, spaces, layout, window, exec, appHome, shared, setShared, props, openOverlay, closeOverlay, checking } from "herdr";

// Claude accounts come from this block's props in the layout file, e.g.
//   "content": { "mod": "vsc-titlebar", "props": { "accounts": [
//     { "name": "Personal" },
//     { "name": "Work", "config_dir": "~/.claude-work", "command": "claude-work" } ] } }
// config_dir: the CLAUDE_CONFIG_DIR that account's Claude Code uses (omit for the default login).
// command: what you type to start it, shown as a hint (default: "claude", or the config dir's name).
// id: key for its cached usage (default: from the name).
// Usage is opt-in via props.show_usage: true. The first account is the default one.
const showUsage = () => props()?.show_usage === true;
function accounts() {
  const list = Array.isArray(props()?.accounts) && props().accounts.length ? props().accounts : [{ name: "Claude" }];
  return list.map(a => {
    const dir = typeof a?.config_dir === "string" ? a.config_dir : "";
    const cmd = a?.command ?? (dir ? dir.replace(/\/+$/, "").split("/").pop().replace(/^\./, "") : "claude");
    const name = a?.name ?? cmd;
    return { id: a?.id ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name, dir, cmd };
  });
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) { const f = find(c, id); if (f) return f; }
  return null;
}
const stop = (_e, cx) => cx.stop_propagation();

// "3h 27m" / "5d 14h" until an ISO time.
function until(iso) {
  const m = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60000));
  if (m >= 1440) return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m}m`;
}

export default class VscTitlebar extends View {
  init(_p, cx) {
    if (checking() || !showUsage()) return;
    this.fetch(cx);
    cx.timer.every(300000, cx => this.fetch(cx));
    // Refresh the usage countdowns on each minute boundary.
    cx.timer.after(60000 - (Date.now() % 60000) + 50, cx => { cx.notify(); cx.timer.every(60000, cx => cx.notify()); });
  }

  // Claude subscription usage for every account, from the same endpoint as Claude Code's /usage.
  // Kept in shared "vsc.usage" (the dropdown reads it). Failed requests show an explicit
  // error instead of leaving an indefinite loading indicator or using an old reading.
  // Only configured accounts are kept, so a removed account disappears.
  fetch(cx) {
    cx.spawn(async cx => {
      const home = appHome().replace(/\/\.config\/herdr-app$/, "");
      const all = {};
      for (const { id, dir } of accounts()) {
        try {
          const r = await exec("sh", [`${appHome()}/mods/vsc-titlebar/usage.sh`, dir.replace(/^~/, home)]);
          if (r.code !== 0) throw new Error(`Usage helper failed (${r.code})`);
          const u = JSON.parse(r.stdout);
          if (u.error) throw new Error(typeof u.error === "string" ? u.error : "Anthropic usage request failed");
          if (!u.five_hour) throw new Error("Usage response missing five_hour");
          all[id] = { five_hour: u.five_hour, seven_day: u.seven_day, at: Date.now(), stale: false };
        } catch (e) { all[id] = { error: String(e.message ?? e), at: Date.now() }; }
      }
      setShared("vsc.usage", all);
      cx.notify();
    });
  }

  // The dropdown opens under "Claude" on hover or click and closes when the pointer
  // leaves both (vsc-usage reports its own hover through shared "vsc.usage.hover").
  openPop(x, y) {
    if (this.pop && (shared("vsc.usage.closedAt") ?? 0) < this.popAt) return;
    this.popAt = Date.now();
    this.pop = openOverlay({ mod: "vsc-usage", kind: "popup", frame: "none", width: 470, at: { x, y }, props: { accounts: accounts() } });
  }
  closePopSoon(cx) {
    cx.timer.after(250, cx => {
      if (this.pop && !this.hovering && !shared("vsc.usage.hover")) { closeOverlay(this.pop); this.pop = null; }
      cx.notify();
    });
  }

  // One provider's limits in its brand color, so Claude and Codex sit side by side.
  meter(id, label, w, color, t) {
    const left = Math.max(0, Math.min(100, Math.round(100 - (w?.utilization ?? 0))));
    return h_flex().id(id).gap(6).items_center()
      .child(div().text_color(t.dim).child(label))
      .child(div().w(44).h(4).rounded(2).bg(t.border).overflow_hidden()
        .child(div().h_full().w(Math.round(44 * left / 100)).bg(color)))
      .child(div().text_color(t.foreground).child(`${left}%`))
      .when(Boolean(w?.resets_at), el => el.child(div().text_color(t.dim).child(until(w.resets_at))));
  }

  usageView(t, x, y) {
    const accs = accounts(), acc = accs.find(a => a.id === shared("vsc.usage.shown")) ?? accs[0];
    const id = acc.id, u = shared("vsc.usage")?.[id];
    const CLAUDE = "#d97757";
    return h_flex().id("usage-claude").flex_shrink_0().h_full().gap(12).items_center().text_size(11).cursor_pointer()
      .on_mouse_down("left", stop)
      .on_hover((h, cx) => { this.hovering = h; if (h) this.openPop(x, y); else this.closePopSoon(cx); })
      .on_click((_e, cx) => { this.openPop(x, y); this.fetch(cx); })
      .child(div().font_semibold().text_color(CLAUDE).child("Claude"))
      .when(acc !== accs[0], el => el.child(div().text_color(t.dim).child(acc.name.toLowerCase())))
      .when(Boolean(u?.five_hour), el => el
        .child(this.meter("u-session", "Session", u.five_hour, CLAUDE, t))
        .child(this.meter("u-week", "Week", u.seven_day, CLAUDE, t)))
      .when(!u?.five_hour, el => el.child(div().text_color(t.dim).child(u?.error ?? "Loading…")));
  }

  render() {
    const t = theme(), L = layout();
    const space = spaces().find(s => s.active);
    const title = `${space?.name ?? "Herdr"} — Herdr`;
    const w = window(), trafficLights = w?.platform === "macos" && !w.fullscreen;
    const inset = trafficLights ? 80 : 14;
    const toggleSize = 24, usageGap = 8;
    return h_flex().id("titlebar").size_full().bg(t.chrome).border_b(1).border_color(t.border).text_color(t.muted).text_size(12).items_center()
      // Equal-width sides (flex_1 from zero) keep the search box exactly centered.
      .child(h_flex().flex_1().min_w(0).h_full().items_center().overflow_hidden()
        .child(div().w(inset).flex_none())
        .child(div().id("t-side").size(toggleSize).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
          .role("button").accessibility_label("Toggle sidebar").tooltip("Toggle sidebar")
          .text_color(find(L, "side")?.hidden ? t.dim : t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", stop).on_click(() => run("layout.toggle", { id: "side" }))
          .child(svg("mods/vsc-titlebar/panel-left.svg").size(15)))
        .when(showUsage(), el => el
          .child(div().w(usageGap).flex_none())
          .child(this.usageView(t, inset + toggleSize + usageGap, find(L, "titlebar")?.size?.px ?? 35))))
      .child(h_flex().id("command-center").w(380).flex_shrink_0().h(24).flex_none().px(10).gap(6).items_center().justify_center()
        .rounded(6).border_1().border_color(t.border).bg(t.input).cursor_pointer()
        .hover(s => s.border_color(t.dim).text_color(t.foreground))
        .on_mouse_down("left", stop).on_click(() => run("app.palette"))
        .child(svg("mods/vsc-titlebar/search.svg").size(12).text_color(t.dim))
        .child(div().truncate().child(title)))
      .child(div().flex_1().min_w(0));
  }
}
