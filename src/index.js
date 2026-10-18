const API_BASE = "https://api.soundcloud.com";
const OEMBED_BASE = "https://soundcloud.com/oembed";
const OPENAPI_URL = "https://developers.soundcloud.com/docs/api/explorer/api.json";
const VERSION = "2.0.0";
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export default {
  async fetch(request, env, ctx) {
    const incoming = new URL(request.url);
    const origin = request.headers.get("Origin") || "*";
    const headers = corsHeaders(origin, env);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

    const route = incoming.pathname.replace(/\/+$/, "") || "/";
    if (route === "/health") {
      return json({
        ok: true,
        service: "soundcloud-worker-api",
        version: VERSION,
        client_id_configured: Boolean(env.SOUNDCLOUD_CLIENT_ID),
        request_authentication: "client_id query parameter; optional Authorization: OAuth <access_token>",
        response_cache_seconds: cacheTtl(env),
      }, 200, headers);
    }
    if (route === "/") return json(apiInfo(Boolean(env.SOUNDCLOUD_CLIENT_ID)), 200, headers);
    if (route === "/favicon.ico") return new Response(null, { status: 204, headers });

    if (!METHODS.has(request.method)) {
      return errorResponse(405, "METHOD_NOT_ALLOWED", "Supported methods: GET, POST, PUT, PATCH, DELETE, OPTIONS.", headers);
    }

    // Optional access key for deployments that should not be an open public proxy.
    if (env.WORKER_API_KEY && !constantTimeEqual(request.headers.get("X-API-Key") || "", env.WORKER_API_KEY)) {
      return errorResponse(401, "WORKER_AUTH_REQUIRED", "Supply the configured X-API-Key header.", headers);
    }

    try {
      if (!env.SOUNDCLOUD_CLIENT_ID && !isOembedRoute(route) && route !== "/openapi.json") {
        throw new ApiError(500, "NOT_CONFIGURED", "Set SOUNDCLOUD_CLIENT_ID in Worker settings before calling the SoundCloud API.");
      }

      if (route === "/openapi.json") {
        if (request.method !== "GET") throw new ApiError(405, "METHOD_NOT_ALLOWED", "/openapi.json supports GET only.");
        const specResponse = await fetch(OPENAPI_URL, { headers: { Accept: "application/json" }, cf: { cacheTtl: 3600, cacheEverything: true } });
        if (!specResponse.ok) throw new ApiError(502, "OPENAPI_UNAVAILABLE", "Could not load SoundCloud's current OpenAPI specification.");
        return new Response(specResponse.body, {
          status: 200,
          headers: { ...headers, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=3600" },
        });
      }

      if (route === "/oembed") {
        if (request.method !== "GET") throw new ApiError(405, "METHOD_NOT_ALLOWED", "/oembed supports GET only.");
        return await handleOembed(incoming, headers);
      }

      const mapped = mapConvenienceRoute(route, incoming);
      const apiPath = mapped ? mapped.path : mapGenericApiPath(route);
      if (!apiPath) throw new ApiError(404, "NOT_FOUND", "Unknown route. Visit / for API usage or /openapi.json for the official OpenAPI spec.");
      if (mapped?.getOnly && request.method !== "GET") throw new ApiError(405, "METHOD_NOT_ALLOWED", `${route} supports GET only.`);

      // A public client ID is not a client secret. It is sent as a query parameter for the
      // client-ID-only compatibility mode. If an OAuth access token is supplied by the caller,
      // use that instead so user-authorized endpoints can be accessed without storing user tokens.
      const clientOAuth = readOAuthHeader(request.headers.get("Authorization"));
      const target = buildApiUrl(apiPath, incoming, mapped, env.SOUNDCLOUD_CLIENT_ID, Boolean(clientOAuth));
      const cacheable = isCacheableRequest(request, route, clientOAuth, env);
      const cache = caches.default;
      const cacheKey = new Request(makeCacheKey(incoming, origin), { method: "GET" });

      if (cacheable) {
        const hit = await cache.match(cacheKey);
        if (hit) return copyWithHeaders(hit, headers, { "X-SC-Cache": "HIT" });
      }

      const upstreamHeaders = new Headers({
        Accept: request.headers.get("Accept") || "application/json; charset=utf-8, */*;q=0.8",
      });
      if (clientOAuth) upstreamHeaders.set("Authorization", clientOAuth);
      if (request.headers.has("Content-Type")) upstreamHeaders.set("Content-Type", request.headers.get("Content-Type"));
      if (request.headers.has("Range")) upstreamHeaders.set("Range", request.headers.get("Range"));
      if (request.headers.has("If-None-Match")) upstreamHeaders.set("If-None-Match", request.headers.get("If-None-Match"));

      const init = { method: request.method, headers: upstreamHeaders, redirect: "manual" };
      if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
      const upstream = await fetch(target, init);

      // The official /resolve endpoint may respond with a Location header. Follow only a
      // redirect that stays on SoundCloud's documented API host so callers get resource JSON.
      if (mapped?.resolve && upstream.status >= 300 && upstream.status < 400) {
        const location = upstream.headers.get("Location");
        if (location) {
          const redirectUrl = new URL(location, target);
          if (redirectUrl.origin === API_BASE) {
            if (!clientOAuth) redirectUrl.searchParams.set("client_id", env.SOUNDCLOUD_CLIENT_ID);
            const redirected = await fetch(redirectUrl, {
              headers: clientOAuth ? { Authorization: clientOAuth, Accept: "application/json; charset=utf-8" } : { Accept: "application/json; charset=utf-8" },
              redirect: "manual",
            });
            return await formatUpstreamResponse(redirected, headers, cacheable, cache, cacheKey, route, env);
          }
          return redirectResponse(upstream.status, location, headers);
        }
      }

      return await formatUpstreamResponse(upstream, headers, cacheable, cache, cacheKey, route, env);
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 502;
      const code = error instanceof ApiError ? error.code : "WORKER_ERROR";
      const message = error instanceof ApiError ? error.message : "The request could not be completed.";
      const details = error instanceof ApiError && error.details ? error.details : undefined;
      return errorResponse(status, code, message, headers, details);
    }
  },
};

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function apiInfo(clientIdConfigured) {
  return {
    name: "SoundCloud Worker API",
    version: VERSION,
    client_id_configured: clientIdConfigured,
    auth: {
      default: "Client-ID-only compatibility mode: appends client_id to the official REST API query string.",
      optional: "Supply Authorization: OAuth <access_token> for endpoints that require a user-authorized session.",
      note: "The current official guide documents OAuth access tokens for REST requests. Client-ID-only query authentication is compatibility behavior and may be rejected by some current API endpoints.",
    },
    allOfficialRestEndpoints: "GET/POST/PUT/PATCH/DELETE /api/<official-api-path>",
    convenienceEndpoints: {
      search: "/search?q=<query>&type=tracks|users|playlists&limit=20",
      track: "/track?id=<id-or-urn>",
      user: "/user?id=<id-or-urn>",
      playlist: "/playlist?id=<id-or-urn>",
      userTracks: "/user/tracks?id=<id-or-urn>",
      userPlaylists: "/user/playlists?id=<id-or-urn>",
      playlistTracks: "/playlist/tracks?id=<id-or-urn>",
      relatedTracks: "/related?id=<track-id-or-urn>",
      relatedArtists: "/related/artists?id=<user-id-or-urn>",
      streams: "/stream?id=<track-id-or-urn>",
      resolve: "/resolve?url=<soundcloud-url>",
      oembed: "/oembed?url=<soundcloud-url>&format=json|xml",
      pagination: "/next?url=<encoded-next_href>",
      spec: "/openapi.json",
    },
    officialDocs: "https://developers.soundcloud.com/docs",
    officialExplorer: "https://developers.soundcloud.com/docs/api/explorer/",
  };
}

function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || "*").split(",").map(value => value.trim()).filter(Boolean);
  const allowOrigin = allowed.includes("*") ? "*" : (allowed.includes(origin) ? origin : "null");
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, Range, If-None-Match",
    "Access-Control-Expose-Headers": "Location, Content-Length, Content-Range, ETag, X-SC-Cache",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff",
  };
}

