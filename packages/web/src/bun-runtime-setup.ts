/**
 * Wasm wiring for the compiled single-file binary.
 *
 * A compiled executable has no `node_modules` next to it, so the two WebAssembly
 * blobs the agent needs have to be handed over as paths inside the executable
 * before anything loads them:
 *
 *   - quickjs.wasm runs codemode scripts (a tool the operator can enable)
 *   - photon_rs_bg.wasm resizes image attachments
 *
 * Both libraries read their wasm through `fs.readFileSync`, which Bun serves from
 * the embedded filesystem, so passing the imported path is enough. Imported by
 * bun-entry.ts before the server starts.
 */

import { setEmbeddedPhotonWasmPath, setEmbeddedQuickJSWasmPath } from "@earendil-works/pi-coding-agent";
import photonWasmPath from "@silvia-odwyer/photon-node/photon_rs_bg.wasm";
import quickjsWasmPath from "quickjs-wasi/quickjs.wasm";

setEmbeddedQuickJSWasmPath(quickjsWasmPath);
setEmbeddedPhotonWasmPath(photonWasmPath);
