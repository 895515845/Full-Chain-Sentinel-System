#!/usr/bin/env python3
"""Build a Debian package without dpkg-deb.

dpkg-deb is not available on every macOS host, but the .deb format is just an
ar archive around control.tar.gz and data.tar.gz. This keeps `build-deb.sh`
usable on a plain Xcode machine and produces byte-stable output.
"""

import io
import os
import sys
import tarfile
import time
from pathlib import Path

FIXED_MTIME = int(os.environ.get("SOURCE_DATE_EPOCH", "1750000000"))


def tar_bytes(root: Path, skip_debian: bool) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz", format=tarfile.GNU_FORMAT) as archive:
        for path in sorted(root.rglob("*")):
            rel = path.relative_to(root).as_posix()
            if skip_debian and (rel == "DEBIAN" or rel.startswith("DEBIAN/")):
                continue
            info = tarfile.TarInfo("./" + rel)
            stat = path.lstat()
            info.mtime = FIXED_MTIME
            info.uid = 0
            info.gid = 0
            info.uname = "root"
            info.gname = "root"
            info.mode = stat.st_mode & 0o7777
            if path.is_dir():
                info.type = tarfile.DIRTYPE
                archive.addfile(info)
            elif path.is_symlink():
                info.type = tarfile.SYMTYPE
                info.linkname = os.readlink(path)
                archive.addfile(info)
            elif path.is_file():
                data = path.read_bytes()
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def ar_bytes(members) -> bytes:
    out = io.BytesIO()
    out.write(b"!<arch>\n")
    for name, data in members:
        header = (
            f"{name:<16}{FIXED_MTIME:<12}{0:<6}{0:<6}{'100644':<8}{len(data):<10}`\n"
        ).encode("ascii")
        out.write(header)
        out.write(data)
        if len(data) % 2:
            out.write(b"\n")
    return out.getvalue()


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: debpack.py <staged-dir> <output.deb>", file=sys.stderr)
        return 2
    stage = Path(sys.argv[1]).resolve()
    output = Path(sys.argv[2]).resolve()
    if not (stage / "DEBIAN" / "control").is_file():
        print(f"missing {stage}/DEBIAN/control", file=sys.stderr)
        return 1
    control = tar_bytes(stage / "DEBIAN", skip_debian=False)
    data = tar_bytes(stage, skip_debian=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(
        ar_bytes(
            [
                ("debian-binary", b"2.0\n"),
                ("control.tar.gz", control),
                ("data.tar.gz", data),
            ]
        )
    )
    print(f"built {output} ({output.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
