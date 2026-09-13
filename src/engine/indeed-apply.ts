import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import { exec } from 'child_process';
import { CONFIG, loadProfile } from '../config';
import { updateJobStatus, JobRecord } from '../db/schema';
import { answerQuestionWithGemini } from './gemini';

export interface ApplyOptions {
  autoSubmit?: boolean;
  browserContext?: BrowserContext;
}

export type ApplyResult = 'applied' | 'skipped' | 'already_applied' | 'connection_error' | 'not_logged_in' | 'failed' | 'limit_reached';

/** Plays an audible alert sound for manual intervention */
export function triggerAudioAlert() {
  process.stdout.write('\u0007\u0007\u0007');
  if (process.platform === 'win32') {
    exec('powershell -c "[System.Console]::Beep(1000, 600); [System.Console]::Beep(1500, 600)"', () => null);
  }
}

/** Random delay between minMs and maxMs to simulate human think-time */
async function humanDelay(page: Page, minMs = 1500, maxMs = 4000) {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  await page.waitForTimeout(delay);
}

/** Simulate a gentle mouse drift across the viewport before clicking */
async function simulateMouseMovement(page: Page) {
  try {
    const vw = page.viewportSize()?.width || 1280;
    const vh = page.viewportSize()?.height || 800;
    const steps = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < steps; i++) {
      await page.mouse.move(
        Math.floor(Math.random() * vw),
        Math.floor(Math.random() * vh),
        { steps: 10 }
      );
      await page.waitForTimeout(100 + Math.floor(Math.random() * 200));
    }
  } catch {
    // soft catch
  }
}

/** Helper to find first visible element from selector list */
async function findVisibleElement(page: Page, selectors: string[], timeoutMs: number = 6000) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    for (const selector of selectors) {
      try {
        const loc = page.locator(selector);
        const count = await loc.count();
        for (let i = 0; i < count; i++) {
          const el = loc.nth(i);
          if (await el.isVisible().catch(() => false)) {
            return el;
          }
        }
      } catch {
        // Continue to next selector
      }
    }
    await page.waitForTimeout(400);
  }
  return null;
}