function isOembedRoute(route) { return route === "/oembed"; }
function readOAuthHeader(value) {
  if (!value || !/^OAuth\s+\S+/i.test(value)) return null;
  return value.trim();
}

function mapGenericApiPath(route) {
  if (route === "/api") return "/";
  if (route.startsWith("/api/")) {
    const path = route.slice(4);
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.split("/").some(segment => segment === "." || segment === "..")) {
      throw new ApiError(400, "INVALID_API_PATH", "Invalid API path.");
    }
    return path;
  }
  return null;
}

function mapConvenienceRoute(route, incoming) {
  const p = incoming.searchParams;
  const getId = () => safeResourceId(required(p.get("id"), "id"));
  if (route === "/search") {
    const q = required(p.get("q"), "q");
    const type = (p.get("type") || "tracks").toLowerCase();
    const resources = { tracks: "/tracks", users: "/users", playlists: "/playlists" };
    if (!resources[type]) throw new ApiError(400, "INVALID_TYPE", "type must be tracks, users, or playlists.");
    const params = new URLSearchParams(incoming.searchParams);
    params.delete("type");
    params.set("q", q);
    params.set("linked_partitioning", params.get("linked_partitioning") || "true");
    params.set("limit", String(parseLimit(params.get("limit"), 20, 200)));
    return { path: resources[type] + "?" + params.toString(), getOnly: true };
  }
  if (route === "/track") return { path: `/tracks/${encodeURIComponent(getId())}`, getOnly: true };
  if (route === "/user") return { path: `/users/${encodeURIComponent(getId())}`, getOnly: true };
  if (route === "/playlist") return { path: `/playlists/${encodeURIComponent(getId())}` + queryStringExcept(p, ["id"]), getOnly: true };
  if (route === "/user/tracks") return { path: `/users/${encodeURIComponent(getId())}/tracks` + collectionQuery(p), getOnly: true };
  if (route === "/user/playlists") return { path: `/users/${encodeURIComponent(getId())}/playlists` + collectionQuery(p), getOnly: true };
  if (route === "/playlist/tracks") return { path: `/playlists/${encodeURIComponent(getId())}/tracks` + collectionQuery(p), getOnly: true };
  if (route === "/related") return { path: `/tracks/${encodeURIComponent(getId())}/related` + collectionQuery(p), getOnly: true };
  if (route === "/related/artists") return { path: `/users/${encodeURIComponent(getId())}/related` + collectionQuery(p), getOnly: true };
  if (route === "/stream") return { path: `/tracks/${encodeURIComponent(getId())}/streams`, getOnly: true };
  if (route === "/next") {
    const nextHref = validateNextHref(required(p.get("url"), "url"));
    return { path: nextHref, getOnly: true };
  }
  if (route === "/resolve") {
    const targetUrl = validateSoundCloudUrl(required(p.get("url"), "url"));
    const params = new URLSearchParams({ url: targetUrl });
    for (const key of ["format", "limit", "linked_partitioning"]) if (p.has(key)) params.set(key, p.get(key));
    return { path: `/resolve?${params.toString()}`, getOnly: true, resolve: true };
  }
  return null;
}

