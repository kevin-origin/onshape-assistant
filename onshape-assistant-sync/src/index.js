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

    // PUT /api/compliance/heartbeat — extension heartbeat (no auth, extension calls directly)
    if (path === "/api/compliance/heartbeat" && request.method === "PUT") {
      let body;
      try { body = await request.json(); } catch { return json({ ok: true }, corsHeaders); }
      const email = body.email?.toLowerCase();
      if (email) {
        await env.MERGE_PERMS.put(`heartbeat:${email}`, JSON.stringify({
          email,
          timestamp: body.timestamp || new Date().toISOString(),
          receivedAt: new Date().toISOString(),
        }), { expirationTtl: 600 }); // 10-min TTL
      }
      return json({ ok: true }, corsHeaders);
    }

    // POST /api/webhook/onshape — Onshape webhook receiver (no auth, Onshape calls this directly)
    if (path === "/api/webhook/onshape" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ ok: true }, corsHeaders); }
      const { documentId, versionId, messageId, userId: payloadUserId, event: evt, timestamp } = body;

      if (documentId && (versionId || messageId || payloadUserId)) {
        // Dedup — each event fires N webhooks (one per registered user); process only once
        const dedupKey = `processed:${messageId || versionId || (payloadUserId + documentId)}`;
        const alreadyProcessed = await env.MERGE_PERMS.get(dedupKey);
        if (!alreadyProcessed) {
          await env.MERGE_PERMS.put(dedupKey, "1", { expirationTtl: 3600 }); // 1hr TTL

          // Resolve creator: export/translation events carry userId directly; version events need lookup
          let createdBy = null;
          if (payloadUserId) {
            const storedEmail = await env.MERGE_PERMS.get(`userid:${payloadUserId}`);
            if (storedEmail) createdBy = { email: storedEmail, id: payloadUserId };
          }
          if (!createdBy && versionId) {
            createdBy = await onshapeLookupVersionCreator(documentId, versionId, env);
          }

          if (createdBy?.email) {
            const record = {
              timestamp: timestamp || new Date().toISOString(),
              event: evt || "unknown",
              documentId,
              versionId: versionId || null,
              receivedAt: new Date().toISOString(),
            };
            await env.MERGE_PERMS.put(`active:${createdBy.email}`, JSON.stringify(record), { expirationTtl: 7200 });

            // Violation check — no heartbeat means extension wasn't running
            const whitelist = await env.MERGE_PERMS.get("__whitelisted_docs__", "json") || [];
            const heartbeat = await env.MERGE_PERMS.get(`heartbeat:${createdBy.email}`);
            if (!heartbeat && !whitelist.includes(documentId)) {
              const userId = createdBy.id || await env.MERGE_PERMS.get(`emailid:${createdBy.email}`);
              if (userId) {
                const violationRecord = {
                  email: createdBy.email,
                  userId,
                  documentId,
                  versionId: versionId || null,
                  event: evt || "unknown",
                  detectedAt: new Date().toISOString(),
                  reason: "no_heartbeat",
                };
                await demoteUser(userId, createdBy.email, env);
                await env.MERGE_PERMS.put(`violation:${createdBy.email}`, JSON.stringify(violationRecord));
                await notifySlack(violationRecord, env);
              }
            }
          }
        }
      }
      return json({ ok: true }, corsHeaders);
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

    // PUT /api/compliance/user — register a user: store their API keys, resolve their ID→email, register webhook
    if (path === "/api/compliance/user" && request.method === "PUT") {
      const body = await request.json();
      const { accessKey, secretKey } = body;
      if (!accessKey || !secretKey) return json({ error: "accessKey and secretKey required" }, corsHeaders, 400);

      // Resolve user identity using their own keys
      const creds = btoa(`${accessKey}:${secretKey}`);
      const sessResp = await fetch("https://cad.onshape.com/api/v10/users/sessioninfo", {
        headers: { "Authorization": `Basic ${creds}`, "Accept": "application/json" },
      });
      if (!sessResp.ok) return json({ error: "Invalid API keys" }, corsHeaders, 400);
      const sess = await sessResp.json();
      const email = sess.email?.toLowerCase();
      const userId = sess.id;
      if (!email || !userId) return json({ error: "Could not resolve user identity" }, corsHeaders, 400);

      // Store ID→email and email→ID mappings for webhook handler lookups
      await env.MERGE_PERMS.put(`userid:${userId}`, email);
      await env.MERGE_PERMS.put(`emailid:${email}`, userId);

      // Store API keys for this user (for future use / webhook re-registration)
      await env.MERGE_PERMS.put(`userkeys:${email}`, JSON.stringify({ accessKey, secretKey }));

      // Delete existing webhook if any (prevent accumulation on re-registration)
      const existingWebhookId = await env.MERGE_PERMS.get(`webhookid:${email}`);
      if (existingWebhookId) {
        await fetch(`https://cad.onshape.com/api/v10/webhooks/${existingWebhookId}`, {
          method: "DELETE",
          headers: { "Authorization": `Basic ${creds}`, "Accept": "application/json" },
        }).catch(() => {});
      }

      // Register webhook for this user using their own keys
      const whResp = await fetch("https://cad.onshape.com/api/v10/webhooks", {
        method: "POST",
        headers: { "Authorization": `Basic ${creds}`, "Accept": "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          events: [
            "onshape.model.lifecycle.createversion",
            "onshape.model.lifecycle.createworkspace",
            "onshape.model.translation.complete",
            "onshape.model.export",
            "onshape.model.lifecycle.deleted",
          ],
          companyId: "6810c247e7c40668c32816a6",
          options: { collapseEvents: false },
          url: "https://onshape-assistant-sync.artilabot.workers.dev/api/webhook/onshape",
          clientData: "compliance-monitor",
          isTransient: false,
        }),
      });
      const wh = await whResp.json();
      if (wh.id) {
        await env.MERGE_PERMS.put(`webhookid:${email}`, wh.id);
      }

      return json({ ok: true, email, userId, webhookId: wh.id || null }, corsHeaders);
    }

    // GET /api/compliance/whitelist — list whitelisted docs (auth required)
    if (path === "/api/compliance/whitelist" && request.method === "GET") {
      const val = await env.MERGE_PERMS.get("__whitelisted_docs__", "json") || [];
      return json({ whitelistedDocs: val }, corsHeaders);
    }

    // PUT /api/compliance/whitelist/:docId — add doc to whitelist (auth required)
    // DELETE /api/compliance/whitelist/:docId — remove doc from whitelist (auth required)
    const whitelistMatch = path.match(/^\/api\/compliance\/whitelist\/([a-f0-9]+)$/);
    if (whitelistMatch) {
      const docId = whitelistMatch[1];
      const current = await env.MERGE_PERMS.get("__whitelisted_docs__", "json") || [];
      if (request.method === "PUT") {
        if (!current.includes(docId)) current.push(docId);
        await env.MERGE_PERMS.put("__whitelisted_docs__", JSON.stringify(current));
        return json({ ok: true, action: "whitelisted", docId, whitelistedDocs: current }, corsHeaders);
      }
      if (request.method === "DELETE") {
        const updated = current.filter(id => id !== docId);
        await env.MERGE_PERMS.put("__whitelisted_docs__", JSON.stringify(updated));
        return json({ ok: true, action: "removed", docId, whitelistedDocs: updated }, corsHeaders);
      }
    }

    // GET /api/compliance/violations — list all violation records (auth required)
    if (path === "/api/compliance/violations" && request.method === "GET") {
      const list = await env.MERGE_PERMS.list({ prefix: "violation:" });
      const violations = await Promise.all(list.keys.map(async ({ name }) => {
        const val = await env.MERGE_PERMS.get(name, "json");
        return val;
      }));
      return json({ violations }, corsHeaders);
    }

    // DELETE /api/compliance/violations/:email — clear one user's violation (auth required)
    const violationUserMatch = path.match(/^\/api\/compliance\/violations\/(.+)$/);
    if (violationUserMatch && request.method === "DELETE") {
      const email = decodeURIComponent(violationUserMatch[1]).toLowerCase();
      await env.MERGE_PERMS.delete(`violation:${email}`);
      return json({ ok: true, cleared: email }, corsHeaders);
    }

    // DELETE /api/compliance/violations — clear all violation records (auth required)
    if (path === "/api/compliance/violations" && request.method === "DELETE") {
      const list = await env.MERGE_PERMS.list({ prefix: "violation:" });
      await Promise.all(list.keys.map(({ name }) => env.MERGE_PERMS.delete(name)));
      return json({ ok: true, cleared: list.keys.length }, corsHeaders);
    }

    // GET /api/compliance/heartbeats — list all users with active heartbeats (auth required)
    if (path === "/api/compliance/heartbeats" && request.method === "GET") {
      const list = await env.MERGE_PERMS.list({ prefix: "heartbeat:" });
      const users = await Promise.all(list.keys.map(async ({ name }) => {
        const val = await env.MERGE_PERMS.get(name, "json");
        return { email: name.slice("heartbeat:".length), ...val };
      }));
      return json({ users }, corsHeaders);
    }

    // GET /api/compliance/active — list all recently active users (auth required)
    if (path === "/api/compliance/active" && request.method === "GET") {
      const list = await env.MERGE_PERMS.list({ prefix: "active:" });
      const users = await Promise.all(list.keys.map(async ({ name }) => {
        const val = await env.MERGE_PERMS.get(name, "json");
        return { email: name.slice("active:".length), ...val };
      }));
      return json({ users }, corsHeaders);
    }

    // DELETE /api/compliance/active — clear all active entries (auth required)
    if (path === "/api/compliance/active" && request.method === "DELETE") {
      const list = await env.MERGE_PERMS.list({ prefix: "active:" });
      await Promise.all(list.keys.map(({ name }) => env.MERGE_PERMS.delete(name)));
      return json({ ok: true, cleared: list.keys.length }, corsHeaders);
    }

    // GET /api/compliance/active/:email — check specific user (auth required)
    const activeMatch = path.match(/^\/api\/compliance\/active\/(.+)$/);
    if (activeMatch && request.method === "GET") {
      const email = decodeURIComponent(activeMatch[1]);
      const val = await env.MERGE_PERMS.get(`active:${email}`, "json");
      return json({ email, active: val !== null, data: val }, corsHeaders);
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

async function demoteUser(userId, email, env) {
  try {
    const creds = btoa(`${env.ONSHAPE_ACCESS_KEY}:${env.ONSHAPE_SECRET_KEY}`);
    const companyId = "6810c247e7c40668c32816a6";
    await fetch(`https://cad.onshape.com/api/v10/companies/${companyId}/users/${userId}`, {
      method: "POST",
      headers: { "Authorization": `Basic ${creds}`, "Accept": "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ admin: false, light: false, email, companyId }),
    });
  } catch { /* non-critical — violation is already recorded */ }
}

async function onshapeLookupVersionCreator(documentId, versionId, env) {
  try {
    const creds = btoa(`${env.ONSHAPE_ACCESS_KEY}:${env.ONSHAPE_SECRET_KEY}`);
    const resp = await fetch(
      `https://cad.onshape.com/api/v10/documents/d/${documentId}/versions/${versionId}`,
      { headers: { "Authorization": `Basic ${creds}`, "Accept": "application/json" } }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    const cb = data.creator;
    if (!cb?.id) return null;

    // First try: look up email from stored ID→email mapping (populated when user was registered)
    const storedEmail = await env.MERGE_PERMS.get(`userid:${cb.id}`);
    if (storedEmail) return { email: storedEmail, id: cb.id, name: cb.name };

    // Fallback: try users API (works for some accounts)
    const userResp = await fetch(
      `https://cad.onshape.com/api/v10/users/${cb.id}`,
      { headers: { "Authorization": `Basic ${creds}`, "Accept": "application/json" } }
    );
    if (!userResp.ok) return null;
    const user = await userResp.json();
    if (!user?.email) return null;
    return { email: user.email.toLowerCase(), id: cb.id, name: cb.name };
  } catch {
    return null;
  }
}

async function notifySlack(violation, env) {
  if (!env.SLACK_WEBHOOK_URL) return;
  const eventLabel = {
    "onshape.model.lifecycle.createversion": "created a version",
    "onshape.model.lifecycle.createworkspace": "created a workspace",
    "onshape.model.translation.complete": "exported a file",
    "onshape.model.export": "exported a file",
    "onshape.model.lifecycle.deleted": "deleted a document",
  }[violation.event] || violation.event;
  const docUrl = `https://cad.onshape.com/documents/${violation.documentId}`;
  const istTime = new Date(new Date(violation.detectedAt).getTime() + 5.5 * 60 * 60 * 1000)
    .toISOString().replace("T", " ").replace(/\.\d+Z$/, " IST");
  const text = `:warning: *Compliance violation detected*\n*User:* ${violation.email}\n*Action:* ${eventLabel}\n*Document:* <${docUrl}|${violation.documentId}>\n*Time:* ${istTime}\n*Action taken:* Admin rights revoked`;
  await fetch(env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  }).catch(() => {});
}

function json(data, corsHeaders, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}
