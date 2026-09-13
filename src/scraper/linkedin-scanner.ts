import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import { saveJobRecord, JobRecord } from '../db/schema';
import { CONFIG, loadProfile } from '../config';

export interface LinkedInScanOptions {
  query: string;
  location: string;
  maxPages?: number;
  headless?: boolean;
  workTypes?: string; // e.g. '2,3' for Remote & Hybrid. Default: '2,3'
  timePosted?: string; // e.g. '15d', 'month', 'week', '24h', 'all', or direct 'r1296000'. Default: '15d'
}

/** Converts friendly time string to LinkedIn f_TPR seconds parameter */
export function parseLinkedInTimePosted(input?: string): { f_tpr: string; label: string } {
  if (!input) {
    return { f_tpr: 'r1296000', label: 'Past 15 Days' };
  }
  const clean = input.trim().toLowerCase();
  if (clean === 'all' || clean === 'any' || clean === 'none') {
    return { f_tpr: '', label: 'Any Time' };
  }
  if (clean === '24h' || clean === '1d' || clean === '1' || clean === 'today' || clean === 'day') {
    return { f_tpr: 'r86400', label: 'Past 24 Hours' };
  }
  if (clean === 'week' || clean === '7d' || clean === '7') {
    return { f_tpr: 'r604800', label: 'Past Week (7 Days)' };
  }
  if (clean === 'month' || clean === '30d' || clean === '30') {
    return { f_tpr: 'r2592000', label: 'Past Month (30 Days)' };
  }
  const dayMatch = clean.match(/^(\d+)d?(?:ays?)?$/);
  if (dayMatch) {
    const days = parseInt(dayMatch[1], 10);
    const seconds = days * 86400;
    return { f_tpr: `r${seconds}`, label: `Past ${days} Days` };
  }
  if (clean.startsWith('r')) {
    return { f_tpr: clean, label: `Custom (${clean})` };
  }
  return { f_tpr: clean ? `r${clean}` : '', label: clean };
}

