const API = "https://api-v2.soundcloud.com";
const VERSION = "2.0.0";
const DEFAULT_TTL = 60;

export default {
  async fetch(request, env) {
    const requestUrl = new URL(request.url);
    const headers = corsHeaders(request.headers.get("Origin") || "*", env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "GET") return json({ error: { code: "METHOD_NOT_ALLOWED", message: "This read-only wrapper accepts GET requests only." } }, 405, headers);

    try {
      const route = requestUrl.pathname.replace(/\/+$/, "") || "/";
      if (route === "/health") {
        return json({
          ok: true,
          service: "soundcloud-v2-worker",
          version: VERSION,
          configured: Boolean(env.SOUNDCLOUD_CLIENT_ID),
          backend: "https://api-v2.soundcloud.com",
          authentication: "client_id query parameter; no client secret used"
        }, 200, headers);
      }
      if (route === "/") return json(discovery(env), 200, headers);
      if (!env.SOUNDCLOUD_CLIENT_ID?.trim()) {
        throw new HttpError(500, "NOT_CONFIGURED", "Set the SOUNDCLOUD_CLIENT_ID Worker secret.");
      }

      const p = requestUrl.searchParams;
      const limit = parseLimit(p.get("limit"), 20, 200);
      let data;

      if (route === "/search" || route === "/search/tracks" || route === "/search/users" || route === "/search/playlists") {
        const type = route === "/search" ? (p.get("type") || "tracks").toLowerCase() : route.split("/").pop();
        if (!["tracks", "users", "playlists"].includes(type)) throw new HttpError(400, "INVALID_TYPE", "type must be tracks, users, or playlists.");
        const q = required(p.get("q"), "q");
        const query = copyParams(p, ["q", "type", "limit", "offset", "linked_partitioning", "client_id"]);
        query.set("q", q);
        query.set("limit", String(limit));
        if (p.has("offset")) query.set("offset", String(parseOffset(p.get("offset"))));
        if (type === "tracks" && !p.has("access")) query.set("access", "playable,preview,blocked");
        data = await v2Get(`/search/${type}`, query, env);
        data = normalizeCollection(data, type, env.SOUNDCLOUD_CLIENT_ID);
      } else if (route === "/track") {
        const id = required(p.get("id"), "id");
        data = normalizeTrack(await v2Get(`/tracks/${encodeURIComponent(cleanId(id))}`, copyParams(p, ["client_id"]), env), env.SOUNDCLOUD_CLIENT_ID);
      } else if (route === "/tracks") {
        const ids = required(p.get("ids"), "ids").split(",").map(cleanId);
        if (ids.length > 50) throw new HttpError(400, "TOO_MANY_IDS", "ids supports at most 50 comma-separated track IDs per request.");
        const query = copyParams(p, ["ids", "client_id"]);
        query.set("ids", ids.join(","));
        const raw = await v2Get("/tracks", query, env);
        data = Array.isArray(raw) ? raw.map(t => normalizeTrack(t, env.SOUNDCLOUD_CLIENT_ID)) : normalizeCollection(raw, "tracks", env.SOUNDCLOUD_CLIENT_ID);
      } else if (route === "/user") {
        const id = required(p.get("id"), "id");
        data = normalizeUser(await v2Get(`/users/${encodeURIComponent(cleanId(id))}`, copyParams(p, ["client_id"]), env));
      } else if (route === "/user/tracks" || route === "/user/playlists" || route === "/user/likes" || route === "/user/followers" || route === "/user/followings") {
        const id = required(p.get("id"), "id");
        const resource = ({ "/user/tracks": "tracks", "/user/playlists": "playlists", "/user/likes": "likes", "/user/followers": "followers", "/user/followings": "followings" })[route];
        const query = copyParams(p, ["id", "limit", "client_id"]);
        query.set("limit", String(limit));
        data = normalizeCollection(await v2Get(`/users/${encodeURIComponent(cleanId(id))}/${resource}`, query, env), resource === "likes" ? "tracks" : resource === "followings" || resource === "followers" ? "users" : resource, env.SOUNDCLOUD_CLIENT_ID);
      } else if (route === "/playlist" || route === "/playlist/tracks") {
        const id = required(p.get("id"), "id");
        const query = copyParams(p, ["id", "limit", "client_id"]);
        if (route.endsWith("/tracks")) {
          query.set("limit", String(limit));
          data = normalizeCollection(await v2Get(`/playlists/${encodeURIComponent(cleanId(id))}/tracks`, query, env), "tracks", env.SOUNDCLOUD_CLIENT_ID);
        } else {
          data = normalizePlaylist(await v2Get(`/playlists/${encodeURIComponent(cleanId(id))}`, query, env), env.SOUNDCLOUD_CLIENT_ID);
        }
      } else if (route === "/related" || route === "/related/artists") {
        const id = required(p.get("id"), "id");
        const artists = route.endsWith("/artists");
        const query = copyParams(p, ["id", "limit", "client_id"]);
        query.set("limit", String(limit));
        data = normalizeCollection(await v2Get(artists ? `/users/${encodeURIComponent(cleanId(id))}/related` : `/tracks/${encodeURIComponent(cleanId(id))}/related`, query, env), artists ? "users" : "tracks", env.SOUNDCLOUD_CLIENT_ID);
      } else if (route === "/resolve") {
        const target = validateSoundCloudUrl(required(p.get("url"), "url"));
        const query = new URLSearchParams({ url: target });
        data = normalizeResource(await v2Get("/resolve", query, env), env.SOUNDCLOUD_CLIENT_ID);
      } else if (route === "/stream") {
        const id = required(p.get("id"), "id");
        const track = await v2Get(`/tracks/${encodeURIComponent(cleanId(id))}`, new URLSearchParams(), env);
        const transcodings = track?.media?.transcodings || track?.stream_url || [];
        const streams = Array.isArray(transcodings) ? transcodings : [];
        const resolved = [];
        for (const t of streams) {
          if (!t?.url || !t?.format) continue;
          if (resolved.length >= 8) break;
          try {
            const streamUrl = await resolveTranscoding(t.url, env);
            resolved.push({
              preset: t.preset || null,
              quality: t.quality || null,
              protocol: t.format?.protocol || null,
              mime_type: t.format?.mime_type || null,
              url: streamUrl
            });
          } catch (e) {
            resolved.push({ preset: t.preset || null, protocol: t.format?.protocol || null, error: e instanceof HttpError ? e.message : "Could not resolve this transcoding." });
          }
        }
        data = { track: normalizeTrack(track, env.SOUNDCLOUD_CLIENT_ID), access: track?.access || null, transcodings: resolved, note: "Playback URLs may be temporary and are subject to SoundCloud's access and playback rules." };
      } else if (route === "/next") {
        const next = validateNextHref(required(p.get("url"), "url"));
        const type = (p.get("type") || inferCollectionType(next)).toLowerCase();
        data = normalizeCollection(await v2Get(next, new URLSearchParams(), env), type, env.SOUNDCLOUD_CLIENT_ID);
      } else if (route === "/v2" || route.startsWith("/v2/")) {
        const suffix = route === "/v2" ? "/" : route.slice(3);
        const query = copyParams(p, ["client_id"]);
        data = await v2Get(suffix, query, env);
      } else {
        throw new HttpError(404, "NOT_FOUND", "Unknown endpoint. Visit / for the endpoint list.");
      }

      return json({ data }, 200, headers, cacheTtl(route, p, env));
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 502;
      const code = error instanceof HttpError ? error.code : "UPSTREAM_ERROR";
      const message = error instanceof HttpError ? error.message : "The internal SoundCloud API request failed.";
      const details = error instanceof HttpError && error.details ? { details: error.details } : {};
      return json({ error: { code, message, ...details } }, status, headers);
    }
  }
};

