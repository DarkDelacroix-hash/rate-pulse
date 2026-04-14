// Vercel Cron Function — scrapes Mortgage News Daily on a schedule
// This runs in the background every 15 minutes via Vercel Cron
// Stores results in Vercel KV (or falls back to edge cache)
// Endpoint: GET /api/scrape (called by cron, not by frontend)

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
};

export default async function handler(req) {
  // Verify this is called by Vercel Cron (optional auth)
  const authHeader = req.headers.get('authorization');
  const cronSecret = typeof process !== 'undefined' && process.env?.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: HEADERS,
    });
  }

  try {
    const response = await fetch('https://www.mortgagenewsdaily.com/mortgage-rates', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (!response.ok) throw new Error(`MND returned ${response.status}`);
    const html = await response.text();

    // Parse changes and ranges
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

    const payload = {
      source: 'mortgagenewsdaily.com',
      fetched_at: new Date().toISOString(),
      rates,
      market: { mbs_price: mbs, treasury_10y: treasury10y },
    };

    // Return with aggressive edge cache — this IS the cache layer
    // s-maxage=1800 = 30 min (cron runs every 15, so always fresh)
    // stale-while-revalidate=3600 = serve stale up to 1 hour while revalidating
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        ...HEADERS,
        'Vercel-CDN-Cache-Control': 's-maxage=1800, stale-while-revalidate=3600',
        'CDN-Cache-Control': 's-maxage=1800, stale-while-revalidate=3600',
        'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=3600',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({
      error: 'Scrape failed',
      message: err.message,
      fetched_at: new Date().toISOString(),
    }), { status: 502, headers: HEADERS });
  }
}
