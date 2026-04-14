// Vercel Edge Function — lightweight endpoint for the frontend
// Reads from the edge-cached /api/scrape endpoint (populated by cron)
// If cache is empty/cold, triggers a live scrape as fallback
// Endpoint: GET /api/rates

export const config = { runtime: 'edge' };

const PRODUCT_MAP = [
  { key: 'thirty_yr_fixed', label: '30 Yr Fixed', cls: 'conv', defaultYears: 30 },
  { key: 'fifteen_yr_fixed', label: '15 Yr Fixed', cls: 'conv', defaultYears: 15 },
  { key: 'thirty_yr_jumbo', label: '30 Yr Jumbo', cls: 'jumbo', defaultYears: 30 },
  { key: 'seven_six_arm', label: '7/6 SOFR ARM', cls: 'arm', defaultYears: 30 },
  { key: 'thirty_yr_fha', label: '30 Yr FHA', cls: 'govt', defaultYears: 30 },
  { key: 'thirty_yr_va', label: '30 Yr VA', cls: 'govt', defaultYears: 30 },
];

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  // Vercel-specific: controls edge CDN cache separately from browser cache
  'Vercel-CDN-Cache-Control': 's-maxage=300, stale-while-revalidate=900',
  'CDN-Cache-Control': 's-maxage=300, stale-while-revalidate=900',
  'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=900',
};

async function scrapeMND() {
  const response = await fetch('https://www.mortgagenewsdaily.com/mortgage-rates', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (!response.ok) throw new Error(`MND returned ${response.status}`);
  const html = await response.text();

  const allChanges = [];
  const chgRegex = /rate-daily-chg[\s\S]*?([-+]?\d+\.?\d*)\s*<\/div>/g;
  let m;
  while ((m = chgRegex.exec(html)) !== null) allChanges.push(parseFloat(m[1]));

  const allLows = [], allHighs = [];
  const lowRegex = /range-val low[^>]*>([\d.]+)%<\/div>/g;
  const highRegex = /range-val high[^>]*>([\d.]+)%<\/div>/g;
  while ((m = lowRegex.exec(html)) !== null) allLows.push(parseFloat(m[1]));
  while ((m = highRegex.exec(html)) !== null) allHighs.push(parseFloat(m[1]));

  const uniqueLows = allLows.filter((_, j) => j % 2 === 0);
  const uniqueHighs = allHighs.filter((_, j) => j % 2 === 0);

  const rates = PRODUCT_MAP.map((product, i) => {
    const rateMatch = html.match(
      new RegExp(`data-series="${i}"[\\s\\S]*?data-calc-rate="([\\d.]+)"`)
    );
    return {
      key: product.key,
      label: product.label,
      cls: product.cls,
      rate: rateMatch ? parseFloat(rateMatch[1]) : null,
      chg: allChanges[i] ?? null,
      lo: uniqueLows[i] ?? null,
      hi: uniqueHighs[i] ?? null,
      years: product.defaultYears,
    };
  });

  const mbsMatch = html.match(/current-rate mbs[\s\S]*?([\d.]+)/);
  const mbs = mbsMatch ? parseFloat(mbsMatch[1]) : null;
  const treasuryMatch = html.match(/10 Year US Treasury[\s\S]*?current-rate mbs[\s\S]*?([\d.]+)/);
  const treasury10y = treasuryMatch ? parseFloat(treasuryMatch[1]) : null;

  if (rates.every(r => r.rate === null)) {
    throw new Error('Failed to parse any rates from MND page');
  }

  // Fetch daily rate commentary from MND RSS feed
  // Articles on the main page are client-rendered (Handlebars + WebSocket),
  // so we grab from the RSS feed instead which has actual content
  // Fetch multiple articles from MND RSS feed for the news carousel
  let commentary = null;
  const articles = [];
  try {
    const rssRes = await fetch('https://www.mortgagenewsdaily.com/rss/full', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HomespireRates/1.0)' },
    });
    if (rssRes.ok) {
      const rssXml = await rssRes.text();
      const items = rssXml.split('<item>').slice(1, 10); // scan first 10 items

      for (const item of items) {
        const titleMatch = item.match(/<title>([\s\S]*?)<\/title>/);
        const descMatch = item.match(/<description>([\s\S]*?)<\/description>/);
        const linkMatch = item.match(/<link>([\s\S]*?)<\/link>/);
        const dateMatch = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
        const title = titleMatch ? titleMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';

        if (descMatch) {
          let desc = descMatch[1]
            .replace(/<!\[CDATA\[|\]\]>/g, '')
            .replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/\s+/g, ' ')
            .trim();
          // Skip items with unrendered template placeholders
          if (desc.includes('{{') || desc.length < 20) continue;
          if (desc.length > 300) desc = desc.slice(0, 297) + '...';
          const link = linkMatch ? linkMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : null;
          const pubDate = dateMatch ? dateMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : null;
          articles.push({ headline: title.trim(), summary: desc, link, pubDate });
          if (articles.length >= 5) break; // max 5 articles for carousel
        }
      }
    }
  } catch (e) {
    // RSS fetch is non-critical — commentary falls back to auto-generated
  }
  if (articles.length > 0) {
    commentary = articles; // Array of articles for carousel
  }

  return {
    source: 'mortgagenewsdaily.com',
    fetched_at: new Date().toISOString(),
    rates,
    market: { mbs_price: mbs, treasury_10y: treasury10y },
    commentary,
  };
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: HEADERS });
  }

  try {
    // Direct scrape (edge-cached by Vercel CDN via Cache-Control header)
    // Vercel's edge cache means: first request scrapes, next ~5 min get instant cache hits
    // stale-while-revalidate means even after 5 min, users get instant stale data
    // while the cache refreshes in the background
    const data = await scrapeMND();

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: HEADERS,
    });
  } catch (err) {
    return new Response(JSON.stringify({
      error: 'Failed to fetch rates',
      message: err.message,
      fetched_at: new Date().toISOString(),
    }), { status: 502, headers: HEADERS });
  }
}
