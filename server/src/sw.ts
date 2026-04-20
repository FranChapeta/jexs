/**
 * Returns a default service worker config that caches the client bundle.
 * Used when "sw": {} (empty object) is specified in the listen config.
 */
export function defaultSwConfig(clientScriptPath?: string): Record<string, unknown> {
  const config: Record<string, unknown> = { activate: { claim: true } };
  if (clientScriptPath) {
    config.install = { cache: [clientScriptPath] };
    const prefix = clientScriptPath.replace(/\/[^/]+$/, "") + "/*";
    config.fetch = { strategy: "cache-first", match: prefix };
  }
  return config;
}