function discovery(env) {
  return {
    name: "SoundCloud Internal v2 API Worker",
    version: VERSION,
    backend: API,
    configured: Boolean(env.SOUNDCLOUD_CLIENT_ID),
    auth: "SOUNDCLOUD_CLIENT_ID query parameter; client secret is not used",
    endpoints: {
      search: "/search?q=...&type=tracks|users|playlists&limit=20",
      track: "/track?id=<track-id>",
      batchTracks: "/tracks?ids=<id,id,...>",
      user: "/user?id=<user-id>",
      userTracks: "/user/tracks?id=<user-id>&limit=20",
      userPlaylists: "/user/playlists?id=<user-id>&limit=20",
      userLikes: "/user/likes?id=<user-id>&limit=20",
      followers: "/user/followers?id=<user-id>&limit=20",
      followings: "/user/followings?id=<user-id>&limit=20",
      playlist: "/playlist?id=<playlist-id>",
      playlistTracks: "/playlist/tracks?id=<playlist-id>&limit=20",
      relatedTracks: "/related?id=<track-id>&limit=10",
      relatedArtists: "/related/artists?id=<user-id>&limit=10",
      stream: "/stream?id=<track-id>",
      resolve: "/resolve?url=<soundcloud-url>",
      pagination: "/next?url=<encoded-next_href>&type=tracks|users|playlists",
      rawV2: "/v2/<internal-api-path>?<upstream-query-parameters>",
      health: "/health"
    },
    docs: "README.md",
    disclaimer: "This wrapper relies on an undocumented internal API that can change or be blocked without notice."
  };
}

