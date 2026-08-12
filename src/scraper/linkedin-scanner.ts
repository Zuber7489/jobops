import { chromium } from 'playwright';
import { saveJobRecord, JobRecord } from '../db/schema';

export interface LinkedInScanOptions {
  query: string;
  location: string;
  maxPages?: number;
  headless?: boolean;
}

export async function scanLinkedInJobs(options: LinkedInScanOptions): Promise<JobRecord[]> {
  const { query, location = 'India', maxPages = 3, headless = true } = options;

  console.log(`\n🔍 [LinkedIn Scanner] Starting search for "${query}" in "${location}" (Easy Apply + Hybrid/Remote Filtered)...`);

  const encodedQuery = encodeURIComponent(query);
  const encodedLocation = encodeURIComponent(location);
  // f_AL=true (Easy Apply) | f_WT=2,3 (Remote & Hybrid Work Types)
  const baseUrl = `https://www.linkedin.com/jobs/search/?keywords=${encodedQuery}&location=${encodedLocation}&f_AL=true&f_WT=2,3`;

  const browser = await chromium.launch({
    headless,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 }
  });

  const page = await context.newPage();
  const scrapedJobs: JobRecord[] = [];

  try {
    for (let pageNum = 0; pageNum < maxPages; pageNum++) {
      const pageUrl = `${baseUrl}&start=${pageNum * 25}`;
      console.log(`🌐 Navigating to LinkedIn Page ${pageNum + 1}: ${pageUrl}`);

      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000 + Math.random() * 2000);

      // Select job card containers
      const jobCards = page.locator('ul.jobs-search__results-list > li, div.base-card, div.job-search-card');
      const count = await jobCards.count();

      console.log(`📌 Found ${count} job cards on Page ${pageNum + 1}`);

      if (count === 0) {
        console.log('⚠️ No job cards found on this page or auth wall encountered.');
        break;
      }

      for (let i = 0; i < count; i++) {
        try {
          const card = jobCards.nth(i);

          // Extract link & URL
          const linkEl = card.locator('a.base-card__full-link, a.job-card-container__link, a[href*="/jobs/view/"]').first();
          const url = (await linkEl.getAttribute('href').catch(() => '')) || '';

          // Extract title
          const titleEl = card.locator('h3.base-search-card__title, h3, a.job-card-list__title, span.sr-only').first();
          let title = (await titleEl.textContent().catch(() => ''))?.trim() || '';

          if (!title && linkEl) {
            title = (await linkEl.textContent().catch(() => ''))?.trim() || '';
          }

          // Extract company
          const companyEl = card.locator('h4.base-search-card__subtitle, a.hidden-nested-link, h4').first();
          const company = (await companyEl.textContent().catch(() => ''))?.trim() || 'Unknown Company';

          // Extract location
          const locEl = card.locator('span.job-search-card__location, span.job-result-card__location').first();
          const locText = (await locEl.textContent().catch(() => ''))?.trim() || location;

          // Skip if missing critical info
          if (!url && !title) continue;

          title = title.replace(/\s+/g, ' ');

          // Generate external job ID
          const jobIdMatch = url.match(/view\/(\d+)/) || url.match(/currentJobId=(\d+)/) || url.match(/-(\d+)\?/);
          const rawId = jobIdMatch ? jobIdMatch[1] : Buffer.from(url || `${title}_${company}`).toString('hex').substring(0, 16);
          const externalJobId = `linkedin_${rawId}`;

          const jobRecord: Omit<JobRecord, 'id' | 'scanned_at'> = {
            platform: 'linkedin',
            external_job_id: externalJobId,
            title: title || 'Angular Developer',
            company,
            location: locText,
            url: url.startsWith('http') ? url : `https://www.linkedin.com${url}`,
            jd_text: `LinkedIn Hybrid/Remote Easy Apply Job: ${title} at ${company}`,
            apply_type: 'easy-apply',
            score: 0.0,
            status: 'scanned'
          };

          saveJobRecord(jobRecord);
          scrapedJobs.push(jobRecord as JobRecord);
        } catch (cardErr: any) {
          console.error(`⚠️ Card #${i + 1} extraction error:`, cardErr.message);
        }
      }
    }
  } catch (err: any) {
    console.error(`❌ [LinkedIn Scanner Error]: ${err.message}`);
  } finally {
    await browser.close();
  }

  console.log(`✅ [LinkedIn Scanner Completed] Successfully saved ${scrapedJobs.length} Hybrid/Remote jobs to database.`);
  return scrapedJobs;
}
