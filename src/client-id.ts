/**
 * SoundCloud client_id resolution.
 *
 * 1. CLIENT_ID env var (the only env var, optional) — used verbatim when set.
 * 2. Otherwise a client_id is scraped from the SoundCloud web client:
 *    fetch soundcloud.com → collect a-v2.sndcdn.com JS bundle URLs →
 *    grep client_id:"…" → validate against api-v2 → cache per-isolate.
 * 3. If api-v2 starts answering 401/403, the current id is dropped and a
 *    fresh one is scraped (see reportAuthFailure) so the proxy can retry.
 */

const HOMEPAGE = "https://soundcloud.com/";
const ASSET_ORIGIN = "https://a-v2.sndcdn.com";
const VALIDATE_URL = "https://api-v2.soundcloud.com/search?q=a&limit=1";
const SCRAPE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const MAX_BUNDLES = 15;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export interface ClientIdEnv {
  CLIENT_ID?: string;
}

let scrapedId: string | null = null;
let scrapedAt = 0;
let envIdBroken = false;
let scrapeInFlight: Promise<string> | null = null;

export async function getClientId(env: ClientIdEnv): Promise<string> {
  const envId = env.CLIENT_ID?.trim() ?? "";
  if (envId && !envIdBroken) return envId;
  return cachedScrapedId();
}

/**
 * Called when api-v2 answered 401/403 for a request using `usedId`.
 * Marks the env-provided id as broken (falls back to scraping), or drops
 * the cached scraped id so the next getClientId() scrapes a fresh one.
 */
export function reportAuthFailure(env: ClientIdEnv, usedId: string): void {
  const envId = env.CLIENT_ID?.trim() ?? "";
  if (envId && usedId === envId) {
    envIdBroken = true;
  } else {
    scrapedId = null;
    scrapedAt = 0;
  }
}

function cachedScrapedId(): Promise<string> {
  if (scrapedId && Date.now() - scrapedAt < CACHE_TTL_MS) {
    return Promise.resolve(scrapedId);
  }
  if (!scrapeInFlight) {
    scrapeInFlight = scrapeClientId()
      .then((id) => {
        scrapedId = id;
        scrapedAt = Date.now();
        return id;
      })
      .finally(() => {
        scrapeInFlight = null;
      });
  }
  return scrapeInFlight;
}

async function scrapeClientId(): Promise<string> {
  const home = await fetch(HOMEPAGE, { headers: { "user-agent": SCRAPE_UA, accept: "text/html" } });
  if (!home.ok) throw new Error(`soundcloud.com returned ${home.status}`);
  const html = await home.text();

  const bundles = new Set<string>();
  for (const match of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
    const src = match[1];
    if (!/\/assets\//.test(src)) continue;
    bundles.add(absolutize(src));
  }
  // Asset URLs also appear outside <script> tags (preload hints, inline JSON).
  for (const match of html.matchAll(/(?:https?:)?\/\/a-v2\.sndcdn\.com\/assets\/[A-Za-z0-9._-]+\.js/g)) {
    bundles.add(absolutize(match[0]));
  }
  if (bundles.size === 0) throw new Error("no JS bundles found on the soundcloud.com homepage");

  const scripts = await Promise.all(
    [...bundles].slice(0, MAX_BUNDLES).map(async (url) => {
      try {
        const res = await fetch(url, { headers: { "user-agent": SCRAPE_UA } });
        return res.ok ? await res.text() : "";
      } catch {
        return "";
      }
    }),
  );

  const candidates: string[] = [];
  for (const js of scripts) {
    for (const match of js.matchAll(/client_id\s*[:=]\s*["']([A-Za-z0-9]{16,48})["']/g)) {
      if (!candidates.includes(match[1])) candidates.push(match[1]);
    }
  }
  if (candidates.length === 0) throw new Error("no client_id found in SoundCloud web client bundles");

  for (const candidate of candidates) {
    if (await isValidClientId(candidate)) return candidate;
  }
  throw new Error("no scraped client_id validated against api-v2");
}

function absolutize(src: string): string {
  if (src.startsWith("http://") || src.startsWith("https://")) return src;
  if (src.startsWith("//")) return "https:" + src;
  return ASSET_ORIGIN + src;
}

async function isValidClientId(id: string): Promise<boolean> {
  try {
    const res = await fetch(`${VALIDATE_URL}&client_id=${encodeURIComponent(id)}`, {
      headers: { "user-agent": SCRAPE_UA },
    });
    return res.ok;
  } catch {
    return false;
  }
}
