import { chromium, BrowserContext, Page } from 'playwright';
import inquirer from 'inquirer';
import path from 'path';
import fs from 'fs';
import { CONFIG, loadProfile } from '../config';
import { updateJobStatus, JobRecord } from '../db/schema';
import { answerQuestionWithGemini } from './gemini';

export interface ApplyOptions {
  autoSubmit?: boolean;
}

// ── Humanize helpers ──────────────────────────────────────────────────────────

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

/** Simulate a short scroll on the page to appear human */
async function simulateScroll(page: Page) {
  try {
    const scrollAmount = 200 + Math.floor(Math.random() * 300);
    await page.mouse.wheel(0, scrollAmount);
    await page.waitForTimeout(400 + Math.floor(Math.random() * 400));
    await page.mouse.wheel(0, -scrollAmount / 2);
    await page.waitForTimeout(300);
  } catch {
    // soft catch
  }
}

// ── Visibility helper ─────────────────────────────────────────────────────────

async function findVisibleElement(page: Page, selectors: string[], timeoutMs: number = 8000) {
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
    await page.waitForTimeout(500);
  }
  return null;
}

function sanitizeInputAnswer(labelText: string, rawAnswer: string, inputType: string): string {
  let answer = (rawAnswer || '').trim();

  // Check if this field requires pure numeric input (numbers only)
  const isNumericField = inputType === 'number' ||
    /notice|period|day|year|experience|ctc|salary|compensation|package|phone|mobile/i.test(labelText);

  if (isNumericField) {
    // Strip out all non-digit characters e.g. "1 day" -> "1", "15 days" -> "15", "2.5" -> "2"
    const digitsOnly = answer.replace(/[^\d]/g, '');
    if (digitsOnly) {
      answer = digitsOnly;
    }
  }

  return answer;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type ApplyResult = 'applied' | 'skipped' | 'already_applied' | 'connection_error' | 'not_logged_in' | 'failed' | 'limit_reached';

// ── PDF Resume Upload ─────────────────────────────────────────────────────────

async function tryUploadResume(page: Page, modal: any, profile: ReturnType<typeof loadProfile>) {
  try {
    const resumeDir = path.resolve(process.cwd());
    const candidatePdfPaths = [
      // 1. Explicit resumeUploadPath from profile.yml (highest priority)
      profile.resumeUploadPath ? path.resolve(profile.resumeUploadPath) : '',
      // 2. Standard names in project root
      path.join(resumeDir, 'resume.pdf'),
      path.join(resumeDir, 'cv.pdf'),
      path.join(resumeDir, 'Mohammad_Zuber_Resume.pdf'),
    ].filter(Boolean);

    const pdfPath = candidatePdfPaths.find(p => fs.existsSync(p));
    if (!pdfPath) {
      console.log(`📎 No PDF resume found at ${candidatePdfPaths[0] || './resume.pdf'} — skipping resume upload.`);
      return;
    }

    // Find visible file input for resume upload
    const fileInput = modal.locator('input[type="file"]').first();
    if (await fileInput.count() > 0) {
      await fileInput.setInputFiles(pdfPath).catch(() => null);
      await page.waitForTimeout(1500);
      console.log(`📎 Resume uploaded: ${path.basename(pdfPath)}`);
    }
  } catch {
    // soft catch
  }
}

// ── Cover Letter / Additional Info ────────────────────────────────────────────

async function fillCoverLetterFields(page: Page, modal: any, job: JobRecord) {
  try {
    const coverLetterSelectors = [
      'textarea[id*="coverletter"]',
      'textarea[id*="cover-letter"]',
      'textarea[placeholder*="cover letter" i]',
      'textarea[aria-label*="cover letter" i]',
      'textarea[aria-label*="additional" i]',
      'textarea[aria-label*="message" i]',
      'textarea[aria-label*="hiring" i]',
    ];

    for (const sel of coverLetterSelectors) {
      const ta = modal.locator(sel).first();
      if (await ta.isVisible().catch(() => false)) {
        const existing = await ta.inputValue().catch(() => '');
        if (!existing || existing.trim().length < 10) {
          const profile = loadProfile();
          const coverLetter = await answerQuestionWithGemini(
            `Write a concise 3-sentence cover letter for "${job.title}" at "${job.company}" for a frontend developer with 2 years of Angular experience`,
            job.title
          );
          await ta.focus();
          await ta.fill('');
          await ta.pressSequentially(coverLetter.slice(0, 1000), { delay: 20 });
          await page.waitForTimeout(300);
          console.log(`✍️ Cover letter filled for "${job.title}"`);
        }
        break;
      }
    }
  } catch {
    // soft catch
  }
}

// ── Main Apply Function ───────────────────────────────────────────────────────

export async function applyLinkedInJob(job: JobRecord, options: ApplyOptions = { autoSubmit: false }): Promise<ApplyResult> {
  const profile = loadProfile();
  const blacklisted = profile.blacklistedCompanies || [];
  if (blacklisted.some(b => job.company.toLowerCase().includes(b.toLowerCase()))) {
    console.log(`🚫 [Blacklisted Company Skipped] Job "${job.title}" at "${job.company}" is blacklisted.`);
    updateJobStatus(job.external_job_id, 'skipped');
    return 'skipped';
  }

  console.log(`\n🚀 [LinkedIn Apply] Target Job: "${job.title}" at ${job.company}`);
  console.log(`🔗 Job URL: ${job.url}`);

  let browserContext: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    // Connect to existing logged-in Chrome session via CDP
    try {
      console.log(`🔌 Connecting to active Chrome session on CDP port ${CONFIG.cdpPort}...`);
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CONFIG.cdpPort}`);
      browserContext = browser.contexts()[0] || await browser.newContext();
      page = await browserContext.newPage();
      console.log(`✅ Connected to active Chrome session!`);
      await page.bringToFront().catch(() => null);
    } catch (cdpErr) {
      console.log(`🌐 CDP session not detected. Launching persistent visible browser window for auto-apply...`);
      const userDataDir = path.resolve(process.cwd(), '.chrome-user-data');
      browserContext = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--start-maximized'],
        viewport: null
      });
      page = browserContext.pages()[0] || await browserContext.newPage();
    }

    // Extract numeric job ID if present
    const jobIdMatch = job.url.match(/(\d{8,12})/);
    const rawJobId = jobIdMatch ? jobIdMatch[1] : null;

    const targetUrl = rawJobId
      ? `https://www.linkedin.com/jobs/view/${rawJobId}/`
      : job.url;

    console.log(`🌐 Navigating to LinkedIn job page: ${targetUrl}`);
    let navOk = false;
    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 12000 });
      navOk = true;
    } catch (navErr: any) {
      console.log(`⚠️ Direct job view navigation failed (${navErr.message || 'Timeout/Network error'}).`);
      if (rawJobId) {
        const searchViewUrl = `https://www.linkedin.com/jobs/search/?currentJobId=${rawJobId}`;
        console.log(`🔄 Retrying via LinkedIn Search View URL: ${searchViewUrl}`);
        try {
          await page.goto(searchViewUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
          navOk = true;
        } catch (retryErr: any) {
          console.log(`⏩ Search View fallback navigation also failed. Marking job as skipped.`);
          updateJobStatus(job.external_job_id, 'skipped');
          return 'skipped';
        }
      } else {
        updateJobStatus(job.external_job_id, 'skipped');
        return 'skipped';
      }
    }

    // 🕐 Human-like random read pause after page load
    await simulateMouseMovement(page);
    await simulateScroll(page);
    await humanDelay(page, 2000, 4500);

    // Check auth status
    const loginBtn = await findVisibleElement(page, ['a.nav__button-secondary:has-text("Sign in")', 'button:has-text("Sign in")', 'a[href*="login"]'], 1500);
    if (loginBtn) {
      console.log(`⚠️ LinkedIn is not logged in inside the active Chrome window.`);
      console.log(`👉 Please make sure Chrome (launched via launch-chrome) is logged into https://linkedin.com`);
      return 'not_logged_in';
    }

    // Check for LinkedIn Daily Limit warning (pre-click)
    const pageLimitText = page.locator('*:has-text("daily application limit"), *:has-text("reached your daily"), *:has-text("reached today"), *:has-text("limit for today")').first();
    if (await pageLimitText.isVisible().catch(() => false)) {
      console.log(`🛑 [LinkedIn Daily Limit Reached] You have reached LinkedIn's maximum daily Easy Apply limit for today!`);
      return 'limit_reached';
    }

    // Check if already applied
    const alreadyApplied = await findVisibleElement(page, ['span:has-text("Applied")', 'button:has-text("Applied")', '.jobs-s-apply span:has-text("Applied")', '.jobs-post-apply-text'], 1500);
    if (alreadyApplied) {
      console.log(`ℹ️ Job "${job.title}" at ${job.company} is already applied on LinkedIn.`);
      updateJobStatus(job.external_job_id, 'applied');
      return 'already_applied';
    }

    // Strictly locate visible "Easy Apply" button
    const easyApplySelectors = [
      'button:has-text("Easy Apply")',
      'a:has-text("Easy Apply")',
      'button[aria-label*="Easy Apply"]',
      'button.jobs-apply-button:has-text("Easy Apply")',
      '.jobs-s-apply button',
      'div.jobs-apply-button--top-card button',
      'span.artdeco-button__text:has-text("Easy Apply")'
    ];

    let easyApplyBtn = await findVisibleElement(page, easyApplySelectors, 6000);

    if (!easyApplyBtn && rawJobId) {
      const searchViewUrl = `https://www.linkedin.com/jobs/search/?currentJobId=${rawJobId}`;
      console.log(`🔄 Retrying with search view URL: ${searchViewUrl}`);
      await page.goto(searchViewUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await humanDelay(page, 2000, 3500);
      easyApplyBtn = await findVisibleElement(page, easyApplySelectors, 6000);
    }

    if (!easyApplyBtn) {
      console.log(`⏩ "Easy Apply" button not visible (likely an external site apply position). Skipping.`);
      updateJobStatus(job.external_job_id, 'skipped');
      return 'skipped';
    }

    // Human-like pre-click behaviour
    await simulateMouseMovement(page);
    await humanDelay(page, 800, 1800);

    console.log(`👆 Opening Easy Apply modal dialog...`);
    try {
      await easyApplyBtn.click();
    } catch {
      await easyApplyBtn.click({ force: true }).catch(() => null);
    }

    // Human read pause after modal opens
    await humanDelay(page, 1500, 3000);

    // Check daily limit toast/banner after click
    const clickLimitText = page.locator('*:has-text("daily application limit"), *:has-text("reached your daily"), *:has-text("reached today"), *:has-text("limit for today")').first();
    if (await clickLimitText.isVisible().catch(() => false)) {
      console.log(`🛑 [LinkedIn Daily Limit Reached] You have reached LinkedIn's maximum daily Easy Apply limit for today!`);
      return 'limit_reached';
    }

    // Verify modal dialog actually opened
    const modal = await findVisibleElement(page, ['div[role="dialog"]', 'div.artdeco-modal', 'div.jobs-easy-apply-content'], 6000);

    if (!modal) {
      console.log(`⚠️ Easy Apply modal dialog did not open after click. Skipping.`);
      updateJobStatus(job.external_job_id, 'skipped');
      return 'skipped';
    }

    // Multi-step modal loop (Max 6 steps)
    for (let step = 1; step <= 6; step++) {
      const activeModal = page.locator('div[role="dialog"], div.artdeco-modal, div.jobs-easy-apply-content').first();

      const nextBtn = page.locator('button:has-text("Next"), button:has-text("Review")').first();
      const submitBtn = page.locator('button:has-text("Submit application")').first();

      // Step A: Fill ALL text, numeric, and textarea inputs inside modal with real keypresses
      try {
        const textInputs = activeModal.locator('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea');
        const inputCount = await textInputs.count();

        for (let j = 0; j < inputCount; j++) {
          const input = textInputs.nth(j);
          const currentVal = await input.inputValue().catch(() => '');

          if (!currentVal || currentVal.trim() === '') {
            // Find question label text from parent container
            let labelText = '';
            const parentBlock = input.locator('xpath=ancestor::div[contains(@class, "fb-") or contains(@class, "form") or contains(@class, "group")]').first();

            if (await parentBlock.count() > 0) {
              labelText = (await parentBlock.locator('label, legend, span[aria-hidden="true"]').first().textContent().catch(() => '')) || '';
            }

            if (!labelText) {
              labelText = (await input.getAttribute('aria-label').catch(() => '')) ||
                          (await input.getAttribute('name').catch(() => '')) ||
                          'Years of experience';
            }

            // Clean label text
            labelText = labelText.replace(/\*/g, '').replace(/\s+/g, ' ').trim();

            console.log(`❓ Question: "${labelText}"`);
            let aiAnswer = await answerQuestionWithGemini(labelText, job.title);

            const inputType = (await input.getAttribute('type').catch(() => '')) || '';
            aiAnswer = sanitizeInputAnswer(labelText, aiAnswer, inputType);

            console.log(`💡 Answer: "${aiAnswer}"`);

            const isLocationInput = labelText.toLowerCase().includes('location') ||
                                    labelText.toLowerCase().includes('city') ||
                                    ((await input.getAttribute('id').catch(() => '')) || '').includes('city');

            // Human-like typing with variable delay
            await input.focus();
            await input.fill('');
            await humanDelay(page, 100, 400);
            await input.pressSequentially(aiAnswer, { delay: 40 + Math.floor(Math.random() * 40) });
            await page.waitForTimeout(500);

            if (isLocationInput) {
              const typeaheadHit = page.locator('li[role="option"], div[role="option"], div.basic-typeahead__results li, .search-typeahead-v2__hit').first();
              if (await typeaheadHit.isVisible().catch(() => false)) {
                await typeaheadHit.click().catch(() => null);
              } else {
                await input.press('ArrowDown').catch(() => null);
                await page.waitForTimeout(200);
                await input.press('Enter').catch(() => null);
              }
              await page.waitForTimeout(300);
            } else {
              await input.dispatchEvent('input');
              await input.dispatchEvent('change');
              await input.dispatchEvent('blur');
              await input.press('Tab');
              await humanDelay(page, 100, 300);
            }
          }
        }
      } catch (aiErr: any) {
        console.error(`⚠️ Input resolution note:`, aiErr.message);
      }

      // Step A2: Cover Letter / Additional Info fields
      await fillCoverLetterFields(page, activeModal, job);

      // Step B: Resolve Standard HTML Select Dropdowns
      try {
        const selects = activeModal.locator('select');
        const selCount = await selects.count();

        for (let s = 0; s < selCount; s++) {
          const sel = selects.nth(s);
          const val = await sel.inputValue().catch(() => '');

          if (!val || val === 'Select an option' || val === '') {
            let labelText = '';
            const parentBlock = sel.locator('xpath=ancestor::div[contains(@class, "fb-") or contains(@class, "form") or contains(@class, "group")]').first();
            if (await parentBlock.count() > 0) {
              labelText = (await parentBlock.locator('label, legend').first().textContent().catch(() => '')) || '';
            }
            labelText = labelText.replace(/\*/g, '').replace(/\s+/g, ' ').trim();

            const aiAnswer = await answerQuestionWithGemini(labelText, job.title);

            const options = await sel.locator('option').allInnerTexts().catch(() => []);
            let matchIndex = 1;
            for (let idx = 0; idx < options.length; idx++) {
              if (options[idx].toLowerCase().includes(aiAnswer.toLowerCase())) {
                matchIndex = idx;
                break;
              }
            }

            await sel.selectOption({ index: matchIndex }).catch(() => null);
            await sel.dispatchEvent('change');
            await sel.dispatchEvent('blur');
            await humanDelay(page, 100, 300);
          }
        }
      } catch (selErr) {
        // Soft catch
      }

      // Step C: Resolve Custom ARIA Dropdowns / Comboboxes
      try {
        const comboTriggers = activeModal.locator('div[role="combobox"], button[aria-label*="Select"], div.fb-dropdown button');
        const comboCount = await comboTriggers.count();

        for (let cb = 0; cb < comboCount; cb++) {
          const box = comboTriggers.nth(cb);
          const boxText = (await box.textContent().catch(() => '')) || '';

          if (boxText.includes('Select an option') || boxText.trim() === '') {
            await box.click().catch(() => null);
            await page.waitForTimeout(400);

            const optionItem = page.locator('li[role="option"], div[role="option"], ul.artdeco-dropdown__content li').filter({ hasText: /^[0-9]/ }).first();
            if (await optionItem.isVisible().catch(() => false)) {
              await optionItem.click().catch(() => null);
              await page.waitForTimeout(300);
            }
          }
        }
      } catch (comboErr) {
        // Soft catch
      }

      // Step D: Resolve Radio Questions with smart fallbacks
      try {
        const fieldsets = activeModal.locator('fieldset, div.fb-radio, div.fb-form-element, div[role="radiogroup"]');
        const fsCount = await fieldsets.count();

        for (let f = 0; f < fsCount; f++) {
          const fs = fieldsets.nth(f);

          const checkedRadio = fs.locator('input[type="radio"]:checked');
          if (await checkedRadio.count() > 0) continue;

          const yesOption = fs.locator('label:has-text("Yes"), input[value="Yes"], span:has-text("Yes")').first();

          if (await yesOption.isVisible().catch(() => false)) {
            await yesOption.click().catch(() => null);
            await page.waitForTimeout(300);
          } else {
            const firstRadioLabel = fs.locator('label, input[type="radio"]').first();
            if (await firstRadioLabel.isVisible().catch(() => false)) {
              await firstRadioLabel.click().catch(() => null);
              await page.waitForTimeout(300);
            }
          }
        }
      } catch (radioErr) {
        // Soft catch
      }

      // Step E: Final Submit Step Check
      if (await submitBtn.isVisible().catch(() => false)) {
        console.log(`📌 Reached final Review & Submit step!`);

        // Uncheck "Follow company" to keep user feed clean
        try {
          const followCheckbox = modal.locator('input[type="checkbox"][id*="follow-company"], label:has-text("Follow") input[type="checkbox"]').first();
          if (await followCheckbox.isVisible().catch(() => false)) {
            if (await followCheckbox.isChecked().catch(() => false)) {
              console.log(`🧹 Unchecking "Follow company" checkbox...`);
              await followCheckbox.uncheck({ force: true }).catch(() => null);
            }
          }
        } catch {
          // Soft catch
        }

        if (!options.autoSubmit) {
          const answer = await inquirer.prompt<{ confirmSubmit: boolean }>([
            {
              type: 'confirm',
              name: 'confirmSubmit',
              message: `Ready to submit LinkedIn Easy Apply for "${job.title}" at "${job.company}"?`,
              default: true
            }
          ]);

          if (!answer.confirmSubmit) {
            console.log(`🛑 Application cancelled by user.`);
            updateJobStatus(job.external_job_id, 'skipped');
            return 'skipped';
          }
        } else {
          console.log(`⚡ Auto-submitting application (Hands-Free Mode)...`);
        }

        // Final human pause before submit click
        await simulateMouseMovement(page);
        await humanDelay(page, 800, 1500);

        await submitBtn.click();
        await page.waitForTimeout(3000);

        // Dismiss confirmation modal
        const dismissBtn = page.locator('button:has-text("Done"), button[aria-label="Dismiss"], button.artdeco-modal__dismiss').first();
        if (await dismissBtn.isVisible().catch(() => false)) {
          await dismissBtn.click().catch(() => null);
        }

        console.log(`🎉 [LinkedIn Apply Success] Application submitted for "${job.title}" at ${job.company}!`);
        updateJobStatus(job.external_job_id, 'applied');
        return 'applied';
      }

      // Step F: Resume / Document selection (prefer saved resume, else upload PDF)
      try {
        // Try selecting already-saved LinkedIn resume first
        const resumeItem = modal.locator('.jobs-document-upload__item, button[aria-label*="Choose Resume"]').first();
        if (await resumeItem.isVisible().catch(() => false)) {
          await resumeItem.click().catch(() => null);
          await page.waitForTimeout(300);
        } else {
          // Attempt PDF upload if file input is present
          await tryUploadResume(page, modal, profile);
        }
      } catch {
        // Soft catch
      }

      // Step G: Proceed to next step
      if (await nextBtn.isVisible().catch(() => false)) {
        console.log(`➡️ Step ${step}: Proceeding to next step...`);

        // Fill phone if present and empty
        const phoneInput = modal.locator('input[id*="phoneNumber"], input[name*="phone"]').first();
        if (await phoneInput.isVisible().catch(() => false)) {
          const currentVal = await phoneInput.inputValue();
          if (!currentVal) await phoneInput.fill(profile.phone);
        }

        // Human pre-click pause
        await humanDelay(page, 500, 1200);
        await nextBtn.click();
        await humanDelay(page, 1500, 3000);

        // Error recovery check (if required fields blocked progress)
        const errorFeedback = modal.locator('span.fb-dash-form-element__error-msg, div.artdeco-inline-feedback--error').first();
        if (await errorFeedback.isVisible().catch(() => false)) {
          console.log(`⚠️ Form field validation warning detected. Resolving remaining inputs with profile data...`);
          const inputsToFix = modal.locator('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea');
          const empCount = await inputsToFix.count();
          for (let e = 0; e < empCount; e++) {
            const input = inputsToFix.nth(e);
            const val = await input.inputValue().catch(() => '');

            let labelText = '';
            const parentBlock = input.locator('xpath=ancestor::div[contains(@class, "fb-") or contains(@class, "form") or contains(@class, "group")]').first();
            if (await parentBlock.count() > 0) {
              labelText = (await parentBlock.locator('label, legend, span[aria-hidden="true"]').first().textContent().catch(() => '')) || '';
            }
            if (!labelText) {
              labelText = (await input.getAttribute('aria-label').catch(() => '')) ||
                          (await input.getAttribute('name').catch(() => '')) || 'Years of experience';
            }
            labelText = labelText.replace(/\*/g, '').replace(/\s+/g, ' ').trim();
            const inputType = (await input.getAttribute('type').catch(() => '')) || '';

            const isNumericField = inputType === 'number' || /notice|period|day|year|experience|ctc|salary|compensation|package/i.test(labelText);
            const hasInvalidTextInNumericField = isNumericField && /\D/.test(val.trim());

            if (!val || val.trim() === '' || hasInvalidTextInNumericField) {
              let cleanAnswer = await answerQuestionWithGemini(labelText, job.title);
              cleanAnswer = sanitizeInputAnswer(labelText, cleanAnswer, inputType);

              const isLocationInput = labelText.toLowerCase().includes('location') ||
                                      labelText.toLowerCase().includes('city') ||
                                      ((await input.getAttribute('id').catch(() => '')) || '').includes('city');

              await input.focus().catch(() => null);
              await input.fill('').catch(() => null);
              await input.pressSequentially(cleanAnswer, { delay: 40 }).catch(() => null);
              await page.waitForTimeout(400);

              if (isLocationInput) {
                const typeaheadHit = page.locator('li[role="option"], div[role="option"], div.basic-typeahead__results li, .search-typeahead-v2__hit').first();
                if (await typeaheadHit.isVisible().catch(() => false)) {
                  await typeaheadHit.click().catch(() => null);
                } else {
                  await input.press('ArrowDown').catch(() => null);
                  await page.waitForTimeout(200);
                  await input.press('Enter').catch(() => null);
                }
                await page.waitForTimeout(300);
              }
            }
          }
          await nextBtn.click().catch(() => null);
          await humanDelay(page, 1200, 2500);
        }
      } else {
        break;
      }
    }

    updateJobStatus(job.external_job_id, 'applied');
    return 'applied';

  } catch (err: any) {
    console.error(`❌ [LinkedIn Apply Error]: ${err.message}`);
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
    if (page) {
      await page.close().catch(() => null);
    }
  }
}
