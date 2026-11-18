import importlib.util
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

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

    def test_non_linux_hosts_report_unsupported(self):
        with patch.object(probe.os, 'uname', return_value=SimpleNamespace(sysname='Darwin')):
            with self.assertRaisesRegex(RuntimeError, 'require Linux'):
                probe.snapshot(self.root)


if __name__ == '__main__':
    unittest.main()
