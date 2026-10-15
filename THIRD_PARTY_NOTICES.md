# Third-party notices

This repository is MIT (see `LICENSE`), with the exceptions below. Each entry
names the license and where the license text or corresponding source lives.

## DOOM overlay example - GPLv2

`packages/coding-agent/examples/extensions/doom-overlay/doom/` holds a compiled
DOOM (Emscripten output) plus the source it was compiled from.

- Upstream: [doomgeneric](https://github.com/ozkl/doomgeneric), a port of
  [id Software's DOOM](https://github.com/id-Software/DOOM). GPLv2.
- Vendored at commit `5a7c842f0ccbe6914637abd56efaeaba2ba4a575`.
- License text: `doom/LICENSE`; the vendored source keeps its own copy at
  `doom/doomgeneric/LICENSE`.
- This subtree is GPLv2, not MIT. Rebuild steps are in `doom/README.md`.

## Vendored browser bundles - MIT, BSD-3-Clause

`packages/coding-agent/src/core/export-html/vendor/` holds minified third-party
bundles with their license headers intact:

- `highlight.min.js` - Highlight.js v11.9.0, BSD-3-Clause.
- `marked.min.js` - marked v18.0.5, MIT.

## Model Context Protocol SDK

`packages/mcp/LICENSES/modelcontextprotocol-typescript-sdk.txt` holds the
license for the MCP TypeScript SDK.

## npm and container dependencies

npm dependencies keep their own licenses; `node_modules` is not vendored. The
container image defined in `packages/coding-agent/` installs distribution
packages whose licenses apply to that image only.
