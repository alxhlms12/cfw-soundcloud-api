# SoundCloud Worker API

A small Cloudflare Worker wrapper that proxies the documented SoundCloud Public API. It supports the full REST path/method surface without maintaining a hand-written route for every operation, and normalizes common resources while preserving source fields.

## Project

```text
soundcloud-worker-api/
├── src/
│   └── index.js
├── wrangler.toml
└── README.md
```

No framework and no build step are required.

## Authentication model

This project deliberately does **not** require or store a SoundCloud client secret. It sends your `SOUNDCLOUD_CLIENT_ID` as a `client_id` query parameter for public API requests. You may also pass an access token you obtained separately as `Authorization: OAuth ACCESS_TOKEN`; the Worker forwards that header for requests that require user-authorized access.

**Compatibility note:** SoundCloud's current official API guide says REST requests use `Authorization: OAuth ACCESS_TOKEN`, and its documented Client Credentials token exchange uses both a client ID and a client secret. Client-ID-only query authentication is compatibility behavior and is not guaranteed to work on every endpoint of the current `api.soundcloud.com` REST API. The Worker returns upstream status/errors (including a specific authentication hint for HTTP 401/403) rather than pretending a request succeeded. A client ID alone cannot grant access to private resources or account actions that require user consent.

## Install and deploy

```bash
npm install -D wrangler
npx wrangler login
npx wrangler secret put SOUNDCLOUD_CLIENT_ID
npx wrangler deploy
```

Although a client ID is not a client secret, storing it through `wrangler secret put` keeps it out of the source file and makes setup simple. Alternatively, define `SOUNDCLOUD_CLIENT_ID` in Worker settings as a non-sensitive variable.

### Optional configuration

`wrangler.toml` has these variables:

- `ALLOWED_ORIGINS`: comma-separated browser origins or `*` (default `*`). CORS is not access control.
- `CACHE_TTL_SECONDS`: public JSON GET response cache lifetime, from 0 to 3600 seconds (default 60).

To restrict direct access to your deployed Worker, add a Worker secret named `WORKER_API_KEY`. When present, requests must also include `X-API-Key: your-value`. Do not expose that key in a publicly distributed frontend; use your own backend if clients need a private API key.

## Endpoints

### Quick aliases

- `GET /` — endpoint index
- `GET /health` — configuration and health check
- `GET /openapi.json` — current official OpenAPI specification from SoundCloud
- `GET /search?q=QUERY&type=tracks|users|playlists&limit=20`
- `GET /track?id=ID_OR_URN`
- `GET /user?id=ID_OR_URN`
- `GET /user/tracks?id=ID_OR_URN&limit=20`
- `GET /user/playlists?id=ID_OR_URN&limit=20`
- `GET /playlist?id=ID_OR_URN`
- `GET /playlist/tracks?id=ID_OR_URN&limit=20`
- `GET /related?id=TRACK_ID_OR_URN&limit=10`
- `GET /related/artists?id=USER_ID_OR_URN&limit=10`
- `GET /stream?id=TRACK_ID_OR_URN` — official stream/transcoding response, not a restriction bypass
- `GET /resolve?url=https%3A%2F%2Fsoundcloud.com%2Fartist%2Ftrack`
- `GET /next?url=<URL-encoded-next_href>` — safely follows SoundCloud's `next_href` pagination URL
- `GET /oembed?url=https%3A%2F%2Fsoundcloud.com%2Fartist%2Ftrack&format=json|xml`

### Full official REST API

Use `/api/` followed by any documented SoundCloud API path. The Worker forwards supported HTTP methods (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`), query parameters, request bodies, and content types to the fixed official API origin `https://api.soundcloud.com`.

Examples:

```text
GET    /api/tracks?q=Frank%20Ocean&limit=10&linked_partitioning=true
GET    /api/tracks/soundcloud%3Atracks%3A123/streams
GET    /api/tracks/123/comments?limit=25&linked_partitioning=true
POST   /api/tracks/123/comments
GET    /api/users/123/followers?limit=50
GET    /api/me/likes/tracks?limit=25
PUT    /api/me/followings/123
POST   /api/likes/tracks/123
DELETE /api/likes/tracks/123
POST   /api/playlists
PUT    /api/playlists/123
DELETE /api/playlists/123
POST   /api/tracks
PUT    /api/tracks/123
DELETE /api/tracks/123
GET    /api/system-playlists/123
GET    /api/resolve?url=https%3A%2F%2Fsoundcloud.com%2Fartist%2Ftrack
```

The above are examples, not an allowlist. Because `/api/*` proxies the published API path and methods generically, additional operations in the official OpenAPI spec do not require Worker code changes. Body fields and parameters are passed to SoundCloud; the Worker does not synthesize write operations or bypass API permission checks.

### API coverage by category

The current spec includes own-user/feed endpoints (`/me`), searches (`/tracks`, `/users`, `/playlists`), track uploads/metadata/streams/previews/comments/favoriters/reposters/related tracks, user profiles/followers/followings/likes/reposts/playlists/tracks/web profiles/related artists, playlists and their tracks/reposters, system playlists, likes, reposts, resolve, and OAuth-related endpoints documented by SoundCloud. `/openapi.json` exposes the latest official operation list and schemas.

## Normalized responses

JSON API responses are wrapped in `{ "data": ... }`. Track/user/playlist objects preserve their returned fields and gain common stable aliases such as `type`, `urn`, `duration_ms`, `artwork_url`, `likes_count`, and `track_count` where applicable. Collections retain the API's `collection`, `next_href`, `total_results`, and other fields, with each contained resource normalized. Errors use `{ "error": { "code", "message", "upstream_status", "details" } }` when SoundCloud returns JSON errors. Binary/audio responses and redirects are passed through.

Pagination follows SoundCloud's own fields. To continue a collection, URL-encode the returned `next_href` and call `/next?url=...`, or use the documented `limit`, `offset`, `cursor`, and `linked_partitioning` parameters with `/api/*`. `/next` only accepts HTTPS URLs on `api.soundcloud.com`.

## Playback and limits

- `/stream` returns the documented streams/transcodings JSON response. A track may be playable, preview-only, blocked, private, geo-restricted, or otherwise unavailable for off-platform playback.
- `/oembed` uses SoundCloud's public oEmbed service, separate from the REST API.
- SoundCloud controls rate limits, resource permissions, uploads, and whether an endpoint supports a given auth mode. This Worker forwards the response and status; it does not bypass them.
- Public GET JSON responses may be cached in Cloudflare's data-center cache. Responses involving `/me`, stream URLs, previews, and resolve are not cached by the Worker's response cache. Cache can be disabled by setting `CACHE_TTL_SECONDS` to `0`.

## Official references

- API Guide: https://developers.soundcloud.com/docs
- OpenAPI Explorer: https://developers.soundcloud.com/docs/api/explorer/
- App credentials: https://developers.soundcloud.com/docs/api/register-app
- Rate limits: https://developers.soundcloud.com/docs/api/rate-limits.html
