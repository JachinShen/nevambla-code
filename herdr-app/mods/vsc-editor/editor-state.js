// Identical in editor, explorer, changes and jump: Herdr isolates mod imports.
// Existing global tabs are adopted once by the first active Space, without deleting them.
import { spaces, shared, setShared, layout } from "herdr";

export const currentSpace = () => spaces().find(space => space.active)?.id ?? null;
const slot = (space, group) => `vsc.editor.space:${encodeURIComponent(space)}:${group}`;
const groupSlot = space => `vsc.group.space:${encodeURIComponent(space)}`;
const empty = () => ({ files: [], active: null });
function validate(state) {
  if (!state || !Array.isArray(state.files)
    || state.files.some(file => !file || typeof file.path !== "string" || (file.on != null && typeof file.on !== "string"))
    || new Set(state.files.map(file => file.path)).size !== state.files.length
    || !(state.active === null || typeof state.active === "string")
    || (state.active !== null && !state.files.some(file => file.path === state.active))) {
    throw new Error("Invalid saved editor tabs; the saved state has been left unchanged");
  }
  return state;
}
function adopt(space) {
  if (!space || shared("vsc.editor.migrated") != null) return;
  // Validate every source before writing so a corrupt second group cannot leave a partial migration.
  const old = [shared("vsc.editor"), shared("vsc.editor.2")];
  old.forEach(state => { if (state != null) validate(state); });
  old.forEach((state, i) => {
    if (state != null && shared(slot(space, i + 1)) == null) setShared(slot(space, i + 1), state);
  });
  if (shared(groupSlot(space)) == null) setShared(groupSlot(space), shared("vsc.group") === 2 ? 2 : 1);
  setShared("vsc.editor.migrated", space);
}
function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const result = find(child, id); if (result) return result; }
  return null;
}
export function activeGroup(space = currentSpace()) {
  adopt(space);
  return space && shared(groupSlot(space)) === 2 ? 2 : 1;
}
export function setActiveGroup(group, space = currentSpace()) {
  if (!space) throw new Error("No active Space for editor tabs");
  adopt(space);
  setShared(groupSlot(space), group === 2 ? 2 : 1);
}
export const targetGroup = () => activeGroup() === 2 && find(layout(), "editor-2")?.hidden === false ? 2 : 1;
export const editorKey = (group = targetGroup(), space = currentSpace()) => space ? slot(space, group) : null;
export function readEditor(group = targetGroup(), space = currentSpace()) {
  if (!space) return empty();
  adopt(space);
  const state = shared(slot(space, group));
  return state == null ? empty() : validate(state);
}
export function writeEditor(state, group = targetGroup(), space = currentSpace()) {
  if (!space) throw new Error("No active Space for editor tabs");
  validate(state);
  adopt(space);
  setShared(slot(space, group), state);
}
