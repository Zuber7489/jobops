import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import { saveJobRecord, JobRecord } from '../db/schema';
import { CONFIG, loadProfile } from '../config';

export interface NaukriScanOptions {
  query: string;
  location: string;
  maxPages?: number;
  headless?: boolean;
}

export async function scanNaukriJobs(options: NaukriScanOptions): Promise<JobRecord[]> {
  const { query = 'Angular Developer', location = 'India', maxPages = 3, headless = false } = options;

  console.log(`\n🔍 [Naukri Scanner] Starting search for "${query}" in "${location}"...`);

  // Construct standard Naukri SEO query slug
  const querySlug = query.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const locationSlug = location.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const slug = `${querySlug}-jobs-in-${locationSlug}`;
  const encodedQuery = encodeURIComponent(query);
  const encodedLocation = encodeURIComponent(location);
  const baseUrl = `https://www.naukri.com/${slug}?k=${encodedQuery}&l=${encodedLocation}`;

  let browserContext: BrowserContext | null = null;
  let standaloneBrowser: any = null;
  let page: Page | null = null;
  let isCdpSession = false;

  const scrapedJobs: JobRecord[] = [];

  try {
    // 1. Try connecting to active logged-in Chrome CDP session first (Port 9222)
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CONFIG.cdpPort}`);
      browserContext = browser.contexts()[0] || await browser.newContext();
      page = await browserContext.newPage();
      isCdpSession = true;
      console.log(`✅ [Naukri Scanner] Connected to active Chrome session on CDP port ${CONFIG.cdpPort}`);
      await page.bringToFront().catch(() => null);
    } catch {
      // 2. Fallback: Launch persistent context with real Chrome executable to bypass Akamai WAF
      console.log(`🌐 [Naukri Scanner] Launching persistent Chrome browser with user profile...`);
      const userDataDir = path.resolve(CONFIG.userDataDir);
      browserContext = await chromium.launchPersistentContext(userDataDir, {
        executablePath: CONFIG.chromeExecutablePath,
        headless: false, // Headed required to reliably pass Naukri's Akamai bot challenge
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--start-minimized'
        ],
        viewport: { width: 1366, height: 768 }
      });
      page = browserContext.pages()[0] || await browserContext.newPage();
      console.log(`🌐 [Naukri Scanner] Running in persistent Chrome profile context`);
    }

    if (!page) {
      console.error(`❌ Unable to create browser page for Naukri scanner.`);
      return [];
    }

    page.setDefaultTimeout(15000);

    const profile = loadProfile();
    const blacklisted = profile.blacklistedCompanies || [];

    for (let pageNum = 0; pageNum < maxPages; pageNum++) {
      // Page 1 is base URL; Page 2+ is `...-jobs-in-india-2?k=...`
      const pageUrl = pageNum === 0 ? baseUrl : `https://www.naukri.com/${slug}-${pageNum + 1}?k=${encodedQuery}&l=${encodedLocation}`;
      console.log(`🌐 Navigating to Naukri Page ${pageNum + 1}: ${pageUrl}`);

      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
      await page.waitForTimeout(3000);
      await page.mouse.wheel(0, 400).catch(() => null);
      await page.waitForTimeout(1500);

      // Select Naukri job card tuples
      const jobCards = page.locator('.srp-jobtuple-wrapper, article.jobTuple, div.cust-job-tuple, div[data-job-id]');
      const count = await jobCards.count();

      console.log(`📌 Found ${count} job cards on Naukri Page ${pageNum + 1}`);

      if (count === 0) {
        console.log('⚠️ No job cards found on this page or end of results reached.');
        break;
      }

      let savedCount = 0;
      for (let i = 0; i < count; i++) {
        try {
          const card = jobCards.nth(i);

          // Title & URL
          const titleEl = card.locator('a.title, a[class*="title"]').first();
          let title = (await titleEl.textContent({ timeout: 1000 }).catch(() => ''))?.trim() || '';
          let url = (await titleEl.getAttribute('href', { timeout: 1000 }).catch(() => '')) || '';

          if (!title || !url) continue;

          // Company
          const companyEl = card.locator('a.comp-name, a.subTitle, [class*="comp-name"], [class*="company"]').first();
          const company = (await companyEl.textContent({ timeout: 1000 }).catch(() => ''))?.trim() || 'Unknown Company';

          // Location
          const locEl = card.locator('.loc-wrap, .location, span[class*="loc"], span.locWdth').first();
          const locText = (await locEl.textContent({ timeout: 1000 }).catch(() => ''))?.trim() || location;

          // Experience & Salary
          const expEl = card.locator('.exp-wrap, .experience, span[class*="exp"], span.expwdth').first();
          const expText = (await expEl.textContent({ timeout: 1000 }).catch(() => ''))?.trim() || '';

          const salEl = card.locator('.sal-wrap, .salary, span[class*="sal"]').first();
          const salText = (await salEl.textContent({ timeout: 1000 }).catch(() => ''))?.trim() || '';

          // Skills & Tags
          const tagEls = card.locator('.tags-gt li, ul.tags-gt li, .dot-gt, [class*="tag"]');
          const tagCount = await tagEls.count();
          const tags: string[] = [];
          for (let t = 0; t < Math.min(tagCount, 8); t++) {
            const tagVal = (await tagEls.nth(t).textContent().catch(() => ''))?.trim();
            if (tagVal && !tags.includes(tagVal)) tags.push(tagVal);
          }

          // External Job ID: extracted from URL e.g. /job-listings-...-101025014953
          const matchId = url.match(/-(\d{10,14})(?:\?|$)/);
          const rawId = matchId ? matchId[1] : Buffer.from(url).toString('hex').substring(0, 16);
          const externalJobId = `naukri_${rawId}`;

          const fullUrl = url.startsWith('http') ? url : `https://www.naukri.com${url}`;

          // Detect apply type
          const cardText = (await card.textContent().catch(() => '')) || '';
          const isExternal = /apply on company site|company site/i.test(cardText);
          const applyType = isExternal ? 'external' : 'easy-apply';

          const isBlacklisted = blacklisted.some(b => company.toLowerCase().includes(b.toLowerCase()));

          const jdSummary = [
            `Naukri Job: ${title} at ${company}`,
            expText ? `Experience: ${expText}` : '',
            salText ? `Salary: ${salText}` : '',
            locText ? `Location: ${locText}` : '',
            tags.length > 0 ? `Key Skills: ${tags.join(', ')}` : ''
          ].filter(Boolean).join(' | ');

          const jobRecord: Omit<JobRecord, 'id' | 'scanned_at'> = {
            platform: 'naukri',
            external_job_id: externalJobId,
            title: title.replace(/\s+/g, ' '),
            company,
            location: locText,
            url: fullUrl,
            jd_text: jdSummary,
            apply_type: applyType,
            score: 0.0,
            evaluation_reason: isBlacklisted ? 'Blacklisted company' : '',
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

      console.log(`✅ Saved ${savedCount} confirmed jobs from Naukri Page ${pageNum + 1}`);

      // Small delay between pages
      if (pageNum < maxPages - 1) {
        await page.waitForTimeout(2500);
      }
    }
  } catch (err: any) {
    console.error(`❌ [Naukri Scanner Error]: ${err.message}`);
  } finally {
    if (page && isCdpSession) {
      await page.close().catch(() => null);
    } else if (browserContext && !isCdpSession) {
      await browserContext.close().catch(() => null);
    }
  }

  console.log(`\n🎉 [Naukri Scanner Completed] Saved ${scrapedJobs.length} jobs to database.`);
  return scrapedJobs;
}
