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

  // Extract daily rate commentary headline + summary
  // Structure: .article > .article-content > .article-title > a (headline)
  //            .article > .article-content > .article-body (summary)
  let commentary = null;
  try {
    const headlineMatch = html.match(/class="article-title"[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/);
    const bodyMatch = html.match(/class="article-body"[^>]*>([\s\S]*?)<\/div>/);

    let headline = headlineMatch ? headlineMatch[1].replace(/<[^>]+>/g, '').trim() : null;
    let summary = bodyMatch ? bodyMatch[1].replace(/<[^>]+>/g, '').trim() : null;

    // Clean up: limit summary length, remove extra whitespace
    if (summary && summary.length > 500) summary = summary.slice(0, 497) + '...';
    if (summary) summary = summary.replace(/\s+/g, ' ').trim();
    if (headline) headline = headline.replace(/\s+/g, ' ').trim();

    if (headline || summary) {
      commentary = { headline, summary };
    }
  } catch (e) {
    // Commentary parsing is non-critical — don't fail the whole response
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
