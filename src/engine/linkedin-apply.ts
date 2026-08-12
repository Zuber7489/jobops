import { chromium, BrowserContext, Page } from 'playwright';
import inquirer from 'inquirer';
import { CONFIG, loadProfile } from '../config';
import { updateJobStatus, JobRecord } from '../db/schema';
import { answerQuestionWithGemini } from './gemini';

export interface ApplyOptions {
  autoSubmit?: boolean;
}

export async function applyLinkedInJob(job: JobRecord, options: ApplyOptions = { autoSubmit: false }): Promise<boolean> {
  const profile = loadProfile();
  console.log(`\n🚀 [LinkedIn Easy Apply] Target Job: "${job.title}" at ${job.company}`);
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
      return false;
    }

    console.log(`🌐 Navigating to LinkedIn job page...`);
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Check auth status
    const loginBtn = page.locator('a.nav__button-secondary:has-text("Sign in"), button:has-text("Sign in")').first();
    if (await loginBtn.isVisible().catch(() => false)) {
      console.log(`⚠️ LinkedIn is not logged in inside this Chrome window. Please log into LinkedIn.`);
      return false;
    }

    // Locate "Easy Apply" button
    const easyApplyBtn = page.locator('button.jobs-apply-button, button:has-text("Easy Apply")').first();

    if (!(await easyApplyBtn.isVisible().catch(() => false))) {
      console.log(`⚠️ "Easy Apply" button not visible or already applied.`);
      updateJobStatus(job.external_job_id, 'skipped');
      return false;
    }

    console.log(`👆 Opening Easy Apply modal dialog...`);
    await easyApplyBtn.click();
    await page.waitForTimeout(2500);

    // Multi-step modal loop (Max 6 steps)
    for (let step = 1; step <= 6; step++) {
      const modal = page.locator('div[role="dialog"], div.artdeco-modal, div.jobs-easy-apply-content').first();

      const nextBtn = page.locator('button:has-text("Next"), button:has-text("Review")').first();
      const submitBtn = page.locator('button:has-text("Submit application")').first();

      // Step A: Fill ALL text, numeric, and textarea inputs inside modal with real keypresses
      try {
        const textInputs = modal.locator('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea');
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
        const selects = modal.locator('select');
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
        const comboTriggers = modal.locator('div[role="combobox"], button[aria-label*="Select"], div.fb-dropdown button');
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

      // Step D: Resolve Radio Questions (e.g. "Are you comfortable commuting?", "Are you in Pune?")
      try {
        const fieldsets = modal.locator('fieldset, div.fb-radio, div.fb-form-element');
        const fsCount = await fieldsets.count();

        for (let f = 0; f < fsCount; f++) {
          const fs = fieldsets.nth(f);
          const yesOption = fs.locator('label:has-text("Yes"), input[value="Yes"], span:has-text("Yes")').first();

          if (await yesOption.isVisible().catch(() => false)) {
            await yesOption.click().catch(() => null);
            await page.waitForTimeout(300);
          }
        }
      } catch (radioErr) {
        // Soft catch
      }

      // Step E: Final Submit Step Check
      if (await submitBtn.isVisible().catch(() => false)) {
        console.log(`📌 Reached final Review & Submit step!`);

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
            return false;
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
        return true;
      }

      // Step F: Proceed to next step
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
      } else {
        break;
      }
    }

    updateJobStatus(job.external_job_id, 'applied');
    return true;

  } catch (err: any) {
    console.error(`❌ [LinkedIn Apply Error]: ${err.message}`);
    updateJobStatus(job.external_job_id, 'failed');
    return false;
  }
}
