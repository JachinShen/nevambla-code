// Identical in editor, explorer, changes, jump, panelbar and pane: imports are mod-local.
// Native tabs/panes own topology; this index only attaches file metadata to live pane IDs.
import { spaces, panes, focused, shared, setShared, exec, run, appHome, notify } from "herdr";

const INDEX = "vsc.file-panes";
export const currentSpace = () => spaces().find(s => s.active)?.id ?? null;
export const fileIdentity = f => JSON.stringify([f.kind ?? "file", f.on ?? null, f.path]);
export const fileName = f => (f.sourcePath ?? f.path).split("/").pop() + (f.kind === "diff" ? " · Diff" : "");
function validateFile(f) {
  if (!f || typeof f.path !== "string" || !(f.sourcePath ?? f.path).startsWith("/")
    || (f.on != null && typeof f.on !== "string")) throw new Error("Invalid file preview metadata");
  return f;
}
function index() {
  const value = shared(INDEX) ?? {};
  if (typeof value !== "object" || Array.isArray(value)
    || Object.values(value).some(e => !e || typeof e.tab !== "string" || typeof e.space !== "string" || !e.file)) {
    throw new Error("Invalid saved file pane index; the saved state has been left unchanged");
  }
  Object.values(value).forEach(e => validateFile(e.file));
  return value;
}
export function filePanes(space) {
  const saved = index(), all = spaces();
  return panes().filter(p => p.mod === "vsc-editor" && saved[p.pane]).flatMap(p => {
    const owner = all.find(s => s.tabs.some(t => t.id === p.tab));
    return owner && (!space || owner.id === space) ? [{ ...saved[p.pane], pane: p.pane, tab: p.tab, space: owner.id }] : [];
  });
}
export function activeFile() {
  const entries = filePanes(currentSpace()), focus = focused();
  const tab = spaces().find(s => s.active)?.tabs.find(t => t.active)?.id;
  return (entries.find(e => e.pane === focus?.pane) ?? entries.find(e => e.tab === tab))?.file ?? null;
}
export function registerFile(file, pane) {
  validateFile(file);
  const p = panes().find(p => p.pane === pane);
  const owner = p && spaces().find(s => s.tabs.some(t => t.id === p.tab));
  if (!owner) throw new Error("This file preview is not attached to a native pane");
  const saved = index(), old = saved[pane];
  if (old && fileIdentity(old.file) !== fileIdentity(file)) throw new Error("File pane metadata does not match its persisted props");
  if (!old || old.tab !== p.tab || old.space !== owner.id) {
    setShared(INDEX, { ...saved, [pane]: { file: old?.file ?? file, tab: p.tab, space: owner.id, dirty: old?.dirty ?? false } });
  }
  return { ...index()[pane], pane };
}
export function setFileDirty(pane, dirty) {
  const saved = index();
  if (saved[pane] && saved[pane].dirty !== dirty) setShared(INDEX, { ...saved, [pane]: { ...saved[pane], dirty } });
}
export const bufferKey = (space, file, pane) => `vsc.file-buffer:${encodeURIComponent(JSON.stringify([space, fileIdentity(file), ...(pane ? [pane] : [])]))}`;
function select(entry, space, focus) {
  if (focus && currentSpace() === space) {
    run("tab.select", { id: entry.tab });
    run("pane.focus", { pane: entry.pane });
  }
}
export async function openFile(file, { space = currentSpace(), focus = true } = {}) {
  validateFile(file);
  if (!spaces().some(s => s.id === space)) throw new Error("The target Space is no longer available");
  file = { ...file, on: file.on ?? null };
  const identity = fileIdentity(file), existing = filePanes(space).find(e => fileIdentity(e.file) === identity);
  if (existing) {
    const saved = index();
    setShared(INDEX, { ...saved, [existing.pane]: { ...saved[existing.pane], file, tab: existing.tab, space } });
    select(existing, space, focus);
    return existing;
  }
  // A synchronous shared claim also prevents duplicate clicks in different mods.
  const key = JSON.stringify([space, identity]), claimKey = "vsc.file-opening";
  const claims = shared(claimKey) ?? {}, now = Date.now();
  if (claims[key] && now - claims[key].at < 45000) throw new Error("This file is already opening; please wait");
  const token = `${now}-${Math.random()}`;
  setShared(claimKey, { ...claims, [key]: { at: now, token } });
  try {
    // run() has no result. The app CLI returns the actual IDs and reports structural errors.
    // Create in the background, then select only if the user is still in the captured Space.
    const result = await exec("env", [`HERDR_APP_HOME=${appHome()}`, "herdr-app", "do", "tab.new", JSON.stringify({
      space, name: fileName(file), mod: "vsc-editor", props: { file }, focus: false,
    })]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `Could not open file tab (${result.code})`);
    const receipt = JSON.parse(result.stdout);
    if (typeof receipt.pane !== "string" || typeof receipt.tab !== "string" || receipt.space !== space) {
      throw new Error("Herdr did not return valid file tab and pane IDs");
    }
    const entry = { file, space, tab: receipt.tab, dirty: false };
    setShared(INDEX, { ...index(), [receipt.pane]: entry });
    const opened = { ...entry, pane: receipt.pane };
    select(opened, space, focus);
    return opened;
  } finally {
    const latest = { ...shared(claimKey) };
    if (latest[key]?.token === token) { delete latest[key]; setShared(claimKey, latest); }
  }
}
export function splitFile(pane, direction) {
  const entry = filePanes().find(e => e.pane === pane);
  if (!entry) throw new Error("The file pane is no longer available");
  run("pane.split", { pane, direction, mod: "vsc-editor", props: { file: entry.file } });
}
function unsaved(count) {
  notify({ title: "Unsaved changes", body: `Save ${count === 1 ? "this file" : `${count} files`} before closing.`, level: "warning" });
}
export function closeFilePane(pane) {
  const entry = filePanes().find(e => e.pane === pane);
  if (entry?.dirty) { unsaved(1); return false; }
  run("pane.close", { pane });
  return true;
}
export function closeFileTab(tab) {
  const dirty = filePanes().filter(e => e.tab === tab && e.dirty).length;
  if (dirty) { unsaved(dirty); return false; }
  run("tab.close", { id: tab });
  return true;
}
export function closeOtherFiles(tab, space) {
  const entries = filePanes(space), candidates = spaces().find(s => s.id === space)?.tabs ?? [];
  let dirty = 0;
  for (const other of candidates) {
    if (other.id === tab) continue;
    const parts = panes().filter(p => p.tab === other.id);
    // This file action never closes terminal work sharing the same Space or tab.
    if (!parts.length || !parts.every(p => p.mod === "vsc-editor" && entries.some(e => e.pane === p.pane))) continue;
    const changed = entries.filter(e => e.tab === other.id && e.dirty).length;
    if (changed) dirty += changed;
    else run("tab.close", { id: other.id });
  }
  if (dirty) unsaved(dirty);
}
