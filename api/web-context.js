import { requireSession } from './_supabase.js';

// ── Trusted domain boost lists ────────────────────────────────────────────────
const TRUSTED_INDIAN_DOMAINS = [
  'aajtak.in', 'indiatoday.in', 'thehindu.com', 'indianexpress.com',
  'ndtv.com', 'hindustantimes.com', 'timesofindia.indiatimes.com',
  'economictimes.indiatimes.com', 'livemint.com', 'news18.com', 'aninews.in',
  'cricbuzz.com', 'espncricinfo.com', 'scroll.in', 'thewire.in',
];

const TRUSTED_GLOBAL_DOMAINS = [
  'reuters.com', 'apnews.com', 'bbc.com', 'aljazeera.com',
  'theguardian.com', 'nytimes.com', 'wsj.com', 'bloomberg.com',
  'cnn.com', 'npr.org', 'ft.com', 'economist.com', 'techcrunch.com',
  'theverge.com', 'wired.com', 'nature.com', 'sciencedirect.com',
];

// ── Domains Jina struggles with (paywalls / bot blocks) ───────────────────────
// We still USE these URLs (for the title/citation) but fall back to snippet text
const JINA_SKIP_DOMAINS = [
  'wsj.com', 'ft.com', 'economist.com',
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function preview(text, max = 1300) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : s.slice(0, max) + '...';
}

function normalizeUrl(raw) {
  const u = String(raw || '').trim();
  if (!u) return null;
  try {
    const parsed = new URL(u);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (/^(localhost|127\.0\.0\.1)$/.test(parsed.hostname)) return null;
    return parsed.toString();
  } catch { return null; }
}

function domainFromUrl(raw) {
  try {
    const host = new URL(String(raw || '')).hostname.toLowerCase();
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch { return ''; }
}

function endsWithAny(host, roots) {
  const h = String(host || '').toLowerCase();
  return roots.some(r => h === r || h.endsWith(`.${r}`));
}

function domainBoost(url, query) {
  const host = domainFromUrl(url);
  const q = String(query || '').toLowerCase();
  const indiaQuery = /\bindia\b|\bindian\b|\bdelhi\b|\bmumbai\b|\bbollywood\b|\bipl\b|\bbcci\b/.test(q);
  let boost = 0;
  if (endsWithAny(host, TRUSTED_GLOBAL_DOMAINS)) boost += 2;
  if (endsWithAny(host, TRUSTED_INDIAN_DOMAINS)) boost += indiaQuery ? 5 : 3;
  return boost;
}

function scoreSnippet(text, query) {
  const t = String(text || '').toLowerCase();
  const terms = Array.from(
    new Set(String(query || '').toLowerCase().split(/[^a-z0-9]+/).filter(x => x.length > 2))
  );
  return terms.filter(term => t.includes(term)).length;
}

function shouldSkipJina(url) {
  return endsWithAny(domainFromUrl(url), JINA_SKIP_DOMAINS);
}

// ── Network ───────────────────────────────────────────────────────────────────
async function fetchWithTimeout(url, opts = {}, timeoutMs = 12000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Serper — get URLs + Google snippets ───────────────────────────────────────
async function searchSerper(query, numResults = 10) {
  const key = process.env.SERPER_API_KEY;
  if (!key) return { urls: [], snippetMap: {} };

  try {
    const res = await fetchWithTimeout('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': key },
      body: JSON.stringify({ q: query, num: numResults, gl: 'in', hl: 'en' }),
    }, 8000);

    if (!res.ok) return { urls: [], snippetMap: {} };
    const data = await res.json();

    const urls = [];      // ordered list of URLs to Jina-fetch
    const snippetMap = {}; // url → google snippet (fallback if Jina fails)
    const seen = new Set();

    function addResult(link, title, snippet) {
      const url = normalizeUrl(link);
      if (!url || seen.has(url)) return;
      seen.add(url);
      urls.push({ url, title: String(title || '').trim() });
      snippetMap[url] = preview(snippet || title || '', 1300);
    }

    // Answer box first — highest quality
    if (data.answerBox) {
      addResult(
        data.answerBox.link || 'https://google.com',
        data.answerBox.title || 'Answer',
        data.answerBox.answer || data.answerBox.snippet || ''
      );
    }

    // Top stories (breaking news)
    for (const r of (data.topStories || [])) addResult(r.link, r.title, r.snippet || r.title);

    // Organic results
    for (const r of (data.organic || [])) addResult(r.link, r.title, r.snippet);

    return { urls, snippetMap };
  } catch {
    return { urls: [], snippetMap: {} };
  }
}

