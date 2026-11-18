"""Download a remote file through its Herdr machine's SSH target."""

import itertools
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shlex
import subprocess
import sys
import tempfile
import time
import uuid


REMOTE_DOWNLOAD = r"""
import hashlib, json, os, stat, sys
try:
    with os.fdopen(os.open(sys.argv[1], os.O_RDONLY | os.O_NONBLOCK), "rb") as source:
        before = os.fstat(source.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise ValueError("Select a regular file to download")
        digest = hashlib.sha256()
        size = 0
        while True:
            block = source.read(1024 * 1024)
            if not block:
                break
            sys.stdout.buffer.write(block)
            digest.update(block)
            size += len(block)
        after = os.fstat(source.fileno())
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns) or size != before.st_size:
            raise RuntimeError("Remote file changed during download; retry once it stops changing")
        sys.stdout.buffer.flush()
    print("\n" + sys.argv[2] + json.dumps({"size": size, "sha256": digest.hexdigest()}), file=sys.stderr, flush=True)
except Exception as error:
    print(str(error), file=sys.stderr, flush=True)
    sys.exit(1)
"""


def ssh_target(machine):
    result = subprocess.run(
        ["hc", "machine", "ls", "--json"],
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=20,
    )
    if result.returncode:
        raise RuntimeError(f"hc machine ls failed: {result.stderr.strip()}")
    data = json.loads(result.stdout)
    machines = data.get("machines")
    if not isinstance(machines, list):
        raise ValueError("hc machine ls returned no machines list")
    matches = [entry for entry in machines if entry.get("name") == machine]
    if len(matches) != 1:
        raise ValueError(f"Herdr machine not found or ambiguous: {machine}")
    entry = matches[0]
    if entry.get("via") is not False:
        raise ValueError("Downloads require a machine connected through SSH")
    target = entry.get("target")
    if not isinstance(target, str) or not target or target.startswith("-"):
        raise ValueError("Herdr machine has no valid SSH target")
    if any(ord(char) < 32 or ord(char) == 127 for char in target):
        raise ValueError("SSH target contains control characters")
    return target


def publish_file(payload, folder, name):
    """A hard link publishes a completed file without replacing an existing one."""
    original = Path(name)
    for number in itertools.count(1):
        filename = name if number == 1 else f"{original.stem} ({number}){original.suffix}"
        destination = folder / filename
        try:
            os.link(payload, destination)
        except FileExistsError:
            continue
        return destination


def verify_download(payload, diagnostics, marker):
    receipts = [line[len(marker):] for line in diagnostics.splitlines() if line.startswith(marker)]
    if len(receipts) != 1:
        raise RuntimeError(f"SSH did not return download integrity information: {diagnostics.strip()}")
    receipt = json.loads(receipts[0])
    if not isinstance(receipt, dict):
        raise ValueError("SSH returned invalid download integrity information")
    size, expected_hash = receipt.get("size"), receipt.get("sha256")
    if type(size) is not int or size < 0 or not isinstance(expected_hash, str) or len(expected_hash) != 64 or any(c not in "0123456789abcdef" for c in expected_hash):
        raise ValueError("SSH returned invalid download size or SHA-256")
    digest = hashlib.sha256()
    with payload.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    if payload.stat().st_size != size or digest.hexdigest() != expected_hash:
        raise RuntimeError("Downloaded file failed size/SHA-256 verification; no file was saved")
    return receipt


def download(machine, remote_path, folder, *, timeout=550):
    deadline = time.monotonic() + timeout
    if not machine or not PurePosixPath(remote_path).is_absolute():
        raise ValueError("A remote machine and absolute file path are required")
    if any(ord(char) < 32 or ord(char) == 127 for char in remote_path):
        raise ValueError("File path contains control characters")
    name = PurePosixPath(remote_path).name
    if name in ("", ".", ".."):
        raise ValueError("Select a file to download")
    destination_folder = Path(folder).resolve(strict=True)
    if not destination_folder.is_dir():
        raise ValueError("The local destination must be a folder")
    target = ssh_target(machine)
    # Jump servers can expose a different SFTP namespace from their SSH exec
    # sessions. Stream over the same SSH command channel as the remote core.
    marker = f"HERDR_DOWNLOAD_{uuid.uuid4().hex}:"
    command = shlex.join(["python3", "-c", REMOTE_DOWNLOAD, remote_path, marker])
    with tempfile.TemporaryDirectory(prefix=".herdr-download-", dir=destination_folder) as staging:
        payload = Path(staging) / "payload"
        with payload.open("wb") as output:
            result = subprocess.run(
                [
                    "/usr/bin/ssh", "-T",
                    "-o", "BatchMode=yes",
                    "-o", "ConnectTimeout=15",
                    "-o", "ServerAliveInterval=15",
                    "-o", "ServerAliveCountMax=3",
                    "--", target, command,
                ],
                stdin=subprocess.DEVNULL,
                stdout=output,
                stderr=subprocess.PIPE,
                timeout=max(0.1, deadline - time.monotonic()),
            )
        diagnostics = result.stderr.decode("utf-8", errors="replace")
        if result.returncode:
            raise RuntimeError(f"SSH download failed ({result.returncode}): {diagnostics.strip()}")
        receipt = verify_download(payload, diagnostics, marker)
        destination = publish_file(payload, destination_folder, name)
    return {"path": str(destination), **receipt}


def main():
    try:
        if len(sys.argv) != 4:
            raise ValueError("Usage: download.py MACHINE REMOTE_FILE LOCAL_FOLDER")
        result = download(*sys.argv[1:])
    except Exception as error:
        source = f"{sys.argv[1]}:{sys.argv[2]}\n" if len(sys.argv) == 4 else ""
        print(f"{source}{error}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