function buildApiUrl(pathWithQuery, incoming, mapped, clientId, hasOAuth) {
  const [path, queryString = ""] = pathWithQuery.split(/\?(.*)/s, 2);
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) throw new ApiError(400, "INVALID_API_PATH", "Invalid API path.");
  const target = new URL(API_BASE + path);
  const params = new URLSearchParams(queryString);
  if (!queryString) {
    for (const [key, value] of incoming.searchParams) {
      if (!mapped) {
        params.append(key, value);
      } else if (key !== "id" && key !== "type" && key !== "q") {
        params.append(key, value);
      }
    }
  }
  if (!hasOAuth && clientId) params.set("client_id", clientId);
  else params.delete("client_id");
  target.search = params.toString();
  return target;
}

function collectionQuery(params) {
  const copy = new URLSearchParams();
  const limit = parseLimit(params.get("limit"), 20, 200);
  copy.set("limit", String(limit));
  copy.set("linked_partitioning", params.get("linked_partitioning") || "true");
  for (const key of ["offset", "cursor", "access", "show_tracks", "sort"]) if (params.has(key)) copy.set(key, params.get(key));
  return "?" + copy.toString();
}
function queryStringExcept(params, excluded) {
  const copy = new URLSearchParams();
  for (const [key, value] of params) if (!excluded.includes(key)) copy.append(key, value);
  return copy.size ? "?" + copy.toString() : "";
}
function safeResourceId(value) {
  if (value.length > 512 || /[\r\n\0]/.test(value) || value === "." || value === "..") {
    throw new ApiError(400, "INVALID_ID", "Invalid resource identifier.");
  }
  return value;
}
function required(value, name) {
  if (value == null || !String(value).trim()) throw new ApiError(400, "MISSING_PARAMETER", `Missing required parameter: ${name}.`);
  return String(value).trim();
}
function parseLimit(value, fallback, max) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new ApiError(400, "INVALID_LIMIT", `limit must be a positive integer up to ${max}.`);
  return Math.min(n, max);
}
function validateNextHref(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new ApiError(400, "INVALID_PAGE_URL", "url must be a valid next_href URL returned by SoundCloud."); }
  if (parsed.protocol !== "https:" || parsed.origin !== API_BASE || parsed.username || parsed.password) {
    throw new ApiError(400, "INVALID_PAGE_URL", "Pagination URL must point to https://api.soundcloud.com.");
  }
  return parsed.pathname + parsed.search;
}
function validateSoundCloudUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new ApiError(400, "INVALID_URL", "url must be a valid SoundCloud URL."); }
  const host = parsed.hostname.toLowerCase();
  const validHost = host === "soundcloud.com" || host === "www.soundcloud.com" || host === "m.soundcloud.com" || host === "on.soundcloud.com";
  if (parsed.protocol !== "https:" || !validHost) throw new ApiError(400, "INVALID_URL", "Only HTTPS SoundCloud URLs are accepted.");
  return parsed.toString();
}

