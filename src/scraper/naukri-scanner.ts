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
  const expParam = 2; // Target 2-3 YOE for candidate Mohammad Zuber (2.5 YOE)
  const jobAgeDays = 7; // Only fresh jobs posted within the last 7 days!
  const baseUrl = `https://www.naukri.com/${slug}?k=${encodedQuery}&l=${encodedLocation}&experience=${expParam}&jobAge=${jobAgeDays}`;

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

    // Map to store job details from Naukri's background search API
    const apiJobsMap = new Map<string, any>();

    page.on('response', async (res) => {
      if (res.url().includes('/jobapi/v3/search')) {
        try {
          const json = await res.json();
          if (json.jobDetails && Array.isArray(json.jobDetails)) {
            for (const item of json.jobDetails) {
              if (item.jobId) {
                apiJobsMap.set(item.jobId.toString(), item);
              }
            }
          }
        } catch {}
      }
    });

    const profile = loadProfile();
    const blacklisted = profile.blacklistedCompanies || [];

    for (let pageNum = 0; pageNum < maxPages; pageNum++) {
      // Page 1 is base URL; Page 2+ is `...-jobs-in-india-2?experience=2&jobAge=7`
      const pageUrl = pageNum === 0 ? baseUrl : `https://www.naukri.com/${slug}-${pageNum + 1}?experience=${expParam}&jobAge=${jobAgeDays}`;
      console.log(`🌐 Navigating to Naukri Page ${pageNum + 1}: ${pageUrl}`);

      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
      await page.waitForTimeout(3500);
      await page.mouse.wheel(0, 400).catch(() => null);
      await page.waitForTimeout(1500);

      // Select Naukri job card tuples
      const jobCards = page.locator('.srp-jobtuple-wrapper, article.jobTuple, div.cust-job-tuple, div[data-job-id]');
      const count = await jobCards.count();

      console.log(`📌 Found ${count} job cards on Naukri Page ${pageNum + 1} (${apiJobsMap.size} API metadata cached)`);

      if (count === 0) {
        console.log('⚠️ No job cards found on this page or end of results reached.');
        break;
      }

      let savedCount = 0;
      let externalCount = 0;

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

          // Accurate detection from Naukri search API: companyApplyJob === true means external redirect!
          const apiJob = apiJobsMap.get(rawId);
          const isExternal = apiJob ? (apiJob.companyApplyJob === true || !!apiJob.applyRedirectUrl) : false;
          const applyType = isExternal ? 'external' : 'easy-apply';

          // Experience Check: Candidate has 2.5 YOE (strictly target 2-3 YOE, max 1-4 YOE)
          let minExp = 0;
          let maxExp = 99;
          const expMatch = expText.match(/(\d+)(?:\s*-\s*(\d+))?\s*(?:yr|year)/i) || url.match(/(\d+)-to-(\d+)-years/i);
          if (expMatch) {
            minExp = parseInt(expMatch[1], 10);
            if (expMatch[2]) maxExp = parseInt(expMatch[2], 10);
          }
          const isOverExperienced = minExp >= 4; // Skip any job requiring 4+, 5+, 6+, 10+ years
          const isSeniorTitle = /\b(lead|principal|architect|director|staff|manager|team lead|head)\b/i.test(title);

          // Freshness Check: Skip stale jobs (30+ Days Ago / 15+ Days Ago)
          const postedLabel = apiJob?.footerPlaceholderLabel || '';
          const isStale = /30\+|20\+|15\+/i.test(postedLabel);

          const isBlacklisted = blacklisted.some(b => company.toLowerCase().includes(b.toLowerCase()));
          
          let status: JobRecord['status'] = 'scanned';
          let reason = '';

          if (isBlacklisted) {
            status = 'skipped';
            reason = 'Blacklisted company';
          } else if (isExternal) {
            status = 'skipped';
            reason = 'External Company Site Redirect (Skipped)';
          } else if (isOverExperienced) {
            status = 'skipped';
            reason = `Experience mismatch: Requires ${minExp}+ Yrs (Candidate has ${profile.totalYoe} YOE)`;
          } else if (isSeniorTitle) {
            status = 'skipped';
            reason = `Senior/Lead title mismatch: "${title}"`;
          } else if (isStale) {
            status = 'skipped';
            reason = `Stale job posting: ${postedLabel || '30+ Days Old'}`;
          }

          const jdSummary = [
            `Naukri Job: ${title} at ${company}`,
            postedLabel ? `Posted: ${postedLabel}` : '',
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
            evaluation_reason: reason,
            status: status
          };

          saveJobRecord(jobRecord);
          if (status === 'scanned') {
            scrapedJobs.push(jobRecord as JobRecord);
            savedCount++;
            console.log(`✨ [Direct Easy Apply Found]: "${title}" (${expText || '2-3 Yrs'}, ${postedLabel || 'Recent'}) at ${company}`);
          } else if (isStale) {
            console.log(`⏩ [Stale Job Skipped]: "${title}" (${postedLabel}) at ${company}`);
          } else if (isOverExperienced || isSeniorTitle) {
            console.log(`⏩ [Senior/Experience Mismatch Skipped]: "${title}" (${expText}) at ${company}`);
          } else if (isExternal) {
            externalCount++;
          } else if (isBlacklisted) {
            console.log(`🚫 [Blacklisted Company Skipped]: "${title}" at ${company}`);
          }
        } catch {
          // Soft catch
        }
      }

      console.log(`✅ Naukri Page ${pageNum + 1}: ${savedCount} direct Easy Apply jobs queued (${externalCount} external redirects skipped)`);

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
