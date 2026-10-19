import { getClientId, reportAuthFailure } from "./client-id";
import type { ClientIdEnv } from "./client-id";
import { matchRoute, routeList } from "./routes";

export interface Env extends ClientIdEnv {}

const UPSTREAM_BASE = "https://api-v2.soundcloud.com/";

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-max-age": "86400",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (err) {
      return jsonError(502, `unexpected proxy error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

async function handle(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonError(405, "method not allowed - read-only API, use GET (or HEAD/OPTIONS)");
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/" && request.method === "GET") return indexJson();

  const route = matchRoute(path);
  if (!route) return jsonError(404, `no such route: GET ${path} - see GET / for the route list`);

  // Forward every caller query param except client_id; the worker appends its own.
  const query = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    if (key.toLowerCase() !== "client_id") query.append(key, value);
  }

  // Route-specific upstream requirements that callers shouldn't have to remember.
  if (route.defaults) {
    for (const [key, value] of Object.entries(route.defaults)) {
      if (!query.has(key)) query.set(key, value);
    }
  }

  let clientId: string;
  try {
    clientId = await getClientId(env);
  } catch (err) {
    return jsonError(
      502,
      `could not resolve a SoundCloud client_id: ${
        err instanceof Error ? err.message : String(err)
      } - set the CLIENT_ID env var to provide one manually`,
    );
  }

  const upstream = await fetchUpstream(route.upstream, query, clientId, request.method);

  if ((upstream.status === 401 || upstream.status === 403) && request.method !== "HEAD") {
    // The client_id was most likely rejected: re-resolve and retry once.
    reportAuthFailure(env, clientId);
    try {
      const freshId = await getClientId(env);
      if (freshId !== clientId) {
        const retry = await fetchUpstream(route.upstream, query, freshId, request.method);
        return passthrough(retry, request.method);
      }
    } catch {
      // fall through to the original 401/403 response
    }
  }
  return passthrough(upstream, request.method);
}

async function fetchUpstream(
  upstreamPath: string,
  query: URLSearchParams,
  clientId: string,
  method: string,
): Promise<Response> {
  query.set("client_id", clientId);
  const url = UPSTREAM_BASE + upstreamPath + "?" + query.toString();
  return fetch(url, {
    method: method === "HEAD" ? "GET" : method,
    headers: { accept: "application/json" },
    redirect: "follow",
  });
}

function passthrough(upstream: Response, method: string): Response {
  const headers = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  const bodyless =
    method === "HEAD" || upstream.status === 204 || upstream.status === 205 || upstream.status === 304;
  return new Response(bodyless ? null : upstream.body, { status: upstream.status, headers });
}

function indexJson(): Response {
  const body = JSON.stringify(
    {
      name: "soundcloud-v2-api",
      upstream: "api-v2.soundcloud.com",
      notes: [
        "Paths and query params mirror api-v2.soundcloud.com 1:1; responses pass through verbatim.",
        "client_id is resolved by the worker (CLIENT_ID env var, or scraped from the SoundCloud web client).",
        "Pagination: pass limit/offset. Secret content: pass secret_token.",
      ],
      routes: routeList(),
    },
    null,
    2,
  );
  return new Response(body + "\n", { status: 200, headers: jsonHeaders() });
}

function corsHeaders(): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  return headers;
}

function jsonHeaders(): Headers {
  const headers = corsHeaders();
  headers.set("content-type", "application/json; charset=utf-8");
  return headers;
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message, status }), { status, headers: jsonHeaders() });
}
