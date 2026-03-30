// Cloudflare Worker — Onshape Assistant merge permissions sync
// Stores per-document merge owner data in KV so all extension instances share it.

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Health check — public, no auth
    if (path === "/health") {
      return json({ status: "ok" }, corsHeaders);
    }

    // Auth required for all /api routes
    const apiKey = request.headers.get("X-API-Key");
    if (apiKey !== env.API_KEY) {
      return json({ error: "Unauthorized" }, corsHeaders, 401);
    }

    // GET /api/merge-permissions — list all docs' perms
    if (path === "/api/merge-permissions" && request.method === "GET") {
      const list = await env.MERGE_PERMS.list();
      const result = {};
      for (const key of list.keys) {
        const val = await env.MERGE_PERMS.get(key.name, "json");
        if (val) result[key.name] = val;
      }
      return json(result, corsHeaders);
    }

    // Routes for /api/merge-permissions/:docId
    const docMatch = path.match(/^\/api\/merge-permissions\/([a-f0-9]+)$/);
    if (docMatch) {
      const docId = docMatch[1];

      if (request.method === "GET") {
        const val = await env.MERGE_PERMS.get(docId, "json");
        if (!val) return json({ error: "Not found" }, corsHeaders, 404);
        return json(val, corsHeaders);
      }

      if (request.method === "PUT") {
        const body = await request.json();
        await env.MERGE_PERMS.put(docId, JSON.stringify(body));
        return json({ ok: true }, corsHeaders);
      }

      if (request.method === "DELETE") {
        await env.MERGE_PERMS.delete(docId);
        return json({ ok: true }, corsHeaders);
      }
    }

    return json({ error: "Not found" }, corsHeaders, 404);
  },
};

function json(data, corsHeaders, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}
