// Vercel Serverless Function — scrapes Mortgage News Daily for current rates
// Endpoint: GET /api/rates
// Returns JSON with all 6 MND rate products, MBS data, and treasury yield

const PRODUCT_MAP = [
  { key: 'thirty_yr_fixed', label: '30 Yr Fixed', cls: 'conv', defaultYears: 30 },
  { key: 'fifteen_yr_fixed', label: '15 Yr Fixed', cls: 'conv', defaultYears: 15 },
  { key: 'thirty_yr_jumbo', label: '30 Yr Jumbo', cls: 'jumbo', defaultYears: 30 },
  { key: 'seven_six_arm', label: '7/6 SOFR ARM', cls: 'arm', defaultYears: 30 },
  { key: 'thirty_yr_fha', label: '30 Yr FHA', cls: 'govt', defaultYears: 30 },
  { key: 'thirty_yr_va', label: '30 Yr VA', cls: 'govt', defaultYears: 30 },
];

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=1800'); // 15min cache

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const response = await fetch('https://www.mortgagenewsdaily.com/mortgage-rates', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (!response.ok) {
      throw new Error(`MND returned ${response.status}`);
    }

    const html = await response.text();

    // Parse rate products (data-series 0-5)
    const rates = [];
    for (let i = 0; i < 6; i++) {
      const product = PRODUCT_MAP[i];

      // Extract rate from data-calc-rate attribute
      const rateMatch = html.match(
        new RegExp(`data-series="${i}"[\\s\\S]*?data-calc-rate="([\\d.]+)"`)
      );

      // Extract daily change from rate-daily-chg
      const chgRegex = /rate-daily-chg[\s\S]*?([-+]?\d+\.?\d*)\s*<\/div>/g;
      let chgMatch;
      const allChanges = [];
      while ((chgMatch = chgRegex.exec(html)) !== null) {
        allChanges.push(parseFloat(chgMatch[1]));
      }

      // Extract 52-week range (low and high appear twice per product, take unique pairs)
      const lowRegex = /range-val low[^>]*>([\d.]+)%<\/div>/g;
      const highRegex = /range-val high[^>]*>([\d.]+)%<\/div>/g;
      const allLows = [];
      const allHighs = [];
      let m;
      while ((m = lowRegex.exec(html)) !== null) allLows.push(parseFloat(m[1]));
      while ((m = highRegex.exec(html)) !== null) allHighs.push(parseFloat(m[1]));

      // Each product has 2 low and 2 high entries (mobile + desktop), dedupe by index
      const uniqueLows = [];
      const uniqueHighs = [];
      for (let j = 0; j < allLows.length; j += 2) uniqueLows.push(allLows[j]);
      for (let j = 0; j < allHighs.length; j += 2) uniqueHighs.push(allHighs[j]);

      const rate = rateMatch ? parseFloat(rateMatch[1]) : null;
      const chg = allChanges[i] !== undefined ? allChanges[i] : null;
      const lo = uniqueLows[i] !== undefined ? uniqueLows[i] : null;
      const hi = uniqueHighs[i] !== undefined ? uniqueHighs[i] : null;

      rates.push({
        key: product.key,
        label: product.label,
        cls: product.cls,
        rate,
        chg,
        lo,
        hi,
        years: product.defaultYears,
      });
    }

    // Extract MBS price from the page (UMBS 30YR section)
    let mbs = null;
    const mbsMatch = html.match(/current-rate mbs[\s\S]*?([\d.]+)/);
    if (mbsMatch) mbs = parseFloat(mbsMatch[1]);

    // Extract 10Y Treasury
    let treasury10y = null;
    const treasuryMatch = html.match(/10 Year US Treasury[\s\S]*?current-rate mbs[\s\S]*?([\d.]+)/);
    if (treasuryMatch) treasury10y = parseFloat(treasuryMatch[1]);

    // Check if any rates were actually found
    const validRates = rates.filter(r => r.rate !== null);
    if (validRates.length === 0) {
      throw new Error('Failed to parse any rates from MND page');
    }

    return res.status(200).json({
      source: 'mortgagenewsdaily.com',
      fetched_at: new Date().toISOString(),
      rates,
      market: { mbs_price: mbs, treasury_10y: treasury10y },
    });
  } catch (err) {
    console.error('Rate scrape error:', err.message);
    return res.status(502).json({
      error: 'Failed to fetch rates',
      message: err.message,
      fetched_at: new Date().toISOString(),
    });
  }
}
