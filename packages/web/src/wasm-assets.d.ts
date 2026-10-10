// Bun's default loader for .wasm evaluates to a readable path, which in a compiled
// executable points inside the embedded filesystem.
declare module "quickjs-wasi/quickjs.wasm" {
	const path: string;
	export default path;
}

declare module "@silvia-odwyer/photon-node/photon_rs_bg.wasm" {
	const path: string;
	export default path;
}
