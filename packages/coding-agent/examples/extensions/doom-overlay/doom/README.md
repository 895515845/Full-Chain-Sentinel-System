# DOOM build for the overlay demo

This directory is **GPLv2**, not MIT. Everything the license requires travels
with the binary: the license text, the compiled output, and the source it was
compiled from.

| Path | What it is |
| --- | --- |
| `build/doom.js`, `build/doom.wasm` | Emscripten output loaded by the overlay |
| `doomgeneric/` | Copy of [doomgeneric](https://github.com/ozkl/doomgeneric) at `5a7c842f0ccbe6914637abd56efaeaba2ba4a575` (2026-10-05), without its `.git` directory and `screenshots/` |
| `doomgeneric_pi.c` | Platform glue written for this project. It is compiled into the same binary, so it is distributed here under GPLv2 as well |
| `build.sh` | The script that compiles the above, pinned to the same commit |
| `LICENSE` | GPLv2, copied from the vendored source |

The vendored copy has exactly one change against that commit: its `.gitignore`
no longer lists `doomgeneric`. In upstream's layout that name is both the native
build output and the source directory, so the rule also excluded the source from
git and from the npm tarball. This example builds with `emcc`, which writes to
`build/`, so the rule is not needed here.

`doomgeneric/` is the corresponding source: the `emcc` invocation in `build.sh`
compiles it together with `doomgeneric_pi.c`, and nothing else is needed.

To rebuild (requires [Emscripten](https://emscripten.org/) with `emcc` on PATH):

```
./build.sh
```

The shareware WAD is not part of this repository; the extension downloads it on
first run. The rest of the `doom-overlay` example, like the rest of this
repository, is MIT.
