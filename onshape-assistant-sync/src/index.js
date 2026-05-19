// Cloudflare Worker — Onshape Assistant merge permissions sync
// Stores per-document merge owner data in KV so all extension instances share it.

const COMPANY_ID = "6810c247e7c40668c32816a6";
const SYNC_SERVER = "https://onshape-assistant-sync.artilabot.workers.dev";
const ONSHAPE_BASE = "https://cad.onshape.com";
const WEBHOOK_EVENTS = [
  "onshape.model.lifecycle.createversion",
  "onshape.model.lifecycle.createworkspace",
  "onshape.model.translation.complete",
  "onshape.model.export",
  "onshape.model.lifecycle.deleted",
];

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

    // GET /api/disabled-folder-names — public, no auth; returns list of top-level folder names where extension is disabled
    if (path === "/api/disabled-folder-names" && request.method === "GET") {
      const val = await env.MERGE_PERMS.get("__disabled_folder_names__", "json");
      return json({ disabledFolderNames: val || [] }, corsHeaders);
    }

    // POST /api/compliance/extension-event — extension event record (no auth, extension calls directly)
    // Body: { email, event, documentId, timestamp }
    if (path === "/api/compliance/extension-event" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ ok: true }, corsHeaders); }
      const email = body.email?.toLowerCase();
      const event = body.event;
      const documentId = body.documentId;
      if (email && event && documentId) {
        await env.DB.prepare(
          "INSERT OR REPLACE INTO extension_events (email, event, documentId, recordedAt) VALUES (?, ?, ?, datetime('now'))"
        ).bind(email, event, documentId).run();
      }
      return json({ ok: true }, corsHeaders);
    }

    // PUT /api/compliance/heartbeat — extension heartbeat (no auth, extension calls directly)
    if (path === "/api/compliance/heartbeat" && request.method === "PUT") {
      let body;
      try { body = await request.json(); } catch { return json({ ok: true }, corsHeaders); }
      const email = body.email?.toLowerCase();
      if (email) {
        // Skip write if a heartbeat was stored within the last 55 minutes.
        // Extension pings every 5 min; only refresh when nearly expired (~1 write/60min/user).
        const existing = await env.DB.prepare(
          "SELECT receivedAt FROM heartbeats WHERE email = ?"
        ).bind(email).first();
        const ageMs = existing?.receivedAt
          ? Date.now() - new Date(existing.receivedAt).getTime()
          : Infinity;
        if (!existing || ageMs > 55 * 60 * 1000) {
          await env.DB.prepare(
            "INSERT OR REPLACE INTO heartbeats (email, timestamp, receivedAt) VALUES (?, ?, ?)"
          ).bind(email, body.timestamp || new Date().toISOString(), new Date().toISOString()).run();
        }
      }
      return json({ ok: true }, corsHeaders);
    }

    // POST /api/webhook/onshape — Onshape webhook receiver (no auth, Onshape calls this directly)
    // Deduplicates multi-user webhook fan-out by messageId/versionId, resolves creator email,
    // records active event, and triggers demotion + Slack alert if no heartbeat was present.
    if (path === "/api/webhook/onshape" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ ok: true }, corsHeaders); }
      const { documentId, versionId, messageId, userId: payloadUserId, event: evt, timestamp } = body;

      if (documentId && (versionId || messageId || payloadUserId)) {
        // Dedup — each event fires N webhooks (one per registered user); process only once.
        // INSERT OR IGNORE is atomic in SQLite — exactly one concurrent request wins (meta.changes===1).
        // Do NOT SELECT first: a SELECT+INSERT pattern is racy under concurrent webhook fan-out.
        // versionId is consistent across all N webhook deliveries of the same event.
        // messageId is unique per delivery — never use it as primary dedup key.
        const dedupId = versionId || (payloadUserId + documentId) || messageId;
        const { meta: dedupMeta } = await env.DB.prepare(
          "INSERT OR IGNORE INTO processed_events (messageId, createdAt) VALUES (?, ?)"
        ).bind(dedupId, new Date().toISOString()).run();
        if (dedupMeta.changes === 1) {

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
            await env.DB.prepare(
              "INSERT OR REPLACE INTO active_users (email, event, documentId, versionId, timestamp, receivedAt) VALUES (?, ?, ?, ?, ?, ?)"
            ).bind(
              createdBy.email,
              record.event,
              record.documentId,
              record.versionId || null,
              record.timestamp,
              record.receivedAt
            ).run();

            // Violation check — no extension event means extension wasn't running
            const whitelist = await env.MERGE_PERMS.get("__whitelisted_docs__", "json") || [];
            const extEvent = await env.DB.prepare(
              "SELECT recordedAt FROM extension_events WHERE email = ? AND event = ? AND documentId = ? AND recordedAt > datetime('now', '-5 minutes')"
            ).bind(createdBy.email, evt, documentId).first();
            if (!extEvent && !whitelist.includes(documentId)) {
              const userId = createdBy.id || await env.MERGE_PERMS.get(`emailid:${createdBy.email}`);
              if (userId) {
                const violationRecord = {
                  email: createdBy.email,
                  userId,
                  documentId,
                  versionId: versionId || null,
                  event: evt || "unknown",
                  detectedAt: new Date().toISOString(),
                  reason: "no_extension_event",
                };
                await demoteUser(userId, createdBy.email, env);
                await env.DB.prepare(
                  "INSERT OR REPLACE INTO violations (email, userId, documentId, versionId, event, detectedAt, reason) VALUES (?, ?, ?, ?, ?, ?, ?)"
                ).bind(
                  violationRecord.email,
                  violationRecord.userId,
                  violationRecord.documentId,
                  violationRecord.versionId || null,
                  violationRecord.event,
                  violationRecord.detectedAt,
                  violationRecord.reason
                ).run();
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

    // PUT /api/disabled-folder-names — admin only, sets list of top-level folder names where extension is disabled
    if (path === "/api/disabled-folder-names" && request.method === "PUT") {
      const body = await request.json();
      if (!Array.isArray(body.disabledFolderNames)) {
        return json({ error: "disabledFolderNames must be an array" }, corsHeaders, 400);
      }
      const names = body.disabledFolderNames;
      await env.MERGE_PERMS.put("__disabled_folder_names__", JSON.stringify(names));
      return json({ ok: true, disabledFolderNames: names }, corsHeaders);
    }

    // PUT /api/compliance/user — register a user: store their API keys, resolve their ID→email, register webhook
    // Deletes any existing webhook for the user before creating a new one (prevents accumulation).
    // Body: { accessKey, secretKey }. Returns { ok, email, userId, webhookId }.
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

      const webhookId = await reRegisterWebhookForUser(email, { accessKey, secretKey }, env);
      return json({ ok: true, email, userId, webhookId: webhookId || null }, corsHeaders);
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
      const { results } = await env.DB.prepare("SELECT * FROM violations").all();
      return json({ violations: results }, corsHeaders);
    }

    // DELETE /api/compliance/violations/:email — clear one user's violation (auth required)
    const violationUserMatch = path.match(/^\/api\/compliance\/violations\/(.+)$/);
    if (violationUserMatch && request.method === "DELETE") {
      const email = decodeURIComponent(violationUserMatch[1]).toLowerCase();
      await env.DB.prepare("DELETE FROM violations WHERE email = ?").bind(email).run();
      return json({ ok: true, cleared: email }, corsHeaders);
    }

    // DELETE /api/compliance/violations — clear all violation records (auth required)
    if (path === "/api/compliance/violations" && request.method === "DELETE") {
      const { meta } = await env.DB.prepare("DELETE FROM violations").run();
      return json({ ok: true, cleared: meta.changes }, corsHeaders);
    }

    // GET /api/compliance/heartbeats — list all users with active heartbeats (auth required)
    if (path === "/api/compliance/heartbeats" && request.method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM heartbeats").all();
      return json({ users: results }, corsHeaders);
    }

    // GET /api/compliance/active — list all recently active users (auth required)
    if (path === "/api/compliance/active" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT * FROM active_users WHERE receivedAt > datetime('now', '-2 hours')"
      ).all();
      return json({ users: results }, corsHeaders);
    }

    // DELETE /api/compliance/active — clear all active entries (auth required)
    if (path === "/api/compliance/active" && request.method === "DELETE") {
      const { meta } = await env.DB.prepare("DELETE FROM active_users").run();
      return json({ ok: true, cleared: meta.changes }, corsHeaders);
    }

    // GET /api/compliance/active/:email — check specific user (auth required)
    const activeMatch = path.match(/^\/api\/compliance\/active\/(.+)$/);
    if (activeMatch && request.method === "GET") {
      const email = decodeURIComponent(activeMatch[1]);
      const val = await env.DB.prepare(
        "SELECT * FROM active_users WHERE email = ?"
      ).bind(email).first();
      return json({ email, active: val !== null, data: val || null }, corsHeaders);
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

  async scheduled(event, env, ctx) {
    // --- D1 cleanup (stale row expiry, replacing KV TTLs) ---
    await env.DB.prepare(
      "DELETE FROM processed_events WHERE createdAt < datetime('now', '-2 hours')"
    ).run();
    await env.DB.prepare(
      "DELETE FROM active_users WHERE receivedAt < datetime('now', '-3 hours')"
    ).run();
    await env.DB.prepare(
      "DELETE FROM extension_events WHERE recordedAt < datetime('now', '-10 minutes')"
    ).run();
    // Violations: keep indefinitely — only manual delete clears them

    // --- Daily webhook re-registration for all enrolled users ---
    const { keys } = await env.MERGE_PERMS.list({ prefix: "userkeys:" });
    for (const { name } of keys) {
      const email = name.slice("userkeys:".length);
      const userKeys = await env.MERGE_PERMS.get(name, "json");
      if (userKeys) {
        try {
          await reRegisterWebhookForUser(email, userKeys, env);
        } catch (e) {
          console.error(`[webhook-refresh] failed for ${email}: ${e.message}`);
        }
      }
    }
  },
};

/**
 * Deletes the user's existing webhook (if any) and registers a fresh one.
 * Used by PUT /api/compliance/user and the daily scheduled cron.
 */
async function reRegisterWebhookForUser(email, keys, env) {
  // Delete old webhook if we have its ID
  const oldId = await env.MERGE_PERMS.get(`webhookid:${email}`);
  if (oldId) {
    try {
      await onshapeApiRequest("DELETE", `/api/v10/webhooks/${oldId}`, null, keys);
    } catch { /* non-critical — may already be gone */ }
    await env.MERGE_PERMS.delete(`webhookid:${email}`);
  }

  // Register fresh webhook
  const data = await onshapeApiRequest("POST", "/api/v10/webhooks", {
    events: WEBHOOK_EVENTS,
    companyId: COMPANY_ID,
    options: { collapseEvents: false },
    url: `${SYNC_SERVER}/api/webhook/onshape`,
    clientData: "compliance-monitor",
    description: "Onshape Assistant compliance monitor",
    isTransient: false,
  }, keys);

  if (data?.id) {
    await env.MERGE_PERMS.put(`webhookid:${email}`, data.id);
  }
  return data?.id || null;
}

/**
 * Makes an Onshape API request using Basic auth (accessKey:secretKey).
 */
async function onshapeApiRequest(method, path, body, keys) {
  const creds = btoa(`${keys.accessKey}:${keys.secretKey}`);
  const headers = { "Authorization": `Basic ${creds}`, "Accept": "application/json" };
  const init = { method, headers };
  if (body) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const resp = await fetch(`${ONSHAPE_BASE}${path}`, init);
  if (!resp.ok && method !== "DELETE") throw new Error(`Onshape API ${method} ${path} → ${resp.status}`);
  if (method === "DELETE") return null;
  return resp.json();
}

/**
 * Revokes admin rights for a user as a compliance violation response.
 * Uses the worker's own ONSHAPE_ACCESS_KEY/SECRET_KEY (not the user's keys).
 * Non-critical: failure is silently swallowed since the violation is already recorded.
 * @param {string} userId - Onshape user ID to demote.
 * @param {string} email - User email (passed to Onshape API body).
 * @param {object} env - Cloudflare Worker env bindings.
 */
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

/**
 * Resolves the creator email for an Onshape document version.
 * First tries the KV `userid:{id}` cache (populated during user registration).
 * Falls back to GET /api/v10/users/{id} via the worker's admin keys.
 * Returns null if resolution fails (user not registered, API error, etc.).
 * @param {string} documentId
 * @param {string} versionId
 * @param {object} env - Cloudflare Worker env bindings.
 * @returns {Promise<{email:string, id:string, name:string}|null>}
 */
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

/**
 * Posts a violation alert to Slack via the SLACK_WEBHOOK_URL env var.
 * Message includes user email, action type (human-readable), doc link, and IST timestamp.
 * No-ops silently if SLACK_WEBHOOK_URL is not configured or the POST fails.
 * @param {object} violation - Violation record (email, event, documentId, detectedAt).
 * @param {object} env - Cloudflare Worker env bindings.
 */
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
