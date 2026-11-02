// MHM — API (Vercel Serverless Function + Supabase Postgres via PostgREST)
// Routes : GET /api/data · POST /api/post · POST /api/vote · POST /api/comment · POST /api/admin
//          DELETE /api/post/:id · DELETE /api/comment/:postId/:commentId   (modérateur uniquement)
// Variables d'environnement (Vercel) : SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY · ADMIN_PASSWORD
// La clé « service role » reste côté serveur : le navigateur ne parle jamais directement à la base.
const crypto = require("crypto");

const MOODS = ["Stress", "Solitude", "Études", "Famille", "Espoir", "Autre"];
const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const clean = (s) => String(s || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 40);
const newId = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const send = (res, status, data) => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(data));
};

// Appel à l'API REST de Supabase (clé secrète côté serveur uniquement)
async function sb(path, { method = "GET", body, prefer } = {}) {
  const headers = { apikey: SB_KEY, "content-type": "application/json" };
  if (SB_KEY.startsWith("eyJ")) headers.authorization = "Bearer " + SB_KEY; // ancienne clé « service_role » (JWT)
  if (prefer) headers.prefer = prefer;
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { /* réponse vide */ }
  return { ok: r.ok, status: r.status, data };
}

// Anti-spam : une action par clé (IP hachée) et par délai ; renvoie true si trop rapproché
async function limited(key, ms) {
  const r = await sb(`rate_limits?key=eq.${key}&select=at`);
  const last = r.ok && r.data && r.data[0] ? Date.parse(r.data[0].at) : 0;
  if (last && Date.now() - last < ms) return true;
  await sb("rate_limits?on_conflict=key", { method: "POST", body: { key, at: new Date().toISOString() }, prefer: "resolution=merge-duplicates,return=minimal" });
  return false;
}

async function readBody(req) {
  let b = req.body;
  if (b === undefined) { const chunks = []; for await (const c of req) chunks.push(c); b = Buffer.concat(chunks).toString("utf8"); }
  if (Buffer.isBuffer(b)) b = b.toString("utf8");
  if (typeof b === "string") { try { return b ? JSON.parse(b) : null; } catch (e) { return null; } }
  return b && typeof b === "object" ? b : null;
}

module.exports = async (req, res) => {
  try {
    if (!SB_URL || !SB_KEY) return send(res, 500, { error: "server_not_configured" });
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname.replace(/^\/api\/?/, "").replace(/\/+$/, "");
    const secret = process.env.ADMIN_PASSWORD || "";
    const isAdmin = () => {
      const k = String(req.headers["x-admin-key"] || "");
      return secret !== "" && k.length === secret.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(secret));
    };
    const rawIp = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || String(req.headers["x-real-ip"] || "anon");
    const ipHash = crypto.createHash("sha256").update(rawIp).digest("hex").slice(0, 24); // on ne stocke jamais l'IP en clair

    // Liste des histoires (+ totaux de votes, commentaires, vote de l'appareil demandeur)
    if (req.method === "GET" && path === "data") {
      const voter = clean(url.searchParams.get("voter"));
      const r = await sb("rpc/mhm_feed", { method: "POST", body: { p_voter: voter } });
      if (!r.ok) return send(res, 500, { error: "db_error" });
      return send(res, 200, { posts: Array.isArray(r.data) ? r.data : [] });
    }

    // Nouvelle histoire
    if (req.method === "POST" && path === "post") {
      const b = await readBody(req); if (!b) return send(res, 400, { error: "bad_json" });
      const text = String(b.text || "").trim().slice(0, 1200);
      const mood = MOODS.includes(b.mood) ? b.mood : "Autre";
      if (text.length < 20) return send(res, 400, { error: "too_short" });
      if (await limited("p" + ipHash, 20000)) return send(res, 429, { error: "rate_limited" });
      let id = /^p[a-z0-9]{8,24}$/.test(b.id || "") ? b.id : newId("p");
      let r = await sb("posts", { method: "POST", body: { id, text, mood }, prefer: "return=minimal" });
      if (r.status === 409) { id = newId("p"); r = await sb("posts", { method: "POST", body: { id, text, mood }, prefer: "return=minimal" }); }
      if (!r.ok) return send(res, 500, { error: "db_error" });
      return send(res, 200, { id });
    }

    // Vote (un par appareil et par histoire ; v = 1, -1 ou 0 pour annuler)
    if (req.method === "POST" && path === "vote") {
      const b = await readBody(req); if (!b) return send(res, 400, { error: "bad_json" });
      const id = clean(b.id), voter = clean(b.voter), v = b.v === 1 ? 1 : b.v === -1 ? -1 : 0;
      if (!id || !voter) return send(res, 400, { error: "bad_request" });
      const r = v
        ? await sb("votes?on_conflict=post_id,voter", { method: "POST", body: { post_id: id, voter, v }, prefer: "resolution=merge-duplicates,return=minimal" })
        : await sb(`votes?post_id=eq.${id}&voter=eq.${voter}`, { method: "DELETE" });
      if (r.status === 409) return send(res, 404, { error: "not_found" });
      if (!r.ok) return send(res, 500, { error: "db_error" });
      return send(res, 200, { ok: true });
    }

    // Commentaire anonyme (2 à 300 caractères, 60 par histoire, anti-spam)
    if (req.method === "POST" && path === "comment") {
      const b = await readBody(req); if (!b) return send(res, 400, { error: "bad_json" });
      const id = clean(b.id), text = String(b.text || "").trim().slice(0, 300);
      if (!id || text.length < 2) return send(res, 400, { error: "bad_request" });
      if (await limited("c" + ipHash, 6000)) return send(res, 429, { error: "rate_limited" });
      const count = await sb(`comments?post_id=eq.${id}&select=id`);
      if (count.ok && Array.isArray(count.data) && count.data.length >= 60) return send(res, 409, { error: "thread_full" });
      const cid = newId("c");
      const r = await sb("comments", { method: "POST", body: { id: cid, post_id: id, text }, prefer: "return=minimal" });
      if (r.status === 409) return send(res, 404, { error: "not_found" });
      if (!r.ok) return send(res, 500, { error: "db_error" });
      return send(res, 200, { id: cid });
    }

    // Vérification du mot de passe modérateur
    if (req.method === "POST" && path === "admin") {
      const b = await readBody(req);
      return send(res, 200, { ok: !!b && secret !== "" && typeof b.password === "string" && b.password.length === secret.length && crypto.timingSafeEqual(Buffer.from(b.password), Buffer.from(secret)) });
    }

    // Suppressions (modérateur uniquement)
    if (req.method === "DELETE" && path.startsWith("post/")) {
      if (!isAdmin()) return send(res, 403, { error: "forbidden" });
      const r = await sb(`posts?id=eq.${clean(path.slice(5))}`, { method: "DELETE" });   // supprime aussi votes et commentaires (ON DELETE CASCADE)
      return send(res, r.ok ? 200 : 500, r.ok ? { ok: true } : { error: "db_error" });
    }
    if (req.method === "DELETE" && path.startsWith("comment/")) {
      if (!isAdmin()) return send(res, 403, { error: "forbidden" });
      const [, pid, cid] = path.split("/");
      const r = await sb(`comments?id=eq.${clean(cid)}&post_id=eq.${clean(pid)}`, { method: "DELETE" });
      return send(res, r.ok ? 200 : 500, r.ok ? { ok: true } : { error: "db_error" });
    }

    return send(res, 404, { error: "not_found" });
  } catch (e) {
    return send(res, 500, { error: "server_error" });
  }
};