function sanitizeInputAnswer(labelText: string, rawAnswer: string, inputType: string): string {
  const profile = loadProfile();
  let answer = (rawAnswer || '').trim();
  const lowerLabel = labelText.toLowerCase();

  // 0a. LinkedIn Profile URL
  if (/linkedin/i.test(lowerLabel)) {
    return profile.linkedin || 'https://www.linkedin.com/in/mohammadzuber/';
  }

  // 0b. Website / Portfolio / GitHub URL
  if (/website|portfolio|github|link|url|site/i.test(lowerLabel)) {
    return profile.linkedin || 'https://www.linkedin.com/in/mohammadzuber/';
  }

  // 0c. Date inputs (e.g. "Available Start Date", "Start date", input[type="date"])
  if (inputType === 'date' || (/start date|available date|date/i.test(lowerLabel) && !/notice|period|ctc|salary|experience/i.test(lowerLabel))) {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  // 0d. Combined Current CTC and Expected CTC in one question (e.g. "What is your CTC and ECTC ?")
  if ((lowerLabel.includes('ctc') || lowerLabel.includes('salary') || lowerLabel.includes('compensation')) && (lowerLabel.includes('ectc') || (lowerLabel.includes('current') && lowerLabel.includes('expect')))) {
    return `Current CTC: ${profile.currentCtcLpa} LPA, Expected CTC: ${profile.expectedCtcLpa} LPA`;
  }

  // 0e. Skills candidate DOES NOT HAVE (PHP, Laravel, Python, Java, C#, .NET, Flutter, Ruby, Go, AWS, Docker)
  if (/php|laravel|python|ruby|golang|\bc\+\+|\bc#|\bnet\b|\bdotnet\b|flutter|swift|kotlin|django|flask|rails|kubernetes|docker|devops/i.test(lowerLabel) && !/javascript|typescript|angular|node|html|css|rxjs|sql|git|ui|frontend|web/i.test(lowerLabel)) {
    if (/experience|years|yoe|have/i.test(lowerLabel)) {
      return '0';
    }
  }

  // 0f. Core skills candidate HAS (Node.js, Angular, TypeScript, Frontend, Fullstack)
  if (/node|express|mongo|backend|full\s*stack|fullstack/i.test(lowerLabel) && /experience|years|yoe|have/i.test(lowerLabel)) {
    return '2';
  }
  if (/angular|typescript|rxjs|javascript|html|css|frontend|ui|web/i.test(lowerLabel) && /experience|years|yoe|have/i.test(lowerLabel)) {
    return '2.5';
  }

  // 1. Notice period / Lead time / joining days
  if (/notice|lead time|join|days|joining/i.test(lowerLabel) && !/salary|ctc|compensation/i.test(lowerLabel)) {
    if (inputType === 'textarea' || /explain|describe|text/i.test(lowerLabel)) {
      return '1 day';
    }
    return (profile.noticePeriodDays || 1).toString();
  }

  // 2. Current Compensation / Salary
  if (/current/i.test(lowerLabel) && /compensation|salary|ctc|inr|package/i.test(lowerLabel)) {
    if (/lpa|lakh/i.test(lowerLabel)) {
      return (profile.currentCtcLpa || 3.2).toString();
    }
    return Math.round((profile.currentCtcLpa || 3.2) * 100000).toString();
  }

  // 3. Expected Compensation / Salary Expectations
  if ((/expect/i.test(lowerLabel) || /desire/i.test(lowerLabel)) && /compensation|salary|ctc|inr|package|expectation/i.test(lowerLabel)) {
    if (/lpa|lakh/i.test(lowerLabel)) {
      return (profile.expectedCtcLpa || 6.5).toString();
    }
    return Math.round((profile.expectedCtcLpa || 6.5) * 100000).toString();
  }

  // 4. Generic Numeric fields (YOE, Phone, etc.)
  const isNumericField = inputType === 'number' ||
    /period|day|year|experience|ctc|salary|compensation|package|phone|mobile/i.test(lowerLabel);

  if (isNumericField) {
    const digitsOnly = answer.replace(/[^\d.]/g, '');
    if (digitsOnly && digitsOnly !== '0') {
      answer = digitsOnly;
    } else if (/experience|yoe/i.test(lowerLabel)) {
      answer = (profile.totalYoe || 2.5).toString();
    }
  }

  return answer;
}

// ── Main Indeed Apply Function ──────────────────────────────────────────────────

export async function applyIndeedJob(job: JobRecord, options: ApplyOptions = { autoSubmit: false }): Promise<ApplyResult> {
  const profile = loadProfile();
  const blacklisted = profile.blacklistedCompanies || [];

  const titleLower = job.title.toLowerCase();
  const isForbiddenTech = /(^|\W)(java|spring|springboot|hibernate|j2ee|react|reactjs|react\.js|react-native|\.?net|dotnet|c#|asp\.net|python|django|flask|fastapi|php|laravel|codeigniter|wordpress|ruby|rails|golang|c\+\+|embedded|full\s*stack|fullstack|mean\s*stack|mern\s*stack|backend|back-end|qa|testing|tester|test engineer|devops|cloud|salesforce|servicenow|sharepoint|android|ios|flutter|data engineer|data scientist|musician|annotation|mentor|sales|recruiter)(\W|$)/i.test(titleLower);

  const isAngularRole = /(^|\W)(angular|angularjs|ionic)(\W|$)/i.test(titleLower) ||
    (/(^|\W)(frontend|front-end|ui)\s*(developer|engineer|consultant|specialist|programmer|web developer)(\W|$)/i.test(titleLower) && !isForbiddenTech);

  if (isForbiddenTech || !isAngularRole) {
    console.log(`⏩ [Non-Angular Role Skipped]: "${job.title}" at ${job.company} is not a pure Angular role. Skipping.`);
    updateJobStatus(job.external_job_id, 'skipped');
    return 'skipped';
  }

  console.log(`\n🚀 [Indeed Apply] Target Job: "${job.title}" at ${job.company}`);
  console.log(`🔗 Job URL: ${job.url}`);

  let browserContext: BrowserContext | null = null;
  let page: Page | null = null;
  let activePage: Page | null = null;

  try {
    if (options.browserContext) {
      browserContext = options.browserContext;
      const pages = browserContext.pages();
      const nonBlankPage = pages.find(p => p.url() !== 'about:blank' && !p.url().startsWith('chrome:'));
      page = nonBlankPage || (pages.length > 0 ? pages[0] : await browserContext.newPage());
      await page.bringToFront().catch(() => null);
    } else {
      // Connect to active Chrome session via CDP
      try {
        console.log(`🔌 Connecting to active Chrome session on CDP port ${CONFIG.cdpPort}...`);
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CONFIG.cdpPort}`);
        browserContext = browser.contexts()[0] || await browser.newContext();
        
        const pages = browserContext.pages();
        const nonBlankPage = pages.find(p => p.url() !== 'about:blank' && !p.url().startsWith('chrome:'));
        page = nonBlankPage || (pages.length > 0 ? pages[0] : await browserContext.newPage());

        for (const p of pages) {
          if (p !== page && (p.url() === 'about:blank' || p.url() === 'chrome://newtab/')) {
            await p.close().catch(() => null);
          }
        }

        console.log(`✅ Connected to active Chrome tab!`);
        await page.bringToFront().catch(() => null);
      } catch (cdpErr: any) {
        console.log(`⚠️ Chrome CDP port ${CONFIG.cdpPort} connection failed (${cdpErr.message}).`);
        console.log(`💡 Tip: Run "npx ts-node src/index.ts launch-chrome" to open your logged-in Chrome session.`);
        return 'connection_error';
      }
    }

    console.log(`🌐 Navigating to Indeed job page: ${job.url}`);
    try {
      await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch (navErr: any) {
      console.log(`⚠️ Navigation to ${job.url} failed (${navErr.message}). Skipping.`);
      updateJobStatus(job.external_job_id, 'skipped');
      return 'skipped';
    }

    await simulateMouseMovement(page);
    await humanDelay(page, 2000, 4000);

    // Check if already applied
    const alreadyApplied = await findVisibleElement(page, [
      'span:has-text("Applied")',
      'button:has-text("Applied")',
      'div:has-text("Applied on Indeed")',
      'div[class*="alreadyApplied"]'
    ], 2000);

    if (alreadyApplied) {
      console.log(`ℹ️ Job "${job.title}" at ${job.company} is already applied on Indeed.`);
      updateJobStatus(job.external_job_id, 'applied');
      return 'already_applied';
    }

    // Locate visible "Easily apply" or "Apply now" button on Indeed
    const applySelectors = [
      'button#indeedApplyButton',
      'button[id*="indeedApply"]',
      'button:has-text("Apply now")',
      'button:has-text("Easily apply")',
      'span:has-text("Easily apply")',
      'button[aria-label*="Apply"]'
    ];

    const applyBtn = await findVisibleElement(page, applySelectors, 6000);
    if (!applyBtn) {
      console.log(`⏩ "Easily apply" button not found on Indeed page (likely external site application). Skipping.`);
      updateJobStatus(job.external_job_id, 'skipped');
      return 'skipped';
    }

    // Human pre-click pause
    await simulateMouseMovement(page);
    await humanDelay(page, 800, 1500);

    let activePage: Page = page;
    const popupPromise = browserContext ? browserContext.waitForEvent('page', { timeout: 5000 }).catch(() => null) : Promise.resolve(null);

    console.log(`👆 Clicking Indeed Easily Apply button...`);
    try {
      await applyBtn.click();
    } catch {
      await applyBtn.click({ force: true }).catch(() => null);
    }

    const newPopup = await popupPromise;
    if (newPopup) {
      activePage = newPopup;
      await activePage.bringToFront().catch(() => null);
      console.log(`🌐 Switched to Indeed SmartApply tab: ${activePage.url()}`);
    } else {
      await page.waitForTimeout(3000);
      if (page.url().includes('smartapply') || page.url().includes('indeedapply')) {
        console.log(`🌐 Indeed page navigated to SmartApply flow: ${page.url()}`);
      }
    }

    // Filter out external career site redirects
    if (!activePage.url().includes('indeed.com') && !activePage.url().includes('indeedapply')) {
      console.log(`⏩ External site redirect ("${activePage.url()}"). Skipping.`);
      updateJobStatus(job.external_job_id, 'skipped');
      return 'skipped';
    }

    await humanDelay(activePage, 2500, 4000);

    // Multi-step form loop (max 10 steps for SmartApply)
    for (let step = 1; step <= 10; step++) {
      await activePage.waitForTimeout(1000);

      // Check if iframe exists inside activePage
      const iframeElement = activePage.frameLocator('iframe[id*="indeed-apply-iframe"], iframe[title*="Indeed Apply"]').first();
      let frameOrPage: any = activePage;
      if (await activePage.locator('iframe[id*="indeed-apply-iframe"], iframe[title*="Indeed Apply"]').first().isVisible().catch(() => false)) {
        frameOrPage = iframeElement;
      }

      const submitBtn = await findVisibleElement(frameOrPage, [
        'button:has-text("Submit your application")',
        'button:has-text("Submit application")',
        'button:has-text("Submit")',
        'button[class*="submit"]',
        'button[class*="Submit"]'
      ], 1500);

      const continueBtn = await findVisibleElement(frameOrPage, [
        'button:has-text("Continue")',
        'button:has-text("Next")',
        'button:has-text("Review your application")',
        'button[data-testid="continue-button"]',
        'button[class*="continueButton"]',
        'button[class*="ContinueButton"]',
        'button[class*="ia-ContinueButton"]',
        'button[class*="ia-continueButton"]',
        'footer button',
        'div[data-testid="footer"] button',
        'button[type="submit"]'
      ], 4000);

      // Step A: Fill text / number inputs
      try {
        const inputs = frameOrPage.locator('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea');
        const inputCount = await inputs.count();

        for (let j = 0; j < inputCount; j++) {
          const input = inputs.nth(j);
          if (await input.isVisible().catch(() => false)) {
            const val = await input.inputValue().catch(() => '');
            if (!val || val.trim() === '') {
              let labelText = '';
              const parentBlock = input.locator('xpath=ancestor::div[contains(@class, "ia-") or contains(@class, "form") or contains(@class, "field") or contains(@class, "group") or contains(@class, "styles")]').first();
              if (await parentBlock.count() > 0) {
                labelText = (await parentBlock.locator('label, legend, span, h1, h2, h3, p').first().textContent().catch(() => '')) || '';
              }
              if (!labelText) {
                labelText = (await input.getAttribute('aria-label').catch(() => '')) ||
                            (await input.getAttribute('placeholder').catch(() => '')) || 'Years of experience';
              }
              labelText = labelText.replace(/\*/g, '').replace(/\s+/g, ' ').trim();

              console.log(`❓ Indeed Question [Step ${step}]: "${labelText}"`);
              let aiAnswer = await answerQuestionWithGemini(labelText, job.title);
              const inputType = (await input.getAttribute('type').catch(() => '')) || '';
              aiAnswer = sanitizeInputAnswer(labelText, aiAnswer, inputType);

              await input.focus().catch(() => null);
              await input.fill('').catch(() => null);
              await input.pressSequentially(aiAnswer, { delay: 40 }).catch(() => null);
              await activePage.waitForTimeout(300);
            }
          }
        }
      } catch {
        // Soft catch
      }

      // Step B: Choice / Radio / Checkbox / Dropdown Selection
      try {
        // B1: Resume selection card
        const resumeCards = frameOrPage.locator('div[class*="resume"], label[class*="resume"], div[class*="Resume"]');
        if (await resumeCards.count() > 0) {
          const firstCard = resumeCards.first();
          if (await firstCard.isVisible().catch(() => false)) {
            await firstCard.click().catch(() => null);
            await activePage.waitForTimeout(300);
          }
        }

        // B2: Radio buttons (smart choice matching with Gemini AI & candidate experience)
        const radioGroups = frameOrPage.locator('fieldset, div[role="radiogroup"], div[class*="ia-Radio"]');
        const rgCount = await radioGroups.count();

        if (rgCount > 0) {
          for (let rg = 0; rg < rgCount; rg++) {
            const group = radioGroups.nth(rg);
            if (await group.isVisible().catch(() => false)) {
              let qText = (await group.locator('legend, label, h3, span').first().textContent().catch(() => '')) || '';
              qText = qText.replace(/\*/g, '').replace(/\s+/g, ' ').trim();

              const radios = group.locator('label, input[type="radio"]');
              const rCount = await radios.count();
              if (rCount > 0) {
                const optLabels: string[] = [];
                for (let r = 0; r < rCount; r++) {
                  const txt = (await radios.nth(r).textContent().catch(() => '')) || '';
                  if (txt.trim()) optLabels.push(txt.trim());
                }

                let aiChoice = await answerQuestionWithGemini(
                  `Question: "${qText}". Choose single best option from: [${optLabels.join(', ')}]. Candidate YOE is 2.5 years (Angular/Frontend), Notice period 1 day.`,
                  job.title
                );
                aiChoice = aiChoice.trim();
                console.log(`💡 Radio Question: "${qText}" ➔ AI Choice: "${aiChoice}"`);

                let clickedRadio = false;
                for (let r = 0; r < rCount; r++) {
                  const radio = radios.nth(r);
                  const txt = (await radio.textContent().catch(() => '')) || '';
                  if (txt && new RegExp(aiChoice, 'i').test(txt)) {
                    await radio.click({ force: true }).catch(() => null);
                    await activePage.waitForTimeout(300);
                    clickedRadio = true;
                    break;
                  }
                }

                if (!clickedRadio) {
                  for (let r = 0; r < rCount; r++) {
                    const radio = radios.nth(r);
                    const txt = (await radio.textContent().catch(() => '')) || '';
                    if (/1-2|2-3|3-4|1 to 2|2 to 3|3 to 4|yes/i.test(txt)) {
                      await radio.click({ force: true }).catch(() => null);
                      await activePage.waitForTimeout(300);
                      break;
                    }
                  }
                }
              }
            }
          }
        } else {
          const radios = frameOrPage.locator('input[type="radio"]');
          if (await radios.count() > 0) {
            for (let r = 0; r < await radios.count(); r++) {
              const radio = radios.nth(r);
              if (await radio.isVisible().catch(() => false)) {
                const labelTxt = (await radio.evaluate((el: any) => el.labels?.[0]?.textContent || el.parentElement?.textContent || '').catch(() => '')) || '';
                if (/1-2|2-3|3-4|1 to 2|2 to 3|3 to 4|yes/i.test(labelTxt) || r === 0) {
                  await radio.click({ force: true }).catch(() => null);
                  await activePage.waitForTimeout(300);
                  break;
                }
              }
            }
          }
        }

        // B3: Checkboxes (e.g. "Agree" / Privacy / Terms / Declaration)
        const checkboxes = frameOrPage.locator('input[type="checkbox"], label:has-text("Agree"), label:has-text("Terms"), label:has-text("Privacy")');
        const cbCount = await checkboxes.count();
        for (let c = 0; c < cbCount; c++) {
          const cb = checkboxes.nth(c);
          if (await cb.isVisible().catch(() => false)) {
            const isChecked = await cb.isChecked().catch(() => false);
            if (!isChecked) {
              console.log(`☑️ Checking agreement checkbox...`);
              await cb.click({ force: true }).catch(() => null);
              await activePage.waitForTimeout(300);
            }
          }
        }

        // B4: Select Dropdowns & Comboboxes (e.g. "In which city would you prefer to work?")
        const selects = frameOrPage.locator('select, div[role="combobox"]');
        const selectCount = await selects.count();
        for (let s = 0; s < selectCount; s++) {
          const sel = selects.nth(s);
          if (await sel.isVisible().catch(() => false)) {
            const tagName = await sel.evaluate((el: any) => el.tagName.toLowerCase()).catch(() => '');
            if (tagName === 'select') {
              const options = sel.locator('option');
              const optCount = await options.count();
              if (optCount > 1) {
                let selectVal = '';
                for (let o = 1; o < optCount; o++) {
                  const optText = (await options.nth(o).textContent().catch(() => '')) || '';
                  if (/remote|indore|india|pune|bangalore|hyderabad|chennai|any|yes/i.test(optText)) {
                    selectVal = await options.nth(o).getAttribute('value').catch(() => '') || optText;
                    break;
                  }
                }
                if (!selectVal && optCount > 1) {
                  selectVal = await options.nth(1).getAttribute('value').catch(() => '') || '1';
                }
                if (selectVal) {
                  console.log(`🔽 Selecting dropdown option: "${selectVal}"`);
                  await sel.selectOption(selectVal).catch(() => null);
                  await activePage.waitForTimeout(400);
                }
              }
            } else {
              await sel.click().catch(() => null);
              await activePage.waitForTimeout(400);
              const firstOpt = activePage.locator('li[role="option"], div[role="option"], div[class*="option"]').first();
              if (await firstOpt.isVisible().catch(() => false)) {
                await firstOpt.click().catch(() => null);
                await activePage.waitForTimeout(400);
              }
            }
          }
        }
      } catch {
        // Soft catch
      }

      // Step C: Check Submit button
      if (submitBtn) {
        console.log(`📌 Reached final Review & Submit step on Indeed!`);

        await simulateMouseMovement(activePage);
        await humanDelay(activePage, 800, 1500);

        await submitBtn.click();
        await activePage.waitForTimeout(3000);

        console.log(`🎉 [Indeed Apply Success] Application submitted for "${job.title}" at ${job.company}!`);
        updateJobStatus(job.external_job_id, 'applied');
        return 'applied';
      }

      // Step D: Click Continue / Next button
      let clickedContinue = false;
      if (continueBtn) {
        console.log(`➡️ Step ${step}: Proceeding to next step...`);
        await humanDelay(activePage, 500, 1200);
        await continueBtn.click();
        await humanDelay(activePage, 2000, 4000);
        clickedContinue = true;
      } else {
        const anyPrimaryBtn = activePage.locator('button[type="submit"], button[class*="primary"], button[class*="button"]').filter({ hasText: /continue|next|review|submit/i }).first();
        if (await anyPrimaryBtn.isVisible().catch(() => false)) {
          console.log(`➡️ Step ${step}: Clicking primary button...`);
          await anyPrimaryBtn.click();
          await humanDelay(activePage, 2000, 4000);
          clickedContinue = true;
        }
      }

      // Step E: Form validation error check
      const errorMsg = frameOrPage.locator('div[id*="error"], span[id*="error"], p[class*="error"], div[class*="error"], span[class*="error"], div[role="alert"], p:has-text("Choose an option"), div:has-text("Choose an option"), span:has-text("required")').first();
      if (await errorMsg.isVisible().catch(() => false)) {
        const errText = (await errorMsg.textContent().catch(() => ''))?.trim() || 'Validation error';
        console.log(`⚠️ Indeed form validation error: "${errText}". Re-solving with Gemini AI...`);

        // Re-check checkboxes
        const checkboxes = frameOrPage.locator('input[type="checkbox"], label:has-text("Agree"), label:has-text("Terms")');
        const cbCount = await checkboxes.count();
        for (let c = 0; c < cbCount; c++) {
          const cb = checkboxes.nth(c);
          if (await cb.isVisible().catch(() => false)) {
            await cb.click({ force: true }).catch(() => null);
          }
        }

        const inputsToFix = frameOrPage.locator('input:not([type="hidden"]), textarea');
        const countToFix = await inputsToFix.count();
        for (let f = 0; f < countToFix; f++) {
          const inp = inputsToFix.nth(f);
          if (await inp.isVisible().catch(() => false)) {
            let label = (await inp.getAttribute('aria-label').catch(() => '')) || 'Years of experience';
            let fixedAnswer = await answerQuestionWithGemini(label, job.title, errText);
            fixedAnswer = sanitizeInputAnswer(label, fixedAnswer, '');

            await inp.focus().catch(() => null);
            await inp.fill('').catch(() => null);
            await inp.pressSequentially(fixedAnswer, { delay: 40 }).catch(() => null);
            await activePage.waitForTimeout(400);
          }
        }

        const retryBtn = continueBtn || submitBtn;
        if (retryBtn) {
          await retryBtn.click().catch(() => null);
          await humanDelay(activePage, 1500, 2500);
        }

        if (await errorMsg.isVisible().catch(() => false)) {
          console.log(`\n🔔 🔊 [MANUAL INTERVENTION NEEDED] Indeed validation error could not be auto-resolved. Playing audio alert...`);
          triggerAudioAlert();
          console.log(`⏳ Pausing 15 seconds for manual correction on active Chrome tab...`);
          await activePage.waitForTimeout(15000);
        }
      }

      if (!clickedContinue && !submitBtn) {
        const successMsg = activePage.locator('div:has-text("Your application has been submitted"), div:has-text("Application submitted"), h1:has-text("Application submitted")').first();
        if (await successMsg.isVisible().catch(() => false)) {
          console.log(`🎉 [Indeed Apply Success] Application submitted for "${job.title}" at ${job.company}!`);
          updateJobStatus(job.external_job_id, 'applied');
          return 'applied';
        }
        break;
      }
    }

    console.log(`⚠️ Indeed form did not complete submission. Marking as failed for retry.`);
    updateJobStatus(job.external_job_id, 'failed');
    return 'failed';

  } catch (err: any) {
    console.error(`❌ [Indeed Apply Error]: ${err.message}`);
    const msg = (err.message || '').toLowerCase();
    const isConnError = msg.includes('net::err_connection') ||
                        msg.includes('target closed') ||
                        msg.includes('context closed') ||
                        msg.includes('browser has been closed') ||
                        msg.includes('cdp port') ||
                        msg.includes('econnrefused');

    if (isConnError) {
      console.log(`🛑 Chrome CDP/Browser connection issue detected. Returning connection_error.`);
      return 'connection_error';
    }

    updateJobStatus(job.external_job_id, 'failed');
    return 'failed';
  } finally {
    if (activePage && activePage !== page) {
      await activePage.close().catch(() => null);
    }
    if (page && !options.browserContext) {
      await page.close().catch(() => null);
    }
  }
}
