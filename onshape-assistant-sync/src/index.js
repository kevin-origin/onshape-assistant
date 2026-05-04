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

    // GET /api/blocked-emails — public, no auth (list is not sensitive; write is guarded)
    if (path === "/api/blocked-emails" && request.method === "GET") {
      const val = await env.MERGE_PERMS.get("__blocked_emails__", "json");
      return json({ blocked: val || [] }, corsHeaders);
    }

    // GET /api/disabled-docs — public, no auth; returns list of doc IDs where extension is disabled
    if (path === "/api/disabled-docs" && request.method === "GET") {
      const val = await env.MERGE_PERMS.get("__disabled_docs__", "json");
      return json({ disabledDocs: val || [] }, corsHeaders);
    }

    // Auth required for all other /api routes
    const apiKey = request.headers.get("X-API-Key");
    if (apiKey !== env.API_KEY) {
      return json({ error: "Unauthorized" }, corsHeaders, 401);
    }

    // PUT /api/blocked-emails — admin only, updates the kill-switch list
    if (path === "/api/blocked-emails" && request.method === "PUT") {
      const body = await request.json();
      const emails = (body.blocked || []).map(e => e.toLowerCase());
      await env.MERGE_PERMS.put("__blocked_emails__", JSON.stringify(emails));
      return json({ ok: true, blocked: emails }, corsHeaders);
    }

    // PUT /api/disabled-docs/:docId — admin only, adds exactly one doc to the disabled list
    // DELETE /api/disabled-docs/:docId — admin only, removes exactly one doc from the disabled list
    const disabledDocMatch = path.match(/^\/api\/disabled-docs\/([a-f0-9]+)$/);
    if (disabledDocMatch) {
      const docId = disabledDocMatch[1];
      const current = await env.MERGE_PERMS.get("__disabled_docs__", "json") || [];
      if (request.method === "PUT") {
        if (!current.includes(docId)) current.push(docId);
        await env.MERGE_PERMS.put("__disabled_docs__", JSON.stringify(current));
        return json({ ok: true, action: "disabled", docId, disabledDocs: current }, corsHeaders);
      }
      if (request.method === "DELETE") {
        const updated = current.filter(id => id !== docId);
        await env.MERGE_PERMS.put("__disabled_docs__", JSON.stringify(updated));
        return json({ ok: true, action: "enabled", docId, disabledDocs: updated }, corsHeaders);
      }
    }

    // GET /api/merge-permissions — list all docs' perms (skip internal keys)
    if (path === "/api/merge-permissions" && request.method === "GET") {
      const list = await env.MERGE_PERMS.list();
      const result = {};
      for (const key of list.keys) {
        if (key.name.startsWith("__")) continue; // skip internal reserved keys
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
