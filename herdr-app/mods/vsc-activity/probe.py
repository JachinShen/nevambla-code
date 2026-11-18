"""Read one Linux host snapshot; CPU percentage is derived between snapshots."""
import json
import os
from pathlib import Path


def snapshot(root=Path('/proc')):
    if os.uname().sysname != 'Linux':
        raise RuntimeError('Host resource statistics require Linux')
    lines = (root / 'stat').read_text().splitlines()
    fields = lines[0].split()
    if fields[0] != 'cpu' or len(fields) < 9:
        raise ValueError('Invalid /proc/stat CPU counters')
    # Guest counters are already included in user/nice. I/O wait counts as idle.
    ticks = [int(n) for n in fields[1:9]]
    if any(n < 0 for n in ticks):
        raise ValueError('Negative CPU counter in /proc/stat')
    mem = {}
    for line in (root / 'meminfo').read_text().splitlines():
        key, value = line.split(':', 1)
        if key in ('MemTotal', 'MemAvailable'):
            number, unit = value.split()
            if unit != 'kB':
                raise ValueError('Unexpected /proc/meminfo unit')
            mem[key] = int(number) * 1024
    total, available = mem['MemTotal'], mem['MemAvailable']
    if total <= 0 or not 0 <= available <= total:
        raise ValueError('Invalid /proc/meminfo memory counters')
    boot = (root / 'sys/kernel/random/boot_id').read_text().strip()
    if not boot:
        raise ValueError('Linux boot ID is missing')
    return dict(version=1, boot=boot, total_ticks=sum(ticks), idle_ticks=ticks[3] + ticks[4],
                cpus=sum(line.startswith('cpu') and line[3:4].isdigit() for line in lines),
                memory_total=total, memory_available=available)


if __name__ == '__main__':
    print(json.dumps(snapshot()))
