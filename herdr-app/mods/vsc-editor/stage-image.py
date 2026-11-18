"""Verified local/SSH image snapshots for the native GPUI image loader."""
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import struct
import sys
import tempfile
import xml.etree.ElementTree as ET
import zlib

from download import download

MAX_BYTES = 64 * 1024 * 1024
MAX_PIXELS = 64_000_000


def dimensions(data):
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        pos, found, ended = 8, False, False
        width = height = 0
        while pos + 12 <= len(data):
            size = int.from_bytes(data[pos:pos + 4], "big")
            kind, body = data[pos + 4:pos + 8], data[pos + 8:pos + 8 + size]
            if pos + size + 12 > len(data) or zlib.crc32(kind + body) != int.from_bytes(data[pos + 8 + size:pos + 12 + size], "big"):
                raise ValueError("PNG is truncated or has an invalid checksum")
            if kind == b"IHDR":
                if size != 13 or pos != 8:
                    raise ValueError("Invalid PNG header")
                width, height = struct.unpack(">II", body[:8])
            found |= kind == b"IDAT"
            pos += size + 12
            if kind == b"IEND":
                ended = True
                break
        if not found or not ended:
            raise ValueError("PNG is incomplete")
        return width, height, "png"
    if data[:6] in (b"GIF87a", b"GIF89a") and len(data) >= 14 and data[-1:] == b";":
        return *struct.unpack("<HH", data[6:10]), "gif"
    if data.startswith(b"\xff\xd8"):
        pos = 2
        while pos + 4 <= len(data):
            if data[pos] != 255:
                break
            while pos < len(data) and data[pos] == 255:
                pos += 1
            marker = data[pos]
            pos += 1
            if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
                continue
            size = int.from_bytes(data[pos:pos + 2], "big")
            if size < 2 or pos + size > len(data):
                break
            if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF) and size >= 8:
                if b"\xff\xd9" not in data[pos + size:]:
                    break
                height, width = struct.unpack(">HH", data[pos + 3:pos + 7])
                return width, height, "jpg"
            pos += size
        raise ValueError("JPEG is truncated or has no valid frame")
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP" and len(data) >= 30:
        if int.from_bytes(data[4:8], "little") + 8 != len(data):
            raise ValueError("WebP is truncated")
        kind, body = data[12:16], data[20:]
        if kind == b"VP8X":
            return int.from_bytes(body[4:7], "little") + 1, int.from_bytes(body[7:10], "little") + 1, "webp"
        if kind == b"VP8 " and body[3:6] == b"\x9d\x01\x2a":
            width, height = struct.unpack("<HH", body[6:10])
            return width & 0x3FFF, height & 0x3FFF, "webp"
        if kind == b"VP8L" and body[0] == 0x2F:
            value = int.from_bytes(body[1:5], "little")
            return (value & 0x3FFF) + 1, ((value >> 14) & 0x3FFF) + 1, "webp"
        raise ValueError("Unsupported WebP frame")
    if data.startswith(b"BM") and len(data) >= 54:
        if int.from_bytes(data[2:6], "little") != len(data):
            raise ValueError("BMP is truncated")
        width, height = struct.unpack("<ii", data[18:26])
        return abs(width), abs(height), "bmp"
    if data.lstrip().startswith((b"<", b"\xef\xbb\xbf")):
        if re.search(br"<!\s*(?:DOCTYPE|ENTITY)", data, re.I):
            raise ValueError("SVG declarations and entities are not supported")
        root = ET.fromstring(data)
        if root.tag.rsplit("}", 1)[-1] != "svg":
            raise ValueError("This XML document is not an SVG image")
        viewbox = [float(n) for n in re.split(r"[\s,]+", root.get("viewBox", "").strip()) if n]
        def pixels(value):
            match = re.fullmatch(r"([\d.]+)\s*(px|pt|pc|in|cm|mm)?", value or "")
            if not match:
                return None
            return float(match[1]) * {None: 1, "px": 1, "pt": 96 / 72, "pc": 16, "in": 96, "cm": 96 / 2.54, "mm": 96 / 25.4}[match[2]]
        width, height = pixels(root.get("width")), pixels(root.get("height"))
        if len(viewbox) == 4 and viewbox[2] > 0 and viewbox[3] > 0:
            width = width or (height * viewbox[2] / viewbox[3] if height else viewbox[2])
            height = height or width * viewbox[3] / viewbox[2]
        # SVG's intrinsic viewport defaults when no dimensions/viewBox are specified.
        return width or 300, height or 150, "svg"
    raise ValueError("Unsupported or damaged image. Supported: PNG, JPEG, GIF, WebP, SVG, BMP")


def stage(path, on, cache):
    source = Path(path)
    cache = Path(cache)
    if not source.is_absolute() or (on is not None and (not isinstance(on, str) or not on)):
        raise ValueError("An absolute image path and valid source machine are required")
    cache.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".image-", dir=cache) as temp:
        if on is not None:
            receipt = download(on, path, temp)
            snapshot = Path(receipt["path"])
        else:
            snapshot = Path(temp) / "payload"
            fd = os.open(source, os.O_RDONLY | os.O_NONBLOCK)
            try:
                before = os.fstat(fd)
                if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_BYTES:
                    raise ValueError("Select a regular image no larger than 64 MiB")
                with os.fdopen(fd, "rb", closefd=False) as inp, snapshot.open("xb") as out:
                    while block := inp.read(1024 * 1024):
                        out.write(block)
                after = os.fstat(fd)
                if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                    raise RuntimeError("Image changed while reading; retry when it stops changing")
            finally:
                os.close(fd)
        if snapshot.stat().st_size > MAX_BYTES:
            raise ValueError("Image previews support files up to 64 MiB")
        data = snapshot.read_bytes()
        width, height, extension = dimensions(data)
        if not all(math.isfinite(n) and n > 0 for n in (width, height)) or width * height > MAX_PIXELS:
            raise ValueError("Invalid image dimensions or image exceeds 64 million pixels")
        digest = hashlib.sha256(data).hexdigest()
        destination = cache / f"{digest}.{extension}"
        try:
            os.link(snapshot, destination)
        except FileExistsError:
            if destination.read_bytes() != data:
                raise RuntimeError(f"Cached image failed integrity verification: {destination}")
        return {"path": f"data/vsc-editor/images/{destination.name}", "width": width, "height": height, "size": len(data)}


if __name__ == "__main__":
    try:
        request = json.loads(sys.argv[1])
        print(json.dumps(stage(request["path"], request.get("on"), request["cache"])))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
