"""Verified file copies between this computer and registered SSH machines."""

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shlex
import stat
import subprocess
import sys
import tempfile
import time
import uuid

from download import download, ssh_target


REMOTE_UPLOAD = r'''
import hashlib, itertools, json, os, pathlib, sys, tempfile
try:
    folder, name, expected_size, expected_hash, marker = sys.argv[1:]
    folder = pathlib.Path(folder).expanduser()
    if not folder.is_absolute() or not folder.is_dir():
        raise ValueError("目标目录不存在，请输入已有目录的绝对路径或 ~/ 路径")
    folder = folder.resolve(strict=True)
    if not name or name in (".", "..") or "/" in name or any(ord(c) < 32 or ord(c) == 127 for c in name):
        raise ValueError("无效的目标文件名")
    expected_size = int(expected_size)
    if expected_size < 0 or len(expected_hash) != 64 or any(c not in "0123456789abcdef" for c in expected_hash):
        raise ValueError("无效的文件校验信息")
    with tempfile.TemporaryDirectory(prefix=".herdr-transfer-", dir=folder) as staging:
        payload = pathlib.Path(staging) / "payload"
        size, digest = 0, hashlib.sha256()
        with payload.open("xb") as output:
            while True:
                block = sys.stdin.buffer.read(1024 * 1024)
                if not block:
                    break
                size += len(block)
                if size > expected_size:
                    raise ValueError("文件大小校验失败，未保存文件")
                output.write(block)
                digest.update(block)
            output.flush()
            os.fsync(output.fileno())
        if size != expected_size or digest.hexdigest() != expected_hash:
            raise ValueError("文件大小或 SHA-256 校验失败，未保存文件")
        original = pathlib.Path(name)
        for number in itertools.count(1):
            filename = name if number == 1 else f"{original.stem} ({number}){original.suffix}"
            destination = folder / filename
            try:
                os.link(payload, destination)
            except FileExistsError:
                continue
            break
    print(marker + json.dumps({"path": str(destination), "size": size, "sha256": digest.hexdigest()}, ensure_ascii=False), flush=True)
except Exception as error:
    print(str(error), file=sys.stderr, flush=True)
    sys.exit(1)
'''


def valid_text(value, label):
    if not isinstance(value, str) or not value or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError(f"无效的{label}")
    return value


def machine_name(value):
    if value is None:
        return None
    return valid_text(value, "机器名称")


def local_snapshot(source, payload):
    """Copy one stable regular file; do not block on pipes or devices."""
    descriptor = os.open(source, os.O_RDONLY | os.O_NONBLOCK)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise ValueError("请选择普通文件，暂不支持目录")
        digest, size = hashlib.sha256(), 0
        with os.fdopen(descriptor, "rb", closefd=False) as stream, payload.open("xb") as output:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                output.write(block)
                digest.update(block)
                size += len(block)
        after = os.fstat(descriptor)
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns) or size != before.st_size:
            raise RuntimeError("源文件在读取时发生变化，请等文件停止写入后重试")
    finally:
        os.close(descriptor)
    return {"size": size, "sha256": digest.hexdigest()}


def upload_receipt(stdout, marker, expected):
    receipts = [line[len(marker):] for line in stdout.splitlines() if line.startswith(marker)]
    if len(receipts) != 1:
        raise ValueError("目标机器没有返回唯一的文件校验回执")
    saved = json.loads(receipts[0])
    if not isinstance(saved, dict) or type(saved.get("size")) is not int or saved.get("size") != expected["size"] or saved.get("sha256") != expected["sha256"]:
        raise ValueError("目标机器返回的文件校验信息不匹配")
    path = valid_text(saved.get("path"), "目标文件路径")
    if not PurePosixPath(path).is_absolute():
        raise ValueError("目标机器没有返回绝对文件路径")
    return saved


def transfer(source_on, source_path, destination_on, folder):
    source_on, destination_on = machine_name(source_on), machine_name(destination_on)
    if source_on == destination_on:
        raise ValueError("请选择另一台目标机器")
    valid_text(source_path, "源文件路径")
    valid_text(folder, "目标目录")
    if not PurePosixPath(source_path).is_absolute() or PurePosixPath(source_path).name in ("", ".", ".."):
        raise ValueError("源文件必须使用绝对路径")
    name = PurePosixPath(source_path).name
    deadline = time.monotonic() + 540
    # Resolve both endpoints before reading any file. Only the local SSH client
    # needs credentials; credentials are never copied between remote machines.
    target = ssh_target(destination_on) if destination_on is not None else None
    if destination_on is None:
        destination = Path(folder).expanduser().resolve(strict=True)
        if not destination.is_dir():
            raise ValueError("目标必须是已有目录")
        saved = download(source_on, source_path, destination, timeout=max(0.1, deadline - time.monotonic()))
        return {"on": None, **saved}
    with tempfile.TemporaryDirectory(prefix="herdr-transfer-") as staging:
        payload = Path(staging) / "payload"
        if source_on is None:
            receipt = local_snapshot(source_path, payload)
        else:
            receipt = download(source_on, source_path, staging, timeout=max(0.1, deadline - time.monotonic()))
            payload = Path(receipt["path"])
        if time.monotonic() >= deadline:
            raise TimeoutError("传输超时，请重试")
        marker = f"HERDR_TRANSFER_{uuid.uuid4().hex}:"
        command = shlex.join(["python3", "-c", REMOTE_UPLOAD, folder, name, str(receipt["size"]), receipt["sha256"], marker])
        with payload.open("rb") as source:
            result = subprocess.run(
                ["/usr/bin/ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
                 "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "--", target, command],
                stdin=source, capture_output=True, timeout=max(0.1, deadline - time.monotonic()),
            )
        if result.returncode:
            raise RuntimeError(f"SSH 文件传输失败 ({result.returncode})：{result.stderr.decode('utf-8', errors='replace').strip()}")
        saved = upload_receipt(result.stdout.decode("utf-8", errors="strict"), marker, receipt)
    return {"on": destination_on, **saved}


def main():
    try:
        if len(sys.argv) != 2:
            raise ValueError("Usage: transfer.py JSON_REQUEST")
        request = json.loads(sys.argv[1])
        if not isinstance(request, dict) or not {"source_on", "source_path", "destination_on", "folder"} <= request.keys():
            raise ValueError("文件传输请求缺少机器或路径信息")
        saved = transfer(request["source_on"], request["source_path"], request["destination_on"], request["folder"])
        print(json.dumps(saved, ensure_ascii=False))
        return 0
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
