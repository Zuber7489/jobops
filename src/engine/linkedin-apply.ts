import { chromium, BrowserContext, Page } from 'playwright';
import inquirer from 'inquirer';
import { CONFIG, loadProfile } from '../config';
import { updateJobStatus, JobRecord } from '../db/schema';
import { answerQuestionWithGemini } from './gemini';

export interface ApplyOptions {
  autoSubmit?: boolean;
}

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

export type ApplyResult = 'applied' | 'skipped' | 'already_applied' | 'connection_error' | 'not_logged_in' | 'failed';

export async function applyLinkedInJob(job: JobRecord, options: ApplyOptions = { autoSubmit: false }): Promise<ApplyResult> {
  const profile = loadProfile();
  console.log(`\n🚀 [LinkedIn Apply] Target Job: "${job.title}" at ${job.company}`);
  console.log(`🔗 Job URL: ${job.url}`);

  let browserContext: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    // Connect to existing logged-in Chrome session via CDP
    try {
      console.log(`🔌 Connecting to active Chrome session on CDP port ${CONFIG.cdpPort}...`);
      const browser = await chromium.connectOverCDP(`http://localhost:${CONFIG.cdpPort}`);
      browserContext = browser.contexts()[0] || await browser.newContext();
      page = await browserContext.newPage();
      console.log(`✅ Connected to active Chrome session!`);
    } catch (cdpErr) {
      console.log(`\n❌ [Connection Required] Active Chrome browser session not found on CDP port ${CONFIG.cdpPort}.`);
      console.log(`👉 Please run: npx ts-node src/index.ts launch-chrome\n`);
      return 'connection_error';
    }

    // Extract numeric job ID if present
    const jobIdMatch = job.url.match(/(\d{8,12})/);
    const rawJobId = jobIdMatch ? jobIdMatch[1] : null;

    // Direct /jobs/view/{jobId} URL is the cleanest and fastest way to render single job details on LinkedIn
    const targetUrl = rawJobId 
      ? `https://www.linkedin.com/jobs/view/${rawJobId}/`
      : job.url;

    console.log(`🌐 Navigating to LinkedIn job page: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Check auth status
    const loginBtn = await findVisibleElement(page, ['a.nav__button-secondary:has-text("Sign in")', 'button:has-text("Sign in")', 'a[href*="login"]'], 1500);
    if (loginBtn) {
      console.log(`⚠️ LinkedIn is not logged in inside the active Chrome window.`);
      console.log(`👉 Please make sure Chrome (launched via launch-chrome) is logged into https://linkedin.com`);
      return 'not_logged_in';
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
      // Fallback check: try search view URL format if direct view didn't render it
      const searchViewUrl = `https://www.linkedin.com/jobs/search/?currentJobId=${rawJobId}`;
      console.log(`🔄 Retrying with search view URL: ${searchViewUrl}`);
      await page.goto(searchViewUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);
      easyApplyBtn = await findVisibleElement(page, easyApplySelectors, 6000);
    }

    if (!easyApplyBtn) {
      console.log(`⏩ "Easy Apply" button not visible (likely an external site apply position). Skipping.`);
      updateJobStatus(job.external_job_id, 'skipped');
      return 'skipped';
    }

    console.log(`👆 Opening Easy Apply modal dialog...`);
    try {
      await easyApplyBtn.click();
    } catch {
      await easyApplyBtn.click({ force: true }).catch(() => null);
    }
    await page.waitForTimeout(2500);

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
            const aiAnswer = await answerQuestionWithGemini(labelText, job.title);
            console.log(`💡 Answer: "${aiAnswer}"`);

            await input.focus();
            await input.fill('');
            await input.pressSequentially(aiAnswer, { delay: 30 });
            await input.dispatchEvent('input');
            await input.dispatchEvent('change');
            await input.dispatchEvent('blur');
            await input.press('Tab');
            await page.waitForTimeout(200);
          }
        }
      } catch (aiErr: any) {
        console.error(`⚠️ Input resolution note:`, aiErr.message);
      }

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
            await page.waitForTimeout(200);
          }
        }
      } catch (selErr) {
        // Soft catch
      }

      // Step C: Resolve Custom ARIA Dropdowns / Comboboxes (e.g. Total years / months of experience)
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

          // Skip if radio group already has a selection
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

      // Step F: Resume / Document selection check
      try {
        const resumeItem = modal.locator('.jobs-document-upload__item, button[aria-label*="Choose Resume"]').first();
        if (await resumeItem.isVisible().catch(() => false)) {
          await resumeItem.click().catch(() => null);
          await page.waitForTimeout(300);
        }
      } catch {
        // Soft catch
      }

      // Step G: Proceed to next step
      if (await nextBtn.isVisible().catch(() => false)) {
        console.log(`➡️ Step ${step}: Proceeding to next step...`);
        
        // Fill phone if present
        const phoneInput = modal.locator('input[id*="phoneNumber"], input[name*="phone"]').first();
        if (await phoneInput.isVisible().catch(() => false)) {
          const currentVal = await phoneInput.inputValue();
          if (!currentVal) await phoneInput.fill(profile.phone);
        }

        await nextBtn.click();
        await page.waitForTimeout(2000);

        // Error recovery check (if required fields blocked progress)
        const errorFeedback = modal.locator('span.fb-dash-form-element__error-msg, div.artdeco-inline-feedback--error').first();
        if (await errorFeedback.isVisible().catch(() => false)) {
          console.log(`⚠️ Form field validation warning detected. Resolving remaining inputs with profile data...`);
          const emptyInputs = modal.locator('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea');
          const empCount = await emptyInputs.count();
          for (let e = 0; e < empCount; e++) {
            const input = emptyInputs.nth(e);
            const val = await input.inputValue().catch(() => '');
            if (!val || val.trim() === '') {
              let labelText = (await input.getAttribute('aria-label').catch(() => '')) ||
                              (await input.getAttribute('name').catch(() => '')) || 'Years of experience';
              const cleanAnswer = await answerQuestionWithGemini(labelText, job.title);
              await input.fill(cleanAnswer).catch(() => null);
            }
          }
          await nextBtn.click().catch(() => null);
          await page.waitForTimeout(1500);
        }
      } else {
        break;
      }
    }

    updateJobStatus(job.external_job_id, 'applied');
    return 'applied';

  } catch (err: any) {
    console.error(`❌ [LinkedIn Apply Error]: ${err.message}`);
    updateJobStatus(job.external_job_id, 'failed');
    return 'failed';
  } finally {
    if (page) {
      await page.close().catch(() => null);
    }
  }
}
