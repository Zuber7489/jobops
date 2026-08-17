import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import { saveJobRecord, JobRecord } from '../db/schema';
import { CONFIG, loadProfile } from '../config';

export interface IndeedScanOptions {
  query: string;
  location: string;
  maxPages?: number;
  headless?: boolean;
}

export async function scanIndeedJobs(options: IndeedScanOptions): Promise<JobRecord[]> {
  const { query = 'Angular Developer', location = 'India', maxPages = 3, headless = true } = options;

  console.log(`\n🔍 [Indeed Scanner] Starting search for "${query}" in "${location}" (Easily Apply + Remote/Hybrid Focus)...`);

  const encodedQuery = encodeURIComponent(query);
  const encodedLocation = encodeURIComponent(location);

  // Indeed India Search URL: Filters for Easily Apply jobs (sc=0kf%3Aattr%28DSQF7%29%3B) + Past 24h/Recent
  const baseUrl = `https://in.indeed.com/jobs?q=${encodedQuery}&l=${encodedLocation}&sc=0kf%3Aattr%28DSQF7%29%3B`;

  let browserContext: BrowserContext | null = null;
  let standaloneBrowser: any = null;
  let page: Page | null = null;
  let isCdpSession = false;

  const scrapedJobs: JobRecord[] = [];

  try {
    // Try connecting to active logged-in Chrome CDP session first
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CONFIG.cdpPort}`);
      browserContext = browser.contexts()[0] || await browser.newContext();
      page = await browserContext.newPage();
      isCdpSession = true;
      console.log(`✅ [Indeed Scanner] Connected to active Chrome session on CDP port ${CONFIG.cdpPort}`);
      await page.bringToFront().catch(() => null);
    } catch {
      console.log(`🌐 [Indeed Scanner] Launching persistent visible browser window...`);
      const userDataDir = path.resolve(process.cwd(), '.chrome-user-data');
      browserContext = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--start-maximized'],
        viewport: null
      });
      page = browserContext.pages()[0] || await browserContext.newPage();
      console.log(`🌐 [Indeed Scanner] Running in persistent visible browser context`);
    }

    if (!page) {
      console.error(`❌ Unable to create browser page for Indeed scanner.`);
      return [];
    }

    page.setDefaultTimeout(6000);

    const profile = loadProfile();
    const blacklisted = profile.blacklistedCompanies || [];

    for (let pageNum = 0; pageNum < maxPages; pageNum++) {
      const pageUrl = pageNum === 0 ? baseUrl : `${baseUrl}&start=${pageNum * 10}`;
      console.log(`🌐 Navigating to Indeed Page ${pageNum + 1}: ${pageUrl}`);

      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2500);
      await page.mouse.wheel(0, 400).catch(() => null);
      await page.waitForTimeout(1500);

      // Select Indeed job card containers
      const jobCards = page.locator('div.job_seen_beacon, td.resultContent, div.cardOutline, div[data-jk], div.jobsearch-ResultsList > div');
      const count = await jobCards.count();

      console.log(`📌 Found ${count} job cards on Indeed Page ${pageNum + 1}`);

      if (count === 0) {
        console.log('⚠️ No job cards found on this page or end of results reached.');
        break;
      }

      let savedCount = 0;
      for (let i = 0; i < count; i++) {
        try {
          const card = jobCards.nth(i);

          // Extract title & URL
          const titleEl = card.locator('h2.jobTitle span, a.jcs-JobTitle span, a.jcs-JobTitle, h2.jobTitle a').first();
          let title = (await titleEl.textContent({ timeout: 1000 }).catch(() => ''))?.trim() || '';

          const linkEl = card.locator('a.jcs-JobTitle, h2.jobTitle a, a[data-jk]').first();
          let url = (await linkEl.getAttribute('href', { timeout: 1000 }).catch(() => '')) || '';
          let dataJk = (await linkEl.getAttribute('data-jk', { timeout: 1000 }).catch(() => '')) ||
                       (await card.getAttribute('data-jk', { timeout: 1000 }).catch(() => '')) || '';

          // Extract company
          const companyEl = card.locator('span[data-testid="company-name"], span.companyName, div.company_location span.companyName').first();
          const company = (await companyEl.textContent({ timeout: 1000 }).catch(() => ''))?.trim() || 'Unknown Company';

          // Extract location
          const locEl = card.locator('div[data-testid="text-location"], div.companyLocation, span.location').first();
          const locText = (await locEl.textContent({ timeout: 1000 }).catch(() => ''))?.trim() || location;

          if (!title) continue;

          title = title.replace(/\s+/g, ' ');

          const rawId = dataJk || (url.match(/jk=([a-zA-Z0-9]+)/) || [])[1] || Buffer.from(url || `${title}_${company}`).toString('hex').substring(0, 16);
          const externalJobId = `indeed_${rawId}`;

          const fullUrl = rawId ? `https://in.indeed.com/viewjob?jk=${rawId}` : (url.startsWith('http') ? url : `https://in.indeed.com${url}`);

          const isBlacklisted = blacklisted.some(b => company.toLowerCase().includes(b.toLowerCase()));

          const jobRecord: Omit<JobRecord, 'id' | 'scanned_at'> = {
            platform: 'indeed',
            external_job_id: externalJobId,
            title: title || 'Angular Developer',
            company,
            location: locText,
            url: fullUrl,
            jd_text: `Indeed Easily Apply Job: ${title} at ${company}`,
            apply_type: 'easy-apply',
            score: 0.0,
            evaluation_reason: isBlacklisted ? 'Blacklisted fake company' : '',
            status: isBlacklisted ? 'skipped' : 'scanned'
          };

          saveJobRecord(jobRecord);
          if (!isBlacklisted) {
            scrapedJobs.push(jobRecord as JobRecord);
            savedCount++;
          } else {
            console.log(`🚫 [Blacklisted Company Skipped]: "${title}" at ${company}`);
          }
        } catch {
          // Soft catch
        }
      }

      console.log(`✅ Saved ${savedCount} confirmed jobs from Indeed Page ${pageNum + 1}`);
    }
  } catch (err: any) {
    console.error(`❌ [Indeed Scanner Error]: ${err.message}`);
  } finally {
    if (page && isCdpSession) {
      await page.close().catch(() => null);
    } else if (standaloneBrowser) {
      await standaloneBrowser.close().catch(() => null);
    }
  }

  console.log(`\n🎉 [Indeed Scanner Completed] Saved ${scrapedJobs.length} jobs to database.`);
  return scrapedJobs;
}
