import { exec, readTextFile, appHome } from "herdr";

export const INTERVAL = 5000;
export const STALE = 90000;

export function validate(value) {
  if (!value || value.version !== 1 || typeof value.boot !== "string" || !value.boot
    || ["total_ticks", "idle_ticks", "cpus", "memory_total", "memory_available"].some(k => !Number.isSafeInteger(value[k]) || value[k] < 0)
    || value.total_ticks <= 0 || value.idle_ticks > value.total_ticks || value.cpus < 1
    || value.memory_total <= 0 || value.memory_available > value.memory_total) {
    throw new Error("Host returned invalid host resource counters");
  }
  return value;
}

export function usage(current, previous) {
  validate(current);
  let cpu = null;
  if (previous?.boot === current.boot) {
    const total = current.total_ticks - previous.total_ticks, idle = current.idle_ticks - previous.idle_ticks;
    if (total <= 0 || idle < 0 || idle > total) throw new Error("Host CPU counters did not advance correctly");
    cpu = (total - idle) / total * 100;
  }
  return { cpu, used: current.memory_total - current.memory_available,
    total: current.memory_total, cpus: current.cpus };
}

export const gib = bytes => (bytes / 1073741824).toFixed(1);
export const resourceColor = fraction => fraction >= 0.9 ? "#ef5b5b" : fraction >= 0.6 ? "#e3b341" : "#8daec8";

export class Resources {
  constructor() { this.states = new Map(); this.pending = new Set(); }
  async script() {
    if (!this.source) {
      const source = await readTextFile(`${appHome()}/mods/vsc-activity/probe.py`);
      if (typeof source !== "string" || !source.trim()) throw new Error("The host resource probe is missing");
      this.source = source;
    }
    return this.source;
  }
  offline(name) {
    if (!this.pending.has(name)) this.states.set(name, { error: "Machine is offline", at: Date.now() });
  }
  async sample(name = null) {
    if (this.pending.has(name)) return;
    this.pending.add(name);
    try {
      const result = await exec("python3", ["-c", await this.script()], { on: name, timeout: 5000 });
      if (result.code !== 0) throw new Error(result.stderr.trim() || `Host resource probe failed (${result.code})`);
      const snapshot = validate(JSON.parse(result.stdout)), prior = this.states.get(name);
      const value = usage(snapshot, prior?.snapshot);
      this.states.set(name, { value, snapshot, at: Date.now() });
    } catch (error) {
      // Failed samples clear the old reading and baseline, so stale data is never shown as current.
      this.states.set(name, { error: String(error.message ?? error), at: Date.now() });
    } finally { this.pending.delete(name); }
  }
}
