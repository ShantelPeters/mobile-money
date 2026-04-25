/// <reference types="@cloudflare/workers-types" />

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function cacheControlFor(pathname: string): string {
  return pathname.endsWith("/stellar.toml")
    ? "public, max-age=3600, stale-while-revalidate=86400"
    : "public, max-age=300, stale-while-revalidate=3600";
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const cache = caches.default;

    const cached = await cache.match(request);
    if (cached) {
      const res = new Response(cached.body, cached);
      res.headers.set("cf-cache-status", "HIT");
      for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
      return res;
    }

    const origin = await fetch(request);
    if (!origin.ok) return origin;

    const res = new Response(origin.body, origin);
    res.headers.set("Cache-Control", cacheControlFor(url.pathname));
    res.headers.set("cf-cache-status", "MISS");
    for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);

    await cache.put(request, res.clone());
    return res;
  },
} satisfies ExportedHandler;
