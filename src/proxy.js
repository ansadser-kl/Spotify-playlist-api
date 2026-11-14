/**
 * Optional outbound proxy. Node's global fetch doesn't read HTTP(S)_PROXY env
 * by itself, so when PROXY_URL/HTTPS_PROXY is set we swap in undici's fetch
 * with a ProxyAgent. This is what makes a datacenter deployment (Render,
 * Railway, Fly, …) survive upstream Cloudflare IP blocks.
 */
export async function installProxy(url) {
  if (!url) return false;

  const { fetch: undiciFetch, ProxyAgent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new ProxyAgent(url));
  globalThis.fetch = undiciFetch;
  return true;
}