export async function scanLinkedInJobs(options: LinkedInScanOptions): Promise<JobRecord[]> {
  const { query, location = 'India', maxPages = 3, headless = true, workTypes = '2,3', timePosted = '15d' } = options;

  const { f_tpr, label: timeLabel } = parseLinkedInTimePosted(timePosted);
  console.log(`\n🔍 [LinkedIn Scanner] Starting search for "${query}" in "${location}" (Easy Apply + Remote/Hybrid + ${timeLabel})...`);

  const encodedQuery = encodeURIComponent(query);
  const encodedLocation = encodeURIComponent(location);
  const timeQuery = f_tpr ? `&f_TPR=${f_tpr}` : '';
  // f_AL=true (Easy Apply) | f_WT=2,3 (Remote & Hybrid Work Types) | f_TPR (Time Range)
  const baseUrl = `https://www.linkedin.com/jobs/search/?keywords=${encodedQuery}&location=${encodedLocation}&f_AL=true&f_WT=${workTypes}${timeQuery}`;

  let browserContext: BrowserContext | null = null;
  let standaloneBrowser: any = null;
  let page: Page | null = null;
  let isCdpSession = false;

  const scrapedJobs: JobRecord[] = [];

  try {
    // Try connecting to active logged-in Chrome session first (preferred — uses your real session)
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CONFIG.cdpPort}`);
      browserContext = browser.contexts()[0] || await browser.newContext();
      page = await browserContext.newPage();
      isCdpSession = true;
      console.log(`✅ [LinkedIn Scanner] Using active Chrome session on CDP port ${CONFIG.cdpPort}`);
      await page.bringToFront().catch(() => null);
    } catch {
      console.log(`🌐 [LinkedIn Scanner] Launching persistent visible browser window...`);
      const userDataDir = path.resolve(process.cwd(), '.chrome-user-data');
      browserContext = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--start-maximized'],
        viewport: null
      });
      page = browserContext.pages()[0] || await browserContext.newPage();
      console.log(`🌐 [LinkedIn Scanner] Running in persistent visible browser context`);
    }

    if (!page) {
      console.error(`❌ Unable to create browser page.`);
      return [];
    }

    // Set fast default timeout (5s max per operation) so missing elements don't hang
    page.setDefaultTimeout(5000);

    for (let pageNum = 0; pageNum < maxPages; pageNum++) {
      const pageUrl = `${baseUrl}&start=${pageNum * 25}`;
      console.log(`🌐 Navigating to LinkedIn Page ${pageNum + 1}: ${pageUrl}`);

      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      // Random delay to appear human (2.5s – 4s)
      await page.waitForTimeout(2500 + Math.floor(Math.random() * 1500));

      // Auto-scroll the jobs container to trigger lazy loading of all ~25 cards on this page
      for (let s = 0; s < 5; s++) {
        await page.evaluate(() => {
          const container = document.querySelector('.jobs-search-results-list') ||
            document.querySelector('.scaffold-layout__list') ||
            document.querySelector('.scaffold-layout__list-detail-inner') ||
            document.querySelector('ul.jobs-search__results-list')?.parentElement ||
            document.documentElement;
          if (container) {
            container.scrollBy(0, 1000);
          }
        }).catch(() => null);
        await page.waitForTimeout(400);
      }

      // Check if more cards render by scrolling last visible card into view
      const interimCards = page.locator('li.jobs-search-results__list-item, ul.jobs-search__results-list > li, div.base-card, div.job-search-card, div.job-card-container');
      const interimCount = await interimCards.count();
      if (interimCount > 0 && interimCount < 20) {
        await interimCards.nth(interimCount - 1).scrollIntoViewIfNeeded().catch(() => null);
        await page.waitForTimeout(400);
        await page.evaluate(() => {
          const container = document.querySelector('.jobs-search-results-list') || document.documentElement;
          if (container) container.scrollBy(0, 1200);
        }).catch(() => null);
        await page.waitForTimeout(400);
      }

      // Select loaded job card containers (handles both authenticated & guest LinkedIn layouts)
      const jobCards = page.locator('li.jobs-search-results__list-item, ul.jobs-search__results-list > li, div.base-card, div.job-search-card, div.job-card-container');
      const count = await jobCards.count();

      console.log(`📌 Found ${count} job cards on Page ${pageNum + 1}`);

      if (count === 0) {
        console.log('⚠️ No job cards found on this page or auth wall encountered.');
        break;
      }

      let savedCount = 0;
      for (let i = 0; i < count; i++) {
        try {
          const card = jobCards.nth(i);
          const cardText = (await card.textContent({ timeout: 1000 }).catch(() => '')) || '';

          // In public guest mode without CDP, verify card has "Easy Apply" badge
          // In authenticated CDP mode, LinkedIn's f_AL=true filter is reliable — skip badge check
          if (!isCdpSession) {
            const hasEasyApplyTag = cardText.toLowerCase().includes('easy apply') ||
              (await card.locator('*:has-text("Easy Apply")').count()) > 0;
            if (!hasEasyApplyTag) {
              continue; // Skip non-Easy-Apply positions during scan
            }
          }

          // Extract link & URL (short 1s timeout to avoid hangs)
          const linkEl = card.locator('a.job-card-container__link, a.job-card-list__title, a.base-card__full-link, a[href*="/jobs/view/"]').first();
          const url = (await linkEl.getAttribute('href', { timeout: 1000 }).catch(() => '')) || '';

          // Extract title
          const titleEl = card.locator('a.job-card-list__title, h3.base-search-card__title, h3, span.sr-only').first();
          let title = (await titleEl.textContent({ timeout: 1000 }).catch(() => ''))?.trim() || '';

          if (!title && linkEl) {
            title = (await linkEl.textContent({ timeout: 1000 }).catch(() => ''))?.trim() || '';
          }

          // Extract company
          const companyEl = card.locator('div.artdeco-entity-lockup__subtitle, span.job-card-container__primary-description, a.job-card-container__company-name, .job-card-container__company-name, h4.base-search-card__subtitle, a.hidden-nested-link, h4').first();
          const company = (await companyEl.textContent({ timeout: 1000 }).catch(() => ''))?.trim() || 'Unknown Company';

          // Extract location
          const locEl = card.locator('ul.job-card-container__metadata-wrapper, span.job-search-card__location, span.job-result-card__location').first();
          const locText = (await locEl.textContent({ timeout: 1000 }).catch(() => ''))?.trim() || location;

          // Skip if missing critical info
          if (!url && !title) continue;

          title = title.replace(/\s+/g, ' ');

          // Generate external job ID
          const jobIdMatch = url.match(/view\/(\d+)/) || url.match(/currentJobId=(\d+)/) || url.match(/-(\d+)\?/);
          const rawId = jobIdMatch ? jobIdMatch[1] : Buffer.from(url || `${title}_${company}`).toString('hex').substring(0, 16);
          const externalJobId = `linkedin_${rawId}`;

          const profile = loadProfile();
          const blacklisted = profile.blacklistedCompanies || [];
          const isBlacklisted = blacklisted.some(b => company.toLowerCase().includes(b.toLowerCase()));

          const jobRecord: Omit<JobRecord, 'id' | 'scanned_at'> = {
            platform: 'linkedin',
            external_job_id: externalJobId,
            title: title || 'Angular Developer',
            company,
            location: locText,
            url: url.startsWith('http') ? url : `https://www.linkedin.com${url}`,
            jd_text: `LinkedIn Remote/Hybrid Easy Apply Job for "${query}": ${title} at ${company}. Matched Query: ${query}. Location: ${locText}. Snippet: ${cardText.replace(/\s+/g, ' ').slice(0, 300)}`,
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
          // Soft catch card parsing errors
        }
      }

      console.log(`✅ Saved ${savedCount} confirmed Easy Apply jobs from Page ${pageNum + 1}`);
    }
  } catch (err: any) {
    console.error(`❌ [LinkedIn Scanner Error]: ${err.message}`);
  } finally {
    if (page && isCdpSession) {
      await page.close().catch(() => null);
    } else if (standaloneBrowser) {
      await standaloneBrowser.close().catch(() => null);
    }
  }

  console.log(`\n🎉 [LinkedIn Scanner Completed] Saved ${scrapedJobs.length} confirmed Easy Apply jobs to database.`);
  return scrapedJobs;
}
