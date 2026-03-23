import 'dotenv/config';

const BASE_URL = process.env.SEED_URL || 'http://localhost:3000';

const SEED_QUERIES = [
  { query: 'Petco', mode: 'company' },
  { query: 'PetSmart', mode: 'company' },
  { query: 'Whataburger', mode: 'company' },
  { query: 'Panera Bread', mode: 'company' },
  { query: 'Chuck E Cheese', mode: 'company' },
  { query: 'Michaels', mode: 'company' },
  { query: 'Guitar Center', mode: 'company' },
  { query: 'GNC', mode: 'company' },
  { query: 'Mattress Firm', mode: 'company' },
  { query: 'Buck Mason', mode: 'company' },
  { query: 'Dave & Busters', mode: 'company' },
  { query: 'Burger King', mode: 'company' },
  { query: 'Popeyes', mode: 'company' },
  { query: 'Asurion', mode: 'company' },
  { query: 'Vitamix', mode: 'company' },
  { query: 'Jo-Ann Fabrics', mode: 'company' },
  { query: 'Serta', mode: 'company' },
  { query: 'Gymboree', mode: 'company' },
  { query: 'Toys R Us', mode: 'company' },
  { query: 'Caesars Entertainment', mode: 'company' },
  { query: 'veterinary clinics', mode: 'industry' },
  { query: 'urgent care', mode: 'industry' },
  { query: 'dental offices', mode: 'industry' },
  { query: 'gyms and fitness', mode: 'industry' },
  { query: 'restaurants', mode: 'industry' },
  { query: 'nursing homes', mode: 'industry' },
  { query: 'software', mode: 'industry' },
  { query: 'healthcare', mode: 'industry' },
  { query: 'KKR', mode: 'firm' },
  { query: 'Blackstone', mode: 'firm' },
  { query: 'Apollo Global', mode: 'firm' },
  { query: 'Bain Capital', mode: 'firm' },
  { query: 'Carlyle Group', mode: 'firm' },
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchWithBackoff(query, mode, maxRetries = 5) {
  let attempt = 0;
  while (attempt <= maxRetries) {
    const res = await fetch(`${BASE_URL}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, mode }),
    });

    if (res.status === 429 || res.status === 500) {
      attempt++;
      if (attempt > maxRetries) throw new Error(`Failed after ${maxRetries} retries`);
      // Exponential backoff: 15s, 30s, 60s, 60s, 60s
      const wait = Math.min(60000, 15000 * Math.pow(2, attempt - 1));
      console.log(`\n    ⏳ Rate limited — waiting ${wait / 1000}s (retry ${attempt}/${maxRetries})...`);
      await sleep(wait);
      continue;
    }

    return res;
  }
}

async function seed() {
  console.log(`\n🌱 Seeding ${SEED_QUERIES.length} queries against ${BASE_URL}...\n`);

  let succeeded = 0;
  let failed = 0;
  let cached = 0;

  for (const { query, mode } of SEED_QUERIES) {
    process.stdout.write(`  "${query}" (${mode})... `);
    try {
      const res = await fetchWithBackoff(query, mode);
      const data = await res.json();

      if (!res.ok) {
        console.log(`❌ ${data.error}`);
        failed++;
      } else if (data._cache) {
        console.log(`⚡ already cached`);
        cached++;
        succeeded++;
      } else {
        console.log(`✅ ${data.companies?.length || 0} results saved`);
        succeeded++;
        // Wait 60s between fresh API calls to stay under rate limits
        await sleep(60000);
      }
    } catch (err) {
      console.log(`❌ ${err.message}`);
      failed++;
      await sleep(30000);
    }
  }

  console.log(`\n✨ Done!`);
  console.log(`   ✅ ${succeeded} succeeded  ❌ ${failed} failed  ⚡ ${cached} already cached\n`);
}

seed();
