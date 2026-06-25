/**
 * Registers the lazy meshopt decoder loader with @jexs/physics. Importing this
 * module only sets a function pointer — the actual `meshoptimizer` WASM is
 * `import()`ed (and instantiated) by physics ONLY when a glTF that uses
 * EXT_meshopt_compression is first parsed. Apps that never load a compressed
 * mesh never pull the WASM.
 */
import { setMeshoptLoader, type MeshoptDecoder } from "@jexs/physics";

setMeshoptLoader(async (): Promise<MeshoptDecoder> => {
  const { MeshoptDecoder } = await import("meshoptimizer");
  await MeshoptDecoder.ready;
  return MeshoptDecoder;
});
