import { spaces, panes, focused, shared } from "herdr";

// Match Explorer's {cwd, on} source signature. Imports stay inside each mod.
export function terminalLocation() {
  const space = spaces().find(s => s.active), focus = focused();
  const pane = focus?.pane ? panes().find(p => p.pane === focus.pane) : null;
  if (pane?.mod === "vsc-editor") {
    const file = shared("vsc.file-panes")?.[pane.pane]?.file;
    if (file) return { cwd: file.root || (file.sourcePath ?? file.path).slice(0, (file.sourcePath ?? file.path).lastIndexOf("/")), on: file.on ?? null };
  }
  const on = focus?.pane === null && focus.terminal
    ? (focus.terminal.includes("/") ? focus.terminal.split("/")[0] : null)
    : space?.machine ?? null;
  return { cwd: pane?.cwd || focus?.cwd || space?.folder, on };
}

export function location() {
  const source = terminalLocation(), jump = shared("vsc.explorer.jump");
  return jump?.source === JSON.stringify(source) ? { cwd: jump.folder, on: source.on } : source;
}
