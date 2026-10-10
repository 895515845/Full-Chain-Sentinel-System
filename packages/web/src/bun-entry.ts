/**
 * Entry point for the compiled single-file binary.
 *
 * Import order matters. The package identity (bun-identity) must be in place
 * before the coding-agent is loaded, because it is read once at module load, and
 * the wasm paths (bun-runtime-setup) must be registered before the libraries that
 * use them load their wasm.
 *
 * Only scripts/build-web-binaries.sh builds from here; the Node entry is index.ts.
 */

import "./bun-identity.ts";
import "./bun-runtime-setup.ts";
import "./index.ts";
