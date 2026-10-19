# soundcloud-v2-api

A zero-dependency Cloudflare Worker that REST-proxies SoundCloud's undocumented **api-v2** exactly as it is: same paths, same query params, SoundCloud's JSON back verbatim. No invented options, no response rewriting, no OAuth-only endpoints, CORS open (`*`).

Every route below was verified live against `api-v2.soundcloud.com` (October 2026). Routes v2 has killed — `/users/{id}/reposts`, `/playlists/{id}/related`, `/users/{id}/likedtracks`, batch `/users?ids=`, `/users/{id}/followings/{id2}` — are deliberately absent: the table below is the complete, working public surface.

## The only env var: `CLIENT_ID` — and it's optional

- **Set it** → used verbatim, scraping never runs.
- **Don't set it** → the worker scrapes a client id from the SoundCloud web client: fetches `soundcloud.com`, greps its JS bundles for `client_id:"…"`, validates the candidate against api-v2, caches it in-memory for 6 hours.
- SoundCloud invalidates client ids occasionally. On a 401/403 the worker drops the current id, scrapes a fresh one, and retries the request once — invisible to callers.

```bash
npx wrangler secret put CLIENT_ID    # or edit "vars" in wrangler.jsonc
```

## Deploy

```bash
npm install
npm run deploy      # → https://soundcloud-v2-api.<you>.workers.dev
npm run dev         # local dev → http://127.0.0.1:8787
npm run check       # tsc --noEmit
```

## Routes

All query params are forwarded untouched (`q`, `limit`, `offset`, `genre`, `kind`, `secret_token`, …). A `client_id` param from the caller is ignored and replaced by the worker's.

### Resolve & search

| Route | Notes |
|---|---|
| `GET /resolve?url=<soundcloud URL>` | any soundcloud.com URL → user / track / playlist / album object |
| `GET /search?q=<q>` | mixed results |
| `GET /search/tracks?q=<q>` | |
| `GET /search/users?q=<q>` | |
| `GET /search/playlists?q=<q>` | |
| `GET /search/albums?q=<q>` | |

### Tracks

| Route | Notes |
|---|---|
| `GET /tracks?ids=1,2,3` | batch lookup — v2 answers with an object map keyed by index, passed through |
| `GET /tracks/{id}` | supports `?secret_token=` |
| `GET /tracks/{id}/albums` | albums containing the track |
| `GET /tracks/{id}/comments` | `threaded` + `filter_replies` are required by v2 and defaulted by the worker — pass your own to override |
| `GET /tracks/{id}/likers` | |
| `GET /tracks/{id}/playlists` | playlists containing the track |
| `GET /tracks/{id}/related` | |

### Playlists (and albums)

| Route | Notes |
|---|---|
| `GET /playlists/{id}` | supports `?secret_token=` |
| `GET /playlists/{id}/likers` | |

### Users

| Route | Notes |
|---|---|
| `GET /users/{id}` | |
| `GET /users/{id}/albums` | |
| `GET /users/{id}/comments` | comments posted by the user |
| `GET /users/{id}/followers` | |
| `GET /users/{id}/followings` | |
| `GET /users/{id}/likes` | liked tracks + playlists (mixed `like` objects) |
| `GET /users/{id}/playlists` | |
| `GET /users/{id}/spotlight` | spotlight playlists |
| `GET /users/{id}/toptracks` | |
| `GET /users/{id}/tracks` | |
| `GET /users/{id}/web-profiles` | the worker converts a numeric id to the `soundcloud:users:{id}` urn v2 demands |

### Comments & charts

| Route | Notes |
|---|---|
| `GET /comments/{id}` | single comment |
| `GET /charts?kind=trending&genre=soundcloud%3Agenres%3Aall-music` | the only combo v2 still serves — every other kind/genre pair we probed 404s (Top 50 per-genre charts were replaced by editorial playlists); params pass through, v2 decides |

### Pagination

`limit` + `offset` on collection routes, e.g. `GET /tracks/{id}/comments?limit=20&offset=20`. Responses include SoundCloud's own `next_href` (pointing at api-v2 directly); paginate against this worker by re-calling the same route with a bigger `offset`.

### Errors

Upstream status codes and bodies pass through verbatim (`404` unknown id, `429` rate limit, …). Worker-generated errors are JSON: `{"error": "...", "status": 404}`.

## Examples

```bash
API=https://soundcloud-v2-api.<you>.workers.dev

curl "$API/resolve?url=https%3A%2F%2Fsoundcloud.com%2Fforss%2Fflickermood"
curl "$API/search/tracks?q=lofi&limit=10"
curl "$API/tracks/293"
curl "$API/tracks/293/comments"                 # threaded/filter_replies defaulted
curl "$API/tracks?ids=293,1316258221"           # batch (object-map response)
curl "$API/users/183/toptracks"
curl "$API/users/183/web-profiles"              # urn handled for you
curl "$API/charts?kind=trending&genre=soundcloud%3Agenres%3Aall-music"
```
