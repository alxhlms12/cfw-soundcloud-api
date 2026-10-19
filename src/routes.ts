/**
 * Route table — worker path <-> api-v2.soundcloud.com path.
 *
 * `{id}` segments match any single path segment and are substituted verbatim.
 * Every other query param (limit, offset, q, url, genre, kind, secret_token, …)
 * is forwarded untouched by the proxy; the worker only manages client_id.
 *
 * This table was verified live against api-v2 (2026-10). Routes v2 has killed
 * (e.g. /users/{id}/reposts, /playlists/{id}/related, /users/{id}/likedtracks,
 * batch /users?ids=, /users/{id}/followings/{id2}) are deliberately absent.
 */

export interface RouteDef {
  /** Worker-facing path pattern, e.g. "/users/{id}/tracks". */
  path: string;
  /** api-v2 path with the same placeholders, e.g. "users/{id}/tracks". */
  upstream: string;
  /** Query params the upstream route requires but callers shouldn't have to know. */
  defaults?: Record<string, string>;
  /** Rewrite a numeric {id} into the urn form api-v2 expects (soundcloud:users:{id}). */
  urnifyId?: boolean;
}

export const ROUTES: RouteDef[] = [
  // Resolve & search
  { path: "/resolve", upstream: "resolve" },
  { path: "/search", upstream: "search" },
  { path: "/search/tracks", upstream: "search/tracks" },
  { path: "/search/users", upstream: "search/users" },
  { path: "/search/playlists", upstream: "search/playlists" },
  { path: "/search/albums", upstream: "search/albums" },

  // Tracks
  { path: "/tracks", upstream: "tracks" }, // batch: ?ids=1,2,3 (v2 answers with an object map)
  { path: "/tracks/{id}", upstream: "tracks/{id}" },
  { path: "/tracks/{id}/albums", upstream: "tracks/{id}/albums" },
  {
    path: "/tracks/{id}/comments",
    upstream: "tracks/{id}/comments",
    // v2 refuses this route without threaded + filter_replies; default them.
    defaults: { threaded: "0", filter_replies: "1" },
  },
  { path: "/tracks/{id}/likers", upstream: "tracks/{id}/likers" },
  { path: "/tracks/{id}/playlists", upstream: "tracks/{id}/playlists" },
  { path: "/tracks/{id}/related", upstream: "tracks/{id}/related" },

  // Playlists (and albums)
  { path: "/playlists/{id}", upstream: "playlists/{id}" },
  { path: "/playlists/{id}/likers", upstream: "playlists/{id}/likers" },

  // Users
  { path: "/users/{id}", upstream: "users/{id}" },
  { path: "/users/{id}/albums", upstream: "users/{id}/albums" },
  { path: "/users/{id}/comments", upstream: "users/{id}/comments" },
  { path: "/users/{id}/followers", upstream: "users/{id}/followers" },
  { path: "/users/{id}/followings", upstream: "users/{id}/followings" },
  { path: "/users/{id}/likes", upstream: "users/{id}/likes" },
  { path: "/users/{id}/playlists", upstream: "users/{id}/playlists" },
  { path: "/users/{id}/spotlight", upstream: "users/{id}/spotlight" },
  { path: "/users/{id}/toptracks", upstream: "users/{id}/toptracks" },
  { path: "/users/{id}/tracks", upstream: "users/{id}/tracks" },
  {
    // Upstream wants a user urn, not a numeric id; the worker converts.
    path: "/users/{id}/web-profiles",
    upstream: "users/{id}/web-profiles",
    urnifyId: true,
  },

  // Comments & charts
  { path: "/comments/{id}", upstream: "comments/{id}" },
  { path: "/charts", upstream: "charts" }, // ?kind=top|trending&genre=soundcloud:genres:<name>
];

export interface MatchedRoute {
  upstream: string;
  defaults?: Record<string, string>;
}

const compiled = ROUTES.map((route) => {
  const names: string[] = [];
  const pattern = new RegExp(
    "^" +
      route.path
        .split("/")
        .map((segment) => {
          const match = /^\{([a-zA-Z0-9_]+)\}$/.exec(segment);
          if (match) {
            names.push(match[1]);
            return "([^/]+)";
          }
          return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        })
        .join("/") +
      "$",
  );
  return { pattern, names, route };
});

export function matchRoute(path: string): MatchedRoute | null {
  for (const { pattern, names, route } of compiled) {
    const match = pattern.exec(path);
    if (!match) continue;
    let upstream = route.upstream;
    names.forEach((name, i) => {
      let value = match[i + 1];
      if (route.urnifyId && name === "id" && /^\d+$/.test(value)) {
        value = encodeURIComponent(`soundcloud:users:${value}`);
      }
      // Function replacer: never interprets $-patterns in the substituted value.
      upstream = upstream.replaceAll(`{${name}}`, () => value);
    });
    return { upstream, defaults: route.defaults };
  }
  return null;
}

/** All worker paths, for the index route. */
export function routeList(): string[] {
  return ROUTES.map((r) => "GET " + r.path);
}
