# SoundCloud Internal v2 API Worker

A Cloudflare Worker wrapper built around SoundCloud's **undocumented internal v2 API** at `https://api-v2.soundcloud.com`. It intentionally does **not** use `api.soundcloud.com`, the official OAuth client-credentials flow, or a SoundCloud client secret.

The v2 API is an internal web-client interface, not a supported public developer API. Routes, response fields, client IDs, playback rules, and access may change or stop working at any time. This project is read-only and designed for search, metadata, pagination, and playback URL resolution.

## Configure and deploy

```sh
npm install -D wrangler
npx wrangler login
npx wrangler secret put SOUNDCLOUD_CLIENT_ID
npx wrangler deploy
```

Paste a client ID when prompted. The Worker reads it from the `SOUNDCLOUD_CLIENT_ID` secret and adds it to upstream requests. **Do not commit a real client ID to source control.** A client ID used by SoundCloud's web app is not equivalent to a confidential OAuth client secret; it may be visible in web-client assets and network requests. Keeping it in a Worker secret avoids hardcoding it in this repository, but does not make a public-facing Worker private.

For local development, create `.dev.vars` (do not commit it):

```dotenv
SOUNDCLOUD_CLIENT_ID="your-client-id"
ALLOWED_ORIGINS="*"
CACHE_TTL_SECONDS="60"
```

Then run `npx wrangler dev`.

## Endpoints

All convenience endpoints are `GET`. IDs can be numeric IDs or SoundCloud URNs where the upstream route accepts them.

| Endpoint | Purpose |
|---|---|
| `/` | Endpoint discovery and configuration status |
| `/health` | Health/configuration status |
| `/search?q=...&type=tracks&limit=20` | Search tracks, users, or playlists (`type=tracks\|users\|playlists`) |
| `/search/tracks?q=...&limit=20` | Track search |
| `/search/users?q=...&limit=20` | User search |
| `/search/playlists?q=...&limit=20` | Playlist search |
| `/track?id=...` | Track metadata, including the upstream media/transcoding fields |
| `/tracks?ids=id1,id2` | Batch track metadata; maximum 50 IDs per request |
| `/user?id=...` | User metadata |
| `/user/tracks?id=...&limit=20` | User uploads |
| `/user/playlists?id=...&limit=20` | User playlists |
| `/user/likes?id=...&limit=20` | User liked tracks |
| `/user/followers?id=...&limit=20` | Followers |
| `/user/followings?id=...&limit=20` | Followings |
| `/playlist?id=...` | Playlist metadata and embedded tracks when upstream supplies them |
| `/playlist/tracks?id=...&limit=20` | Playlist tracks |
| `/related?id=...&limit=10` | Related tracks |
| `/related/artists?id=...&limit=10` | Related artists |
| `/stream?id=...` | Track metadata and resolved media transcoding URLs where available |
| `/resolve?url=https%3A%2F%2Fsoundcloud.com%2F...` | Resolve a SoundCloud permalink |
| `/next?url=%2Fsearch%2Ftracks%3F...&type=tracks` | Fetch the `next` path returned by a collection |
| `/v2/<path>?<params>` | Read-only passthrough to an internal v2 path |

### Raw v2 passthrough

`/v2/<path>` forwards a GET request to the matching path on `api-v2.soundcloud.com`. Example:

```text
/v2/search/tracks?q=ambient&limit=10
/v2/tracks/123456789
/v2/playlists/123456789
```

Only the fixed `api-v2.soundcloud.com` upstream host is permitted. The Worker strips any caller-supplied `client_id` and inserts the configured value. The passthrough is GET-only; it does not expose arbitrary hosts or forward request bodies.

## Pagination

Collection responses return normalized `data.items`, `data.next`, and `data.total_results`. `data.next` is a relative internal API path with any `client_id` removed. URL-encode it when calling `/next`:

```text
/next?url=%2Fsearch%2Ftracks%3Fq%3Dambient%26offset%3D10&type=tracks
```

The `/next` route also accepts an absolute `next_href` as long as its host is exactly `api-v2.soundcloud.com`. It rejects external hosts.

## Playback notes

`/stream` attempts to resolve the track's media transcodings. When SoundCloud provides HLS AAC variants, the response reports their upstream preset, protocol, MIME type, and resolved playback URL. Playback URLs can be short-lived, track-specific, region-limited, or unavailable. The Worker does not bypass private-track permissions, subscription restrictions, geoblocking, or SoundCloud playback checks. Prefer the AAC HLS transcoding supplied by the upstream when available; SoundCloud's public API streaming guidance also describes AAC HLS as the modern stream format: https://developers.soundcloud.com/blog/api-streaming-urls/.

## Configuration

- `SOUNDCLOUD_CLIENT_ID` — required Worker secret.
- `ALLOWED_ORIGINS` — comma-separated allowed browser origins; defaults to `*` in the provided config. Restrict this for deployments used by a known frontend. CORS is not authentication.
- `CACHE_TTL_SECONDS` — public response cache lifetime, clamped to 0–600 seconds; set to `0` to disable response caching.

This wrapper has no built-in API-key authentication or rate limiter. Do not treat it as private just because the SoundCloud client ID is stored as a Worker secret. If deploying publicly, use Cloudflare controls appropriate to your deployment and avoid forwarding sensitive or personal user data.

## Known limitations

- The internal API is undocumented and unsupported for third-party use; there is no guarantee of stability or continued access.
- Search and catalog behavior may vary by client ID, region, cookies, account state, and SoundCloud-side policy.
- Not every track exposes every metadata field or playback transcoding.
- Some internal endpoints may require cookies, authorization, or parameters not represented by these convenience routes.
- `GET` passthrough does not implement write operations such as uploading, editing, liking, following, or commenting.
- The code can be syntax-checked locally, but successful live responses depend on SoundCloud accepting the configured client ID at deployment time.

## References used for reverse-engineering

These are unofficial implementation references, not SoundCloud's specification:

- https://github.com/cprkrn/crate-toolkit/blob/main/docs/soundcloud.md
- https://gist.github.com/cloud11665/f1f2024d74bc0e609edfad13d7b4d906
- https://github.com/imoonkey/openweb/blob/main/src/sites/soundcloud/DOC.md

SoundCloud's official API documentation describes the separate public API, not this internal v2 interface: https://developers.soundcloud.com/docs.

---

## Internal API and responsibility notice

**This API uses SoundCloud's undocumented internal v2 API. It is not an official SoundCloud product or supported public API. SoundCloud may change, restrict, revoke, or block client IDs and access at any time. You are responsible for the client ID you configure, for securing or replacing credentials under your control, and for ensuring that your use of this software complies with SoundCloud's Terms of Use and all other applicable rules. By using this software, you acknowledge these risks and agree to use it lawfully. This notice does not bind SoundCloud, guarantee that a client ID can be revoked or replaced by you, or determine legal liability.**
