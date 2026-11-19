import { View, div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { checking, closeOverlay, exec, openOverlay, panes, props, run, spaces, theme } from "herdr";

function checkoutFolders(space) {
  const tabs = new Set(space.tabs.map((tab) => tab.id));
  const live = panes().find((pane) => tabs.has(pane.tab) && pane.cwd)?.cwd;
  return [...new Set([space.folder, live].filter(Boolean))];
}

function worktreeEntry(porcelain, path) {
  const entries = porcelain.split("\0\0").map((entry) => entry.split("\0"));
  const index = entries.findIndex(([folder]) => folder === `worktree ${path}`);
  if (index === -1) throw new Error("Git did not list this checkout");
  return {
    main: entries[0][0].slice("worktree ".length),
    linked: index > 0,
    locked: entries[index].some((line) => line === "locked" || line.startsWith("locked ")),
  };
}

export default class SpaceMenu extends View {
  init(_props, cx) {
    this.selected = 0;
    this.focus = cx.focus_handle();
    this.focus.focus();
    this.space = spaces().find((space) => space.id === props()?.space);
    if (checking() || !this.space) return;
    cx.spawn(async (cx) => {
      try {
        for (const cwd of checkoutFolders(this.space)) {
          const options = { cwd, on: this.space.machine };
          const top = await exec("git", ["rev-parse", "--show-toplevel"], options);
          if (top.code !== 0) {
            if (top.stderr.includes("not a git repository")) continue;
            throw new Error(top.stderr || "Could not identify the Git checkout");
          }
          this.folder = top.stdout.replace(/\r?\n$/, "");
          const list = await exec("git", ["worktree", "list", "--porcelain", "-z"], options);
          if (list.code !== 0) throw new Error(list.stderr || "Could not list Git worktrees");
          this.worktree = worktreeEntry(list.stdout, this.folder);
          break;
        }
      } catch {
        this.error = "Worktree status unavailable";
      } finally {
        cx.notify();
      }
    });
  }

  items() {
    if (!this.space) return [];
    const id = this.space.id;
    const items = [{ label: "Rename", action: () => run("space.rename", { id }) }];
    if (this.folder) {
      for (const [label, action, width, height] of [
        ["New worktree", "new", 440, 260],
        ["Open worktree", "open", 560, 480],
      ]) {
        items.push({ label, action: () => openOverlay({
          mod: "worktree", kind: "dialog", width, height,
          props: { space: id, folder: this.folder, action },
        }) });
      }
    }
    const protection = props()?.protected_worktree_repos ?? [];
    const validProtection = Array.isArray(protection) && protection.every(rule =>
      rule && (rule.machine == null || typeof rule.machine === "string") &&
      typeof rule.root === "string" && rule.root.length > 0);
    if (this.worktree?.linked) {
      items.push({
        label: "New terminal in worktree",
        action: () => run("tab.new", { space: id, folder: this.folder }),
      });
    }
    if (this.worktree?.locked) {
      items.push({ label: "Worktree locked" });
    } else if (this.worktree?.linked) {
      const protectedRepo = validProtection && protection.some(rule =>
        (rule.machine ?? null) === (this.space.machine ?? null) && rule.root === this.worktree.main);
      if (!validProtection) items.push({ label: "Invalid worktree protection settings" });
      else if (protectedRepo) items.push({ label: "Archive required before removal" });
      else items.push({
        label: "Remove worktree",
        action: () => openOverlay({
          mod: "worktree", kind: "dialog", width: 440, height: 260,
          props: { space: id, folder: this.folder, action: "remove" },
        }),
      });
    }
    if (this.error) items.push({ label: this.error });
    items.push({ label: "Close", action: () => run("space.close", { id }) });
    return items;
  }

  choose(item) {
    if (!item?.action) return;
    closeOverlay(props()?.overlay);
    item.action();
  }

  render(cx) {
    const t = theme();
    const items = this.items();
    const actions = items.filter((item) => item.action);
    return v_flex().id("vsc-space-menu").track_focus(this.focus)
      .w_full().p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "escape") closeOverlay(props()?.overlay);
        else if (actions.length && e.key === "down") this.selected = (this.selected + 1) % actions.length;
        else if (actions.length && e.key === "up") this.selected = (this.selected + actions.length - 1) % actions.length;
        else if (e.key === "enter") this.choose(actions[this.selected]);
        else return;
        cx.notify();
      })
      .children(items.map((item) => div().id(item.label).h(31).px(8).rounded(7)
        .flex().items_center().text_color(item.action ? t.foreground : t.dim)
        .when(actions[this.selected] === item, (el) => el.bg(t.selected))
        .when(!!item.action, (el) => el.hover((style) => style.bg(t.hover)).on_click(() => this.choose(item)))
        .child(item.label)));
  }
}
