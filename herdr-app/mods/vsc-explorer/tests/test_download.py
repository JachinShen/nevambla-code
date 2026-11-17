"""Run against a registered SSH machine: python3 tests/test_download.py --machine ssh-a."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from download import download, verify_download

MACHINE = os.environ.get("HERDR_TEST_MACHINE")


def remote_python(script, *args):
    result = subprocess.run(
        ["hc", "exec", "--on", MACHINE, "--", "python3", "-c", script, *args],
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout


class SshDownloadTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not MACHINE:
            raise RuntimeError("Pass --machine or set HERDR_TEST_MACHINE for the real SSH tests")
        cls.fixture = json.loads(remote_python(r"""
from pathlib import Path
import hashlib, json, tempfile
root = Path(tempfile.mkdtemp(prefix='.herdr-download-regression-', dir=Path.home()))
large = root / 'large-binary.bin'
large.write_bytes(bytes(range(256)) * 40000)
small = root / "中文 ' $ [x]*?.bin"
small.write_bytes(bytes(range(256)) * 128)
alias = root / 'selected-alias.bin'
alias.symlink_to(small)
print(json.dumps({'root': str(root), 'large': str(large), 'small': str(small), 'alias': str(alias),
    'large_hash': hashlib.sha256(large.read_bytes()).hexdigest(),
    'small_hash': hashlib.sha256(small.read_bytes()).hexdigest()}, ensure_ascii=False))
"""))

    @classmethod
    def tearDownClass(cls):
        remote_python(r"""
from pathlib import Path
import shutil, sys
root = Path(sys.argv[1])
if root.parent != Path.home() or not root.name.startswith('.herdr-download-regression-') or root.is_symlink():
    raise ValueError('Unexpected test fixture path')
shutil.rmtree(root)
""", cls.fixture["root"])

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="herdr-download-regression-")
        self.addCleanup(temporary.cleanup)
        self.folder = Path(temporary.name)

    def receive(self, name):
        return download(MACHINE, self.fixture[name], self.folder)

    def test_home_file_binary_integrity(self):
        saved = self.receive("large")
        self.assertGreater(saved["size"], 8 * 1024 * 1024)
        self.assertEqual(hashlib.sha256(Path(saved["path"]).read_bytes()).hexdigest(), self.fixture["large_hash"])

    def test_symlink_keeps_the_selected_filename(self):
        saved = self.receive("alias")
        self.assertEqual(Path(saved["path"]).name, "selected-alias.bin")
        self.assertEqual(hashlib.sha256(Path(saved["path"]).read_bytes()).hexdigest(), self.fixture["small_hash"])

    def test_literal_filename_and_existing_file_preserved(self):
        first = Path(self.receive("small")["path"])
        self.assertEqual(first.name, Path(self.fixture["small"]).name)
        first.write_bytes(b"Keep this existing local file")
        second = Path(self.receive("small")["path"])
        self.assertNotEqual(first, second)
        self.assertEqual(first.read_bytes(), b"Keep this existing local file")
        self.assertEqual(hashlib.sha256(second.read_bytes()).hexdigest(), self.fixture["small_hash"])

    def test_missing_source_leaves_no_download(self):
        with self.assertRaises(RuntimeError):
            download(MACHINE, self.fixture["root"] + "/missing.bin", self.folder)
        self.assertEqual(list(self.folder.iterdir()), [])


class DownloadIntegrityTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="herdr-download-integrity-")
        self.addCleanup(temporary.cleanup)
        self.payload = Path(temporary.name) / "payload"
        self.payload.write_bytes(b"SSH banner\n" + b"original binary contents")

    def test_rejects_a_corrupted_stream(self):
        original = b"original binary contents"
        receipt = {"size": len(original), "sha256": hashlib.sha256(original).hexdigest()}
        with self.assertRaises(RuntimeError):
            verify_download(self.payload, "receipt:" + json.dumps(receipt), "receipt:")

    def test_requires_download_integrity_information(self):
        with self.assertRaises(RuntimeError):
            verify_download(self.payload, "SSH completed without a receipt", "receipt:")

    def test_rejects_invalid_download_metadata(self):
        for metadata in ["{}", "{invalid", '{"size": true, "sha256": "bad"}']:
            with self.subTest(metadata=metadata), self.assertRaises(ValueError):
                verify_download(self.payload, "receipt:" + metadata, "receipt:")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--machine", required=True)
    MACHINE = parser.parse_args().machine
    unittest.main(argv=[sys.argv[0]], verbosity=2)