async function handleOembed(incoming, headers) {
  const targetUrl = validateSoundCloudUrl(required(incoming.searchParams.get("url"), "url"));
  const embedUrl = new URL(OEMBED_BASE);
  embedUrl.searchParams.set("url", targetUrl);
  const format = incoming.searchParams.get("format") === "xml" ? "xml" : "json";
  embedUrl.searchParams.set("format", format);
  if (incoming.searchParams.has("maxwidth")) embedUrl.searchParams.set("maxwidth", String(clamp(incoming.searchParams.get("maxwidth"), 100, 1200, 600)));
  if (incoming.searchParams.has("maxheight")) embedUrl.searchParams.set("maxheight", String(clamp(incoming.searchParams.get("maxheight"), 100, 2000, 400)));
  const response = await fetch(embedUrl, { headers: { Accept: format === "xml" ? "application/xml, text/xml" : "application/json" } });
  const body = await response.text();
  if (!response.ok) return errorResponse(response.status, "OEMBED_ERROR", safeUpstreamMessage(body) || "SoundCloud oEmbed request failed.", headers, { upstream_status: response.status });
  if (format === "xml") return new Response(body, { status: response.status, headers: { ...headers, "Content-Type": "application/xml; charset=utf-8", "Cache-Control": `public, max-age=${cacheTtl({ CACHE_TTL_SECONDS: "300" })}` } });
  try {
    const parsed = JSON.parse(body);
    return json({ data: normalize(parsed) }, response.status, { ...headers, "Cache-Control": "public, max-age=300" });
  } catch {
    throw new ApiError(502, "INVALID_OEMBED_RESPONSE", "SoundCloud returned invalid oEmbed JSON.");
  }
}

