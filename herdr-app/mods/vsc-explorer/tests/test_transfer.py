"""Real SSH regression: python3 tests/test_transfer.py --machines ssh-a ssh-b."""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from transfer import REMOTE_UPLOAD, transfer, upload_receipt

MACHINES = []


def remote(machine, script, *args):
    result = subprocess.run(["hc", "exec", "--on", machine, "--", "python3", "-c", script, *args], capture_output=True, text=True, timeout=40)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout


class TransferSshTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.roots = {}
        try:
            for machine in MACHINES:
                cls.roots[machine] = remote(machine, 'import tempfile; from pathlib import Path; print(tempfile.mkdtemp(prefix=".herdr-transfer-test-", dir=Path.home()))').strip()
        except Exception:
            cls.clean_remote()
            raise

    @classmethod
    def clean_remote(cls):
        for machine, root in cls.roots.items():
            remote(machine, 'import pathlib, shutil, sys; p=pathlib.Path(sys.argv[1]); assert p.parent == pathlib.Path.home() and p.name.startswith(".herdr-transfer-test-") and not p.is_symlink(); shutil.rmtree(p)', root)

    @classmethod
    def tearDownClass(cls):
        cls.clean_remote()

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="herdr-transfer-test-")
        self.addCleanup(temporary.cleanup)
        self.folder = Path(temporary.name)
        self.source = self.folder / "中文 ' $ [x]*?.bin"
        self.source.write_bytes(bytes(range(256)) * 40000)
        self.digest = hashlib.sha256(self.source.read_bytes()).hexdigest()

    def verify_remote(self, machine, saved):
        data = json.loads(remote(machine, 'import pathlib, json, hashlib, sys; p=pathlib.Path(sys.argv[1]); print(json.dumps({"hash": hashlib.sha256(p.read_bytes()).hexdigest(), "size":p.stat().st_size}))', saved["path"]))
        self.assertEqual(data["hash"], self.digest)
        self.assertEqual(data["size"], self.source.stat().st_size)
        self.assertEqual(saved["sha256"], self.digest)

    def test_upload_download_and_remote_to_remote(self):
        first, second = MACHINES
        uploaded = transfer(None, str(self.source), first, self.roots[first])
        self.verify_remote(first, uploaded)
        relayed = transfer(first, uploaded["path"], second, self.roots[second])
        self.verify_remote(second, relayed)
        received = transfer(second, relayed["path"], None, str(self.folder))
        self.assertNotEqual(Path(received["path"]), self.source)
        self.assertEqual(hashlib.sha256(Path(received["path"]).read_bytes()).hexdigest(), self.digest)
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), self.digest)

    def test_existing_remote_file_is_preserved(self):
        machine = MACHINES[0]
        initial = transfer(None, str(self.source), machine, self.roots[machine])
        remote(machine, 'import pathlib, sys; pathlib.Path(sys.argv[1]).write_bytes(b"preserve existing")', initial["path"])
        repeated = transfer(None, str(self.source), machine, self.roots[machine])
        self.assertNotEqual(initial["path"], repeated["path"])
        self.assertEqual(remote(machine, 'import pathlib, sys; print(pathlib.Path(sys.argv[1]).read_text())', initial["path"]).strip(), "preserve existing")
        self.verify_remote(machine, repeated)

    def test_upload_to_both_machines_with_empty_file_and_symlink(self):
        self.source.write_bytes(b"")
        self.digest = hashlib.sha256(b"").hexdigest()
        alias = self.folder / "selected-alias.bin"
        alias.symlink_to(self.source)
        for machine in MACHINES:
            with self.subTest(machine=machine):
                uploaded = transfer(None, str(alias), machine, self.roots[machine])
                self.verify_remote(machine, uploaded)
                self.assertEqual(Path(uploaded["path"]).name, alias.name)

    def test_missing_source_and_destination_are_explicit_failures(self):
        for machine in MACHINES:
            with self.subTest(machine=machine):
                with self.assertRaises(FileNotFoundError):
                    transfer(None, str(self.folder / "missing"), machine, self.roots[machine])
                with self.assertRaises(RuntimeError):
                    transfer(None, str(self.source), machine, self.roots[machine] + "/missing-folder")


class UploadIntegrityTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="herdr-upload-integrity-")
        self.addCleanup(temporary.cleanup)
        self.folder = Path(temporary.name)

    def send(self, data, expected):
        return subprocess.run([sys.executable, "-c", REMOTE_UPLOAD, str(self.folder), "received.bin", str(len(expected)), hashlib.sha256(expected).hexdigest(), "receipt:"], input=data, capture_output=True)

    def test_corrupt_truncated_and_extra_streams_publish_nothing(self):
        for data in [b"corrupt!", b"short", b"contents plus extra"]:
            with self.subTest(data=data):
                result = self.send(data, b"contents")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("校验失败", result.stderr.decode())
                self.assertEqual(list(self.folder.iterdir()), [])

    def test_successful_stream_and_no_clobber(self):
        for _ in range(2):
            result = self.send(b"contents", b"contents")
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sorted(p.name for p in self.folder.iterdir()), ["received (2).bin", "received.bin"])
        self.assertTrue(all(p.read_bytes() == b"contents" for p in self.folder.iterdir()))

    def test_receipt_requires_matching_metadata(self):
        expected = {"size": 5, "sha256": hashlib.sha256(b"hello").hexdigest()}
        cases = ["", "receipt:{}", "receipt:{invalid", "receipt:" + json.dumps({"path": "/file", "size": True, "sha256": expected["sha256"]}), "receipt:" + json.dumps({"path": "relative", **expected})]
        for case in cases:
            with self.subTest(case=case), self.assertRaises(ValueError):
                upload_receipt(case, "receipt:", expected)

    def test_same_machine_control_paths_and_non_files_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "另一台"):
            transfer(None, "/file", None, "/folder")
        with self.assertRaisesRegex(ValueError, "无效"):
            transfer(None, "/file\n", "remote", "/folder")
        from transfer import local_snapshot
        with self.assertRaisesRegex(ValueError, "普通文件"):
            local_snapshot(self.folder, self.folder / "payload")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--machines", nargs=2, required=True)
    MACHINES = parser.parse_args().machines
    unittest.main(argv=[sys.argv[0]], verbosity=2)