// ── DuckDuckGo fallback (no Serper key) ──────────────────────────────────────
async function searchDuckDuckGo(query, numResults = 10) {
  try {
    const res = await fetchWithTimeout(
      `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const html = await res.text();
    const urls = [];
    const snippetMap = {};
    const seen = new Set();
    const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) && urls.length < numResults) {
      const url = normalizeUrl(m[1].replace(/&amp;/g, '&'));
      const title = m[2].replace(/<[^>]+>/g, '').trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      urls.push({ url, title });
      snippetMap[url] = title;
    }
    return { urls, snippetMap };
  } catch {
    return { urls: [], snippetMap: {} };
  }
}

// ── Jina Reader — full page text extraction ───────────────────────────────────
async function jinaFetch(url) {
  try {
    const jinaUrl = `https://r.jina.ai/${url}`;
    const res = await fetchWithTimeout(jinaUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'text/plain',
        // Strip nav/ads — Jina supports X-Remove-Selector
        'X-Remove-Selector': 'nav, footer, header, .ads, .sidebar, .comments, script, style',
        'X-Target-Selector': 'article, main, .content, .article-body, .post-content, body',
      },
    }, 14000);
    if (!res.ok) return '';
    const text = await res.text();
    return preview(text, 1800); // more chars since it's real article content
  } catch {
    return '';
  }
}

// ── Parallel Jina fetch for top N URLs ───────────────────────────────────────
async function fetchAllWithJina(urlItems, snippetMap, limit = 5) {
  const top = urlItems.slice(0, limit);

  // Fire all Jina requests in parallel
  const results = await Promise.allSettled(
    top.map(async ({ url, title }) => {
      let text = '';

      if (shouldSkipJina(url)) {
        // Paywall site — use Google snippet directly, still useful
        text = snippetMap[url] || '';
      } else {
        text = await jinaFetch(url);
        // If Jina returned nothing useful, fall back to Google snippet
        if (!text || text.length < 80) {
          text = snippetMap[url] || '';
        }
      }

      return { url, title, text };
    })
  );

  return results
    .filter(r => r.status === 'fulfilled' && r.value.text && r.value.text.length > 40)
    .map(r => r.value);
}

// ── Diversify — max 1 per domain in final output ──────────────────────────────
function diversify(items, query, limit) {
  const scored = items.map(item => ({
    ...item,
    score: scoreSnippet(item.text, query) + domainBoost(item.url, query),
  }));
  scored.sort((a, b) => b.score - a.score);

  const seen = new Set();
  const out = [];
  for (const item of scored) {
    const domain = domainFromUrl(item.url);
    if (seen.has(domain)) continue;
    seen.add(domain);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  try {
    const session = await requireSession(req, res);
    if (!session) return;

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const query   = String(payload.query || '').trim();
    const limit   = Math.max(1, Math.min(Number(payload.limit || 4), 8));

    if (!query) return res.status(200).json({ snippets: [] });

    // Step 1 — get URLs from Serper (or DuckDuckGo fallback)
    let { urls, snippetMap } = await searchSerper(query, 10);
    if (!urls.length) {
      ({ urls, snippetMap } = await searchDuckDuckGo(query, 10));
    }

    if (!urls.length) return res.status(200).json({ snippets: [] });

    // Step 2 — Jina fetches top 5 URLs in PARALLEL (full article text)
    const fetched = await fetchAllWithJina(urls, snippetMap, 5);

    // Step 3 — score, diversify, return top `limit`
    const snippets = diversify(fetched, query, limit).map(item => ({
      title:  item.title,
      url:    item.url,
      source: 'serper+jina',
      text:   item.text,
      score:  item.score,
    }));

    return res.status(200).json({ snippets });

  } catch (err) {
    return res.status(err.status || 500).json({
      error:  err.message || 'Web retrieval error',
      detail: err.data   || null,
    });
  }
}