async function formatUpstreamResponse(response, headers, cacheable, cache, cacheKey, route, env) {
  const responseHeaders = new Headers(headers);
  for (const name of ["Location", "ETag", "Last-Modified", "Content-Range", "Accept-Ranges"]) {
    const value = response.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  const contentType = response.headers.get("Content-Type") || "";
  const cacheHint = response.headers.get("Cache-Control");
  responseHeaders.set("X-SC-Cache", "MISS");

  if (response.status === 204 || response.status === 304) return new Response(null, { status: response.status, headers: responseHeaders });
  if (response.status >= 300 && response.status < 400) {
    return new Response(null, { status: response.status, headers: responseHeaders });
  }

  if (contentType.toLowerCase().includes("json")) {
    const text = await response.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch {
      return json({ error: { code: "INVALID_UPSTREAM_JSON", message: "SoundCloud returned invalid JSON." } }, 502, responseHeaders);
    }

    if (!response.ok) {
      const message = safeUpstreamMessage(text) || statusMessage(response.status);
      const payload = {
        error: {
          code: mapStatusCode(response.status),
          message,
          upstream_status: response.status,
          details: normalize(parsed),
        },
      };
      if (response.status === 401 || response.status === 403) {
        payload.error.authentication_hint = "This request used client_id query authentication unless Authorization: OAuth <access_token> was supplied. The current official SoundCloud REST guide requires OAuth access tokens; some endpoints may reject client-ID-only requests.";
      }
      return json(payload, response.status, responseHeaders);
    }

    const output = json({ data: normalize(parsed) }, response.status, responseHeaders);
    if (cacheable && response.status === 200 && isSafeCacheHeader(cacheHint)) {
      const upstreamTtl = cacheTtlFromHeader(cacheHint, cacheTtl(env));
      const ttl = Math.min(cacheTtl(env), upstreamTtl);
      if (ttl > 0) {
        const stored = new Response(output.clone().body, { status: 200, headers: output.headers });
        stored.headers.set("Cache-Control", `public, max-age=${ttl}`);
        await cache.put(cacheKey, stored).catch(() => {});
      }
    }
    return output;
  }

  // Leave binary/audio, redirects and non-JSON API responses intact.
  const passHeaders = new Headers(responseHeaders);
  if (contentType) passHeaders.set("Content-Type", contentType);
  const upstreamCache = response.headers.get("Cache-Control");
  if (upstreamCache) passHeaders.set("Cache-Control", upstreamCache);
  return new Response(response.body, { status: response.status, headers: passHeaders });
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value;

  const result = {};
  for (const [key, item] of Object.entries(value)) result[key] = normalize(item);

  const kind = String(value.kind || value.type || "").toLowerCase();
  const urn = String(value.urn || "");
  const isTrack = kind === "track" || urn.startsWith("soundcloud:tracks:") || ("duration" in value && ("streamable" in value || "playback_count" in value));
  const isUser = kind === "user" || urn.startsWith("soundcloud:users:") || ("username" in value && ("followers_count" in value || "track_count" in value));
  const isPlaylist = kind === "playlist" || kind === "system-playlist" || urn.startsWith("soundcloud:playlists:") || ("tracks" in value && ("track_count" in value || "is_album" in value));

  if (isTrack) {
    result.type = "track";
    if (result.urn == null && value.id != null) result.urn = `soundcloud:tracks:${value.id}`;
    if (result.duration_ms == null && value.duration != null) result.duration_ms = value.duration;
    if (result.artwork_url == null) result.artwork_url = value.artwork_url || value.user?.avatar_url || null;
    if (result.likes_count == null) result.likes_count = value.likes_count ?? value.favoritings_count ?? null;
    if (result.permalink_url == null) result.permalink_url = value.permalink_url || null;
  } else if (isUser) {
    result.type = "user";
    if (result.urn == null && value.id != null) result.urn = `soundcloud:users:${value.id}`;
    if (result.permalink_url == null) result.permalink_url = value.permalink_url || null;
    if (result.artwork_url == null) result.artwork_url = value.avatar_url || null;
  } else if (isPlaylist) {
    result.type = kind === "system-playlist" ? "system_playlist" : "playlist";
    if (result.urn == null && value.id != null && result.type === "playlist") result.urn = `soundcloud:playlists:${value.id}`;
    if (result.track_count == null) result.track_count = value.track_count ?? value.tracks?.length ?? null;
    if (result.artwork_url == null) result.artwork_url = value.artwork_url || null;
  }

  if (Array.isArray(value.collection)) result.collection = value.collection.map(normalize);
  if (Array.isArray(value.tracks)) result.tracks = value.tracks.map(normalize);
  return result;
}

function isCacheableRequest(request, route, oauth, env) {
  if (request.method !== "GET" || oauth) return false;
  if (route === "/stream" || route.includes("/streams") || route.includes("/preview") || route === "/resolve" || route.startsWith("/api/resolve") || route.startsWith("/api/me")) return false;
  return cacheTtl(env) > 0;
}
function makeCacheKey(incoming, origin) {
  const key = new URL(incoming.toString());
  key.searchParams.set("__sc_cache_origin", origin || "*");
  return key.toString();
}
function cacheTtl(env) {
  const parsed = Number(env.CACHE_TTL_SECONDS ?? 60);
  if (!Number.isFinite(parsed)) return 60;
  return Math.max(0, Math.min(3600, Math.floor(parsed)));
}
function isSafeCacheHeader(value) {
  if (!value) return true;
  const lower = value.toLowerCase();
  return !lower.includes("private") && !lower.includes("no-store") && !lower.includes("no-cache");
}
function cacheTtlFromHeader(header, fallback) {
  if (!header) return fallback || 60;
  const match = header.match(/max-age=(\d+)/i);
  return match ? Math.max(0, Math.min(3600, Number(match[1]))) : (fallback || 60);
}
function copyWithHeaders(response, headers, additions = {}) {
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(headers)) newHeaders.set(key, value);
  for (const [key, value] of Object.entries(additions)) newHeaders.set(key, value);
  return new Response(response.body, { status: response.status, headers: newHeaders });
}
function redirectResponse(status, location, headers) {
  return new Response(null, { status, headers: { ...headers, Location: location, "Cache-Control": "no-store" } });
}
function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
  });
}
function errorResponse(status, code, message, headers = {}, details) {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  return json({ error }, status, { ...headers, "Cache-Control": "no-store" });
}
function statusMessage(status) {
  return ({ 400: "Bad request to SoundCloud.", 401: "SoundCloud authentication failed.", 403: "SoundCloud denied access to this resource.", 404: "SoundCloud resource was not found.", 429: "SoundCloud rate limit reached.", 500: "SoundCloud server error.", 502: "SoundCloud upstream error." })[status] || `SoundCloud API returned HTTP ${status}.`;
}
function mapStatusCode(status) {
  if (status === 401) return "SOUNDCLOUD_UNAUTHORIZED";
  if (status === 403) return "SOUNDCLOUD_FORBIDDEN";
  if (status === 404) return "SOUNDCLOUD_NOT_FOUND";
  if (status === 429) return "SOUNDCLOUD_RATE_LIMITED";
  return `SOUNDCLOUD_HTTP_${status}`;
}
function safeUpstreamMessage(text) {
  try {
    const data = JSON.parse(text);
    for (const key of ["message", "error_description", "error", "status"]) {
      if (typeof data?.[key] === "string" && data[key].length) return data[key].slice(0, 500);
    }
    if (Array.isArray(data?.errors) && data.errors[0]?.error_message) return String(data.errors[0].error_message).slice(0, 500);
  } catch {}
  return "";
}
function clamp(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
