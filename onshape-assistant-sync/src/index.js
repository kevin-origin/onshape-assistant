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
  async fetch(request, env, ctx) {
    // Piggyback pending violation checks on every request — cron unreliable on free tier.
    // Non-blocking: response returns immediately, processing happens in background.
    ctx.waitUntil(processPendingChecks(env));

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

    // GET /api/merge-permissions/:docId — public, no auth; extension reads who may merge a doc
    const docMatchPublic = path.match(/^\/api\/merge-permissions\/([a-f0-9]+)$/);
    if (docMatchPublic && request.method === "GET") {
      const docId = docMatchPublic[1];
      const val = await env.MERGE_PERMS.get(docId, "json");
      if (!val) return json({ error: "Not found" }, corsHeaders, 404);
      return json(val, corsHeaders);
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

    // POST /api/webhook/onshape — Onshape webhook receiver (no auth, Onshape calls this directly)
    // Deduplicates multi-user webhook fan-out by messageId/versionId, resolves creator email,
    // records active event, and flags a violation if no extension event was recorded.
    if (path === "/api/webhook/onshape" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ ok: true }, corsHeaders); }
      const { documentId, versionId, messageId, userId: payloadUserId, event: evt, timestamp } = body;

      // Acknowledge immediately so Onshape isn't waiting on our violation check.
      // All processing runs in the background via ctx.waitUntil().
      if (documentId && (versionId || messageId || payloadUserId)) {
        ctx.waitUntil((async () => {
          // Dedup — each event fires N webhooks (one per registered user); process only once.
          // INSERT OR IGNORE is atomic in SQLite — exactly one concurrent request wins (meta.changes===1).
          // Do NOT SELECT first: a SELECT+INSERT pattern is racy under concurrent webhook fan-out.
          // versionId is consistent across all N webhook deliveries of the same event.
          // For translation/export events (no versionId), Onshape stamps each fan-out delivery with
          // a slightly different millisecond timestamp — truncate to seconds so all N deliveries of
          // the same event share one dedupId, while distinct events (seconds apart) remain separate.
          // messageId is unique per delivery — last resort only.
          const timestampSec = timestamp ? timestamp.slice(0, 19) : null;
          const dedupId = versionId || (documentId && evt && timestampSec ? documentId + evt + timestampSec : null) || messageId;
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
              const receivedAt = new Date().toISOString();
              await env.DB.prepare(
                "INSERT OR REPLACE INTO active_users (email, event, documentId, versionId, timestamp, receivedAt) VALUES (?, ?, ?, ?, ?, ?)"
              ).bind(
                createdBy.email,
                evt || "unknown",
                documentId,
                versionId || null,
                timestamp || receivedAt,
                receivedAt
              ).run();

              if (evt === 'onshape.model.lifecycle.deleted') return;

              // Queue violation check — cron processes pending_checks every 5 min.
              // Avoids the Cloudflare free-tier 30s wall-clock kill that broke inline setTimeout.
              await env.DB.prepare(
                "INSERT INTO pending_checks (email, userId, documentId, versionId, event, checkAfter, createdAt) VALUES (?, ?, ?, ?, ?, datetime('now', '+45 seconds'), datetime('now'))"
              ).bind(createdBy.email, createdBy.id || null, documentId, versionId || null, evt || "unknown").run();
            }
          }
        })());
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
    // --- Process pending violation checks ---
    await processPendingChecks(env);

    // --- D1 cleanup (stale row expiry) ---
    await env.DB.prepare(
      "DELETE FROM processed_events WHERE createdAt < datetime('now', '-2 hours')"
    ).run();
    await env.DB.prepare(
      "DELETE FROM active_users WHERE receivedAt < datetime('now', '-3 hours')"
    ).run();
    await env.DB.prepare(
      "DELETE FROM extension_events WHERE recordedAt < datetime('now', '-35 minutes')"
    ).run();
    await env.DB.prepare(
      "DELETE FROM pending_checks WHERE createdAt < datetime('now', '-2 hours')"
    ).run();
    // Violations: keep indefinitely — only manual delete clears them

    // --- Daily webhook re-registration (2 AM cron only) ---
    if (event.cron === "0 2 * * *") {
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
    }
  },
};

/**
 * Processes all pending violation checks whose checkAfter time has passed.
 * Called on every fetch request (non-blocking via ctx.waitUntil) and from the scheduled handler.
 * Deletes each pending_check before checking so concurrent calls don't double-process.
 */
async function processPendingChecks(env) {
  const { results: pending } = await env.DB.prepare(
    "SELECT * FROM pending_checks WHERE checkAfter <= datetime('now')"
  ).all();
  if (!pending.length) return;
  const whitelist = await env.MERGE_PERMS.get("__whitelisted_docs__", "json") || [];
  for (const check of pending) {
    const { meta } = await env.DB.prepare(
      "DELETE FROM pending_checks WHERE id = ? AND checkAfter <= datetime('now')"
    ).bind(check.id).run();
    if (!meta.changes) continue; // another concurrent request already claimed it
    const extEvent = await env.DB.prepare(
      "SELECT recordedAt FROM extension_events WHERE email = ? AND event = ? AND documentId = ? AND recordedAt > datetime('now', '-30 minutes')"
    ).bind(check.email, check.event, check.documentId).first();
    if (!extEvent && !whitelist.includes(check.documentId)) {
      const userId = check.userId || await env.MERGE_PERMS.get(`emailid:${check.email}`);
      if (userId) {
        const violationRecord = {
          email: check.email,
          userId,
          documentId: check.documentId,
          versionId: check.versionId || null,
          event: check.event,
          detectedAt: new Date().toISOString(),
          reason: "no_extension_event",
        };
        const { meta: vMeta } = await env.DB.prepare(
          "INSERT OR IGNORE INTO violations (email, userId, documentId, versionId, event, detectedAt, reason) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(
          violationRecord.email,
          violationRecord.userId,
          violationRecord.documentId,
          violationRecord.versionId || null,
          violationRecord.event,
          violationRecord.detectedAt,
          violationRecord.reason
        ).run();
        if (vMeta.changes === 1) {
          await demoteUser(userId, check.email, env);
          await notifySlack(violationRecord, env);
        }
      }
    }
  }
}

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
