"""Read one macOS/Linux host snapshot; CPU usage comes from interval deltas."""
import ctypes
import json
import os
import re
import subprocess
from pathlib import Path


def linux_snapshot(root):
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


def command(argv):
    result = subprocess.run(argv, capture_output=True, text=True, timeout=3,
                            env={**os.environ, 'LC_ALL': 'C'})
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f'{argv[0]} failed ({result.returncode})')
    return result.stdout


def mac_cpu_ticks():
    # XNU mach/host_info.h: HOST_CPU_LOAD_INFO = 3, four natural_t counters.
    lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib')
    lib.mach_host_self.restype = ctypes.c_uint32
    lib.host_statistics.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.POINTER(ctypes.c_uint32),
                                   ctypes.POINTER(ctypes.c_uint32)]
    lib.host_statistics.restype = ctypes.c_int
    ticks, count = (ctypes.c_uint32 * 4)(), ctypes.c_uint32(4)
    result = lib.host_statistics(lib.mach_host_self(), 3, ticks, ctypes.byref(count))
    if result != 0 or count.value != 4:
        raise RuntimeError(f'macOS CPU counters unavailable (Mach status {result}, count {count.value})')
    # CPU_STATE_IDLE = 2; all four states contribute to total CPU time.
    return sum(ticks), ticks[2]


def mac_snapshot():
    info = command(['/usr/sbin/sysctl', '-n', 'hw.memsize', 'hw.ncpu', 'kern.boottime']).splitlines()
    if len(info) != 3:
        raise ValueError('Invalid macOS host information')
    total, cpus = int(info[0]), int(info[1])
    boot = re.search(r'\bsec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)', info[2])
    if total <= 0 or cpus <= 0 or not boot:
        raise ValueError('Invalid macOS memory, CPU count or boot time')
    vm = command(['/usr/bin/vm_stat'])
    page = re.search(r'page size of (\d+) bytes', vm)
    if not page or int(page[1]) <= 0:
        raise ValueError('macOS did not report its VM page size')
    counts = {}
    for key in ('Anonymous pages', 'Pages purgeable', 'Pages wired down', 'Pages occupied by compressor'):
        matches = re.findall(r'^' + re.escape(key) + r':\s*(\d+)\.$', vm, re.M)
        if len(matches) != 1:
            raise ValueError(f'macOS VM counter missing or invalid: {key}')
        counts[key] = int(matches[0])
    # Physical application memory + wired + compressed. Reclaimable file cache
    # and purgeable pages are excluded; count compressed physical pages once.
    app = counts['Anonymous pages'] - counts['Pages purgeable']
    used = (app + counts['Pages wired down'] + counts['Pages occupied by compressor']) * int(page[1])
    if app < 0 or not 0 <= used <= total:
        raise ValueError('Invalid macOS VM memory counters')
    ticks, idle = mac_cpu_ticks()
    return dict(version=1, boot='Darwin:' + ':'.join(boot.groups()), total_ticks=ticks,
                idle_ticks=idle, cpus=cpus, memory_total=total, memory_available=total - used)


def snapshot(root=Path('/proc')):
    system = os.uname().sysname
    if system == 'Linux':
        return linux_snapshot(root)
    if system == 'Darwin':
        return mac_snapshot()
    raise RuntimeError(f'Host resource statistics require macOS or Linux (got {system})')


if __name__ == '__main__':
    print(json.dumps(snapshot()))