function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || "*").split(",").map(x => x.trim()).filter(Boolean);
  return {
    "Access-Control-Allow-Origin": allowed.includes("*") ? "*" : allowed.includes(origin) ? origin : "null",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff"
  };
}
class HttpError extends Error {
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
}
function json(value, status = 200, headers = {}, ttl = 0) {
  const cacheControl = ttl > 0 ? `public, max-age=${ttl}` : "no-store";
  return new Response(JSON.stringify(value), { status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8", "Cache-Control": cacheControl } });
}
function required(value, name) {
  if (!value || !value.trim()) throw new HttpError(400, "MISSING_PARAMETER", `Missing required parameter: ${name}.`);
  return value.trim();
}
function parseLimit(value, fallback, max) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "INVALID_LIMIT", "limit must be a positive integer.");
  return Math.min(n, max);
}
function parseOffset(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, "INVALID_OFFSET", "offset must be a non-negative integer.");
  return n;
}
function cleanId(value) {
  const id = String(value).trim();
  if (!/^[a-zA-Z0-9:_-]+$/.test(id)) throw new HttpError(400, "INVALID_ID", "ID contains unsupported characters.");
  return id;
}
function copyParams(source, excluded = []) {
  const out = new URLSearchParams();
  for (const [key, value] of source.entries()) if (!excluded.includes(key)) out.append(key, value);
  return out;
}
function validateSoundCloudUrl(value) {
  let u;
  try { u = new URL(value); } catch { throw new HttpError(400, "INVALID_URL", "url must be a valid SoundCloud URL."); }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== "https:" || !(host === "soundcloud.com" || host.endsWith(".soundcloud.com") || host === "on.soundcloud.com")) {
    throw new HttpError(400, "INVALID_URL", "Only HTTPS SoundCloud URLs are accepted.");
  }
  return u.toString();
}
function validateNextHref(value) {
  let u;
  try { u = new URL(value, API); } catch { throw new HttpError(400, "INVALID_PAGE_URL", "url must be a valid internal API next_href."); }
  if (u.protocol !== "https:" || u.hostname !== "api-v2.soundcloud.com") throw new HttpError(400, "INVALID_PAGE_URL", "Pagination URL must point to api-v2.soundcloud.com.");
  u.searchParams.delete("client_id");
  return u.pathname + u.search;
}
function inferCollectionType(path) {
  if (/\/users?(\/|$)/.test(path) || /\/followers|\/followings/.test(path)) return "users";
  if (/\/playlists?(\/|$)/.test(path)) return "playlists";
  return "tracks";
}
function cacheTtl(route, params, env) {
  if (["/stream", "/resolve", "/next"].includes(route) || params.has("secret_token")) return 0;
  const n = Number(env.CACHE_TTL_SECONDS ?? DEFAULT_TTL);
  return Number.isFinite(n) ? Math.max(0, Math.min(600, Math.floor(n))) : DEFAULT_TTL;
}
async function v2Get(path, params, env) {
  const url = path.startsWith("https://") ? new URL(path) : new URL(path.startsWith("/") ? path : `/${path}`, API);
  if (url.protocol !== "https:" || url.hostname !== "api-v2.soundcloud.com" || url.port || url.username || url.password) {
    throw new HttpError(400, "INVALID_UPSTREAM_URL", "Only api-v2.soundcloud.com URLs are accepted.");
  }
  if (params) for (const [key, value] of params.entries()) if (key !== "client_id") url.searchParams.append(key, value);
  url.searchParams.set("client_id", env.SOUNDCLOUD_CLIENT_ID.trim());
  const response = await fetch(url.toString(), {
    headers: { "Accept": "application/json, text/plain, */*", "User-Agent": "Mozilla/5.0 (compatible; SoundCloudWorker/2.0)" },
    redirect: "manual"
  });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("Location");
    if (location && /^https:\/\//i.test(location)) return { redirect_url: location, status: response.status };
  }
  const body = await response.text();
  if (!response.ok) {
    const status = response.status === 429 ? 429 : response.status === 401 || response.status === 403 ? 502 : response.status === 404 ? 404 : response.status >= 500 ? 502 : response.status;
    const code = response.status === 429 ? "RATE_LIMITED" : response.status === 401 || response.status === 403 ? "CLIENT_ID_REJECTED" : response.status === 404 ? "RESOURCE_NOT_FOUND" : "SOUNDCLOUD_V2_ERROR";
    throw new HttpError(status, code, response.status === 429 ? "SoundCloud rate-limited this request; retry later." : response.status === 401 || response.status === 403 ? "SoundCloud rejected the client ID or this request is not permitted." : response.status === 404 ? "The requested resource was not found or is unavailable." : "The internal SoundCloud API request failed.", { upstream_status: response.status, upstream_message: safeMessage(body) });
  }
  if (!body) return null;
  try { return JSON.parse(body); } catch { return body; }
}
async function resolveTranscoding(transcodingUrl, env) {
  let url;
  try { url = new URL(transcodingUrl); } catch { throw new HttpError(502, "INVALID_TRANSCODING", "SoundCloud returned an invalid transcoding URL."); }
  if (url.hostname !== "api-v2.soundcloud.com" || url.protocol !== "https:") throw new HttpError(502, "INVALID_TRANSCODING", "SoundCloud returned a transcoding URL outside its internal API host.");
  const result = await v2Get(url.pathname + url.search, new URLSearchParams(), env);
  if (typeof result === "string") return result;
  if (result?.url && /^https:\/\//i.test(result.url)) return result.url;
  throw new HttpError(502, "NO_STREAM_URL", "The transcoding endpoint did not return a playback URL.");
}
function normalizeCollection(raw, type, clientId) {
  const collection = Array.isArray(raw) ? raw : Array.isArray(raw?.collection) ? raw.collection : Array.isArray(raw?.tracks) ? raw.tracks : [];
  const normalizer = type === "users" || type === "followers" || type === "followings" ? normalizeUser : type === "playlists" ? normalizePlaylist : normalizeTrack;
  return {
    items: collection.map(item => normalizer(item, clientId)),
    next: safeNext(raw?.next_href),
    total_results: Number.isFinite(raw?.total_results) ? raw.total_results : null,
    query_urn: raw?.query_urn || null
  };
}
function safeNext(value) {
  if (typeof value !== "string") return null;
  try { const u = new URL(value, API); if (u.hostname !== "api-v2.soundcloud.com" || u.protocol !== "https:") return null; u.searchParams.delete("client_id"); return u.pathname + u.search; } catch { return null; }
}
function normalizeTrack(t = {}, clientId) {
  const id = t.id ?? t.urn ?? null;
  return {
    ...t,
    kind: t.kind || "track",
    id,
    urn: t.urn || (id != null ? `soundcloud:tracks:${id}` : null),
    title: t.title || null,
    permalink_url: t.permalink_url || null,
    artwork_url: t.artwork_url || t.user?.avatar_url || null,
    duration_ms: t.duration ?? null,
    likes_count: t.likes_count ?? t.favoritings_count ?? null,
    user: t.user ? normalizeUser(t.user) : null,
    media: t.media ? { ...t.media, transcodings: Array.isArray(t.media.transcodings) ? t.media.transcodings.map(x => ({ ...x, url: removeClientId(x.url) })) : t.media.transcodings } : t.media,
    client_id: undefined
  };
}
function normalizeUser(u = {}) {
  return { ...u, kind: u.kind || "user", id: u.id ?? u.urn ?? null, urn: u.urn || (u.id != null ? `soundcloud:users:${u.id}` : null), username: u.username || null, permalink_url: u.permalink_url || null, avatar_url: u.avatar_url || null };
}
function normalizePlaylist(p = {}, clientId) {
  return { ...p, kind: p.kind || "playlist", id: p.id ?? p.urn ?? null, urn: p.urn || (p.id != null ? `soundcloud:playlists:${p.id}` : null), title: p.title || null, permalink_url: p.permalink_url || null, artwork_url: p.artwork_url || null, user: p.user ? normalizeUser(p.user) : null, tracks: Array.isArray(p.tracks) ? p.tracks.map(t => normalizeTrack(t, clientId)) : p.tracks };
}
function normalizeResource(r, clientId) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return r;
  const kind = r.kind || "";
  if (kind === "track" || r.urn?.startsWith("soundcloud:tracks:")) return normalizeTrack(r, clientId);
  if (kind === "user" || r.urn?.startsWith("soundcloud:users:")) return normalizeUser(r);
  if (kind.includes("playlist") || r.urn?.startsWith("soundcloud:playlists:")) return normalizePlaylist(r, clientId);
  return r;
}
function removeClientId(value) {
  if (typeof value !== "string") return value;
  try { const u = new URL(value); u.searchParams.delete("client_id"); return u.toString(); } catch { return value; }
}
function safeMessage(body) {
  try { const d = JSON.parse(body); const m = d.message || d.error_description || d.error; return typeof m === "string" ? m.slice(0, 240) : ""; } catch { return ""; }
}
