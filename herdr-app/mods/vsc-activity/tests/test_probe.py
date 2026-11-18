import importlib.util
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch, Mock

spec = importlib.util.spec_from_file_location('probe', Path(__file__).resolve().parents[1] / 'probe.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class Probe(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'stat').write_text('cpu  100 20 30 500 40 10 20 30 10 5\ncpu0 0\ncpu1 0\nintr 99\n')
        (self.root / 'meminfo').write_text('MemTotal: 1000 kB\nMemAvailable: 400 kB\nMemFree: 10 kB\n')
        boot = self.root / 'sys/kernel/random/boot_id'
        boot.parent.mkdir(parents=True)
        boot.write_text('test-boot\n')
        mock = patch.object(probe.os, 'uname', return_value=SimpleNamespace(sysname='Linux'))
        mock.start()
        self.addCleanup(mock.stop)

    def test_cpu_does_not_double_count_guest_and_memory_uses_available(self):
        value = probe.snapshot(self.root)
        self.assertEqual(value['total_ticks'], 750)
        self.assertEqual(value['idle_ticks'], 540)
        self.assertEqual(value['cpus'], 2)
        self.assertEqual(value['memory_available'], 400 * 1024)

    def test_missing_available_memory_has_no_inaccurate_free_memory_fallback(self):
        (self.root / 'meminfo').write_text('MemTotal: 1000 kB\nMemFree: 10 kB\n')
        with self.assertRaises(KeyError):
            probe.snapshot(self.root)

    def test_invalid_memory_units_and_values_fail(self):
        for text in ['MemTotal: 1 GB\nMemAvailable: 1 kB\n', 'MemTotal: 1 kB\nMemAvailable: 2 kB\n']:
            (self.root / 'meminfo').write_text(text)
            with self.assertRaises(ValueError):
                probe.snapshot(self.root)

    def test_truncated_or_negative_cpu_counters_fail(self):
        for text in ['cpu 1 2\n', 'cpu -1 0 0 0 0 0 0 0\n']:
            (self.root / 'stat').write_text(text)
            with self.assertRaises(ValueError):
                probe.snapshot(self.root)

    def test_missing_evidence_fails(self):
        (self.root / 'sys/kernel/random/boot_id').unlink()
        with self.assertRaises(FileNotFoundError):
            probe.snapshot(self.root)

    def test_unsupported_hosts_report_the_platform(self):
        with patch.object(probe.os, 'uname', return_value=SimpleNamespace(sysname='Windows')):
            with self.assertRaisesRegex(RuntimeError, 'got Windows'):
                probe.snapshot(self.root)


class MacProbe(unittest.TestCase):
    VM = '''Mach Virtual Memory Statistics: (page size of 16384 bytes)
Anonymous pages: 400.
Pages purgeable: 50.
Pages wired down: 100.
Pages occupied by compressor: 75.
File-backed pages: 9999.
Pages stored in compressor: 300.
'''

    def setUp(self):
        self.vm = self.VM
        self.info = '16777216\n8\n{ sec = 1000, usec = 123 } test\n'
        for mock in (patch.object(probe.os, 'uname', return_value=SimpleNamespace(sysname='Darwin')),
                     patch.object(probe, 'command', side_effect=lambda argv: self.vm if argv[0].endswith('vm_stat') else self.info),
                     patch.object(probe, 'mac_cpu_ticks', return_value=(1000, 600))):
            mock.start()
            self.addCleanup(mock.stop)

    def test_local_mac_memory_counts_app_wired_and_physical_compression_once(self):
        value = probe.snapshot()
        self.assertEqual(value['memory_total'] - value['memory_available'], (400 - 50 + 100 + 75) * 16384)
        self.assertEqual(value['total_ticks'], 1000)
        self.assertEqual(value['idle_ticks'], 600)
        self.assertEqual(value['boot'], 'Darwin:1000:123')
        self.assertEqual(value['cpus'], 8)

    def test_missing_malformed_or_duplicate_vm_counters_fail(self):
        for vm in (self.VM.replace('Pages purgeable: 50.\n', ''),
                   self.VM.replace('Pages purgeable: 50.', 'Pages purgeable: broken.'),
                   self.VM + 'Pages purgeable: 50.\n', self.VM.replace('16384 bytes', 'unknown bytes')):
            self.vm = vm
            with self.assertRaisesRegex(ValueError, 'macOS'):
                probe.snapshot()

    def test_impossible_memory_and_missing_boot_information_fail(self):
        self.vm = self.VM.replace('Pages purgeable: 50.', 'Pages purgeable: 999.')
        with self.assertRaisesRegex(ValueError, 'memory counters'):
            probe.snapshot()
        self.vm = self.VM
        self.info = '16777216\n8\nunknown\n'
        with self.assertRaisesRegex(ValueError, 'boot time'):
            probe.snapshot()


class MachProbe(unittest.TestCase):
    def test_mach_layout_idle_index_and_errors(self):
        def fill(host, flavor, ticks, count):
            self.assertEqual(flavor, 3)
            ticks[:] = [100, 200, 600, 100]
            return 0
        lib = SimpleNamespace(mach_host_self=Mock(return_value=1), host_statistics=Mock(side_effect=fill))
        with patch.object(probe.ctypes, 'CDLL', return_value=lib):
            self.assertEqual(probe.mac_cpu_ticks(), (1000, 600))
            lib.host_statistics.side_effect = None
            lib.host_statistics.return_value = 5
            with self.assertRaisesRegex(RuntimeError, 'Mach status 5'):
                probe.mac_cpu_ticks()

    def test_command_failure_reports_stderr(self):
        with patch.object(probe.subprocess, 'run', return_value=SimpleNamespace(returncode=1, stderr='permission denied', stdout='')):
            with self.assertRaisesRegex(RuntimeError, 'permission denied'):
                probe.command(['/usr/bin/vm_stat'])


if __name__ == '__main__':
    unittest.main()
