// The Agents panel keeps its size when hidden; compact status lives in the activity bar.
import { run, layout } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export const isCollapsed = () => Boolean(find(layout(), "agents-list")?.hidden);

export function toggleSection() {
  const panel = find(layout(), "agents-list");
  if (!panel) throw new Error("The layout is missing its Agents panel");
  run(panel.hidden ? "layout.show" : "layout.hide", { id: "agents-list" });
}
