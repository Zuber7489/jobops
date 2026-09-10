import { chromium, BrowserContext, Page } from 'playwright';
import inquirer from 'inquirer';
import path from 'path';
import fs from 'fs';
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
async function humanDelay(page: Page, minMs = 1500, maxMs = 3500) {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  await page.waitForTimeout(delay);
}

/** Simulate human mouse drift */
async function simulateMouseMovement(page: Page) {
  try {
    const vw = page.viewportSize()?.width || 1280;
    const vh = page.viewportSize()?.height || 800;
    const steps = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < steps; i++) {
      await page.mouse.move(
        Math.floor(Math.random() * vw),
        Math.floor(Math.random() * vh),
        { steps: 8 }
      );
      await page.waitForTimeout(100 + Math.floor(Math.random() * 150));
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
    await page.waitForTimeout(300);
  }
  return null;
}

/** Sanitize and tailor candidate answers specifically for Indian IT & Naukri formats */
function sanitizeInputAnswer(labelText: string, rawAnswer: string, inputType: string): string {
  const profile = loadProfile();
  let answer = (rawAnswer || '').trim();
  const lowerLabel = labelText.toLowerCase();

  // 1. Notice period / Last working day
  if (/notice|period|last working day|joining|serving/i.test(lowerLabel)) {
    if (/day/i.test(lowerLabel) && !/month/i.test(lowerLabel)) {
      return (profile.noticePeriodDays || 15).toString();
    }
    if (profile.noticePeriodDays <= 15) return '15 days';
    if (profile.noticePeriodDays <= 30) return '30 days';
    return `${profile.noticePeriodDays} days`;
  }

  // 2. Current CTC & Expected CTC
  if (/current.*ctc|current.*salary|current.*package/i.test(lowerLabel)) {
    // Naukri often asks in Lakhs per annum (e.g. "3.2" or "3.5")
    if (/lakh|lac/i.test(lowerLabel)) {
      return profile.currentCtcLpa.toString();
    }
    return (profile.currentCtcLpa * 100000).toString();
  }

  if (/expect.*ctc|expect.*salary|expect.*package/i.test(lowerLabel)) {
    if (/lakh|lac/i.test(lowerLabel)) {
      return profile.expectedCtcLpa.toString();
    }
    return (profile.expectedCtcLpa * 100000).toString();
  }

  // 3. Combined CTC & ECTC
  if (lowerLabel.includes('ctc') && (lowerLabel.includes('expect') || lowerLabel.includes('ectc'))) {
    return `Current CTC: ${profile.currentCtcLpa} LPA, Expected CTC: ${profile.expectedCtcLpa} LPA`;
  }

  // 4. Total Experience / Relevant Experience
  if (/total.*(experience|exp|yoe)/i.test(lowerLabel)) {
    return profile.totalYoe.toString();
  }
  if (/relevant.*(experience|exp|yoe)/i.test(lowerLabel)) {
    return profile.relevantYoe.toString();
  }

  // 5. Skills candidate HAS
  if (/angular|typescript|rxjs|javascript|frontend|ui|html|css/i.test(lowerLabel) && /experience|years|yoe/i.test(lowerLabel)) {
    return profile.relevantYoe.toString();
  }

  // 6. Skills candidate DOES NOT HAVE
  if (/java|python|c#|\.net|flutter|react native|django|php|laravel|salesforce|sap|devops/i.test(lowerLabel) && /experience|years|yoe/i.test(lowerLabel)) {
    return '0';
  }

  // 7. Location / Preferred City
  if (/location|city|prefer/i.test(lowerLabel)) {
    return profile.location || 'Indore';
  }

  // 8. Interview / Availability / Relocation
  if (/interview|available|virtual.*interview|attend.*interview/i.test(lowerLabel)) {
    return 'Yes';
  }
  if (/relocate|relocation/i.test(lowerLabel)) {
    return 'Yes';
  }
  if (/work from office|hybrid|onsite|wfo/i.test(lowerLabel)) {
    return 'Yes';
  }

  // Strip non-digit characters if numeric field
  if (inputType === 'number' || /years|yoe|months|days/i.test(lowerLabel)) {
    const digitsOnly = answer.replace(/[^\d.]/g, '');
    if (digitsOnly) return digitsOnly;
  }

  return answer;
}

/** Handles Naukri's interactive Chatbot Drawer questionnaire */
async function solveChatbotQuestions(page: Page, job: JobRecord, profile: ReturnType<typeof loadProfile>): Promise<boolean> {
  const drawerSelector = '.chatbot_Drawer, [class*="chatbot_Drawer"]';
  console.log(`🤖 [Naukri Chatbot] Inspecting questionnaire drawer...`);

  const maxTurns = 8;
  let lastHandledQuestion = '';

  for (let turn = 1; turn <= maxTurns; turn++) {
    await page.waitForTimeout(1500);

    const drawer = page.locator(drawerSelector).first();
    const isDrawerVisible = await drawer.isVisible().catch(() => false);

    // If drawer closed, check if application succeeded
    if (!isDrawerVisible) {
      console.log(`✨ [Naukri Chatbot] Questionnaire drawer closed.`);
      return true;
    }

    // Check for success or completion messages inside drawer
    const drawerText = (await drawer.textContent().catch(() => '')) || '';
    if (/applied successfully|application submitted|successfully applied|thank you for applying/i.test(drawerText)) {
      console.log(`🎉 [Naukri Chatbot] Application submission confirmed inside chatbot!`);
      return true;
    }

    // Extract the latest bot question text
    const botMessages = drawer.locator('.botMsg, .chat-msg, .botItem, .chatbot_ListItem div.msg');
    const msgCount = await botMessages.count();
    let currentQuestion = '';

    for (let m = msgCount - 1; m >= 0; m--) {
      const txt = (await botMessages.nth(m).textContent().catch(() => ''))?.trim() || '';
      if (txt && txt.length > 4 && !/naukri|beware|fraud|imposter/i.test(txt)) {
        currentQuestion = txt;
        break;
      }
    }

    if (!currentQuestion) {
      currentQuestion = 'Please enter details to apply';
    }

    // Avoid repeatedly processing the same question if state hasn't changed
    if (currentQuestion === lastHandledQuestion) {
      await page.waitForTimeout(1000);
    }
    lastHandledQuestion = currentQuestion;

    console.log(`❓ [Naukri Chatbot Q${turn}]: "${currentQuestion}"`);

    // A. Check for Quick Reply Chips / Options (e.g. Notice period choices, Yes/No, Salary chips)
    // Only inspect elements with actual visible non-empty text (not empty container divs)
    const chipLocators = drawer.locator('.chipMsg, .chipItem, .chips-item, button.chip, [role="button"].chip, .option, li[class*="chip"], [class*="chip"] span, [class*="chip"] div, button');
    const totalChips = await chipLocators.count();
    const validChips: { locator: any; text: string }[] = [];

    for (let c = 0; c < totalChips; c++) {
      const loc = chipLocators.nth(c);
      const isVis = await loc.isVisible().catch(() => false);
      const cText = (await loc.textContent().catch(() => ''))?.trim() || '';
      // Only keep actual clickable chips with 1-60 characters of text
      if (isVis && cText.length > 0 && cText.length < 60 && !/save|send|close|submit/i.test(cText) && !validChips.some(v => v.text.toLowerCase() === cText.toLowerCase())) {
        validChips.push({ locator: loc, text: cText });
      }
    }

    if (validChips.length > 0) {
      console.log(`💡 [Naukri Chatbot] Found ${validChips.length} chip options: [${validChips.map(v => v.text).join(', ')}]`);

      let chosen = validChips[0];
      const qLower = currentQuestion.toLowerCase();

      if (/notice/i.test(qLower)) {
        const noticeMatch = validChips.find(v => /15\s*day|immediate|serving|1\s*month/i.test(v.text));
        if (noticeMatch) chosen = noticeMatch;
      } else if (/interview|available|agree|authorized|relocate/i.test(qLower) || validChips.some(v => /^yes$/i.test(v.text))) {
        // For interview availability or yes/no questions, ALWAYS select "Yes"
        const yesMatch = validChips.find(v => /^yes/i.test(v.text) || /available/i.test(v.text));
        if (yesMatch) chosen = yesMatch;
      } else {
        const optionsList = validChips.map(v => v.text).join(', ');
        const prompt = `Question: "${currentQuestion}". Options: [${optionsList}]. Candidate: Mohammad Zuber, 2.5 YOE Angular/TS, notice 15 days, CTC 3.2, ECTC 6.5, Indore. Return only the best matching option text from the list.`;
        const aiChosen = (await answerQuestionWithGemini(prompt, job.title)).trim();
        const found = validChips.find(v => v.text.toLowerCase().includes(aiChosen.toLowerCase()) || aiChosen.toLowerCase().includes(v.text.toLowerCase()));
        if (found) chosen = found;
      }

      console.log(`👆 Clicking chip option: "${chosen.text}"`);
      await chosen.locator.click().catch(() => null);
      await page.waitForTimeout(2000);
      continue;
    }

    // B. Check for ContentEditable / Text Input Area
    const inputArea = drawer.locator('.textArea[contenteditable="true"], div[contenteditable="true"], textarea, input:not([type="hidden"]):not([type="file"])').first();
    if (await inputArea.isVisible().catch(() => false)) {
      let aiAnswer = await answerQuestionWithGemini(currentQuestion, job.title);
      aiAnswer = sanitizeInputAnswer(currentQuestion, aiAnswer, '');

      console.log(`💬 Typing answer: "${aiAnswer}"`);
      await inputArea.click().catch(() => null);
      await page.waitForTimeout(300);

      // Support contenteditable div
      const isContentEditable = await inputArea.evaluate((el: any) => el.isContentEditable).catch(() => false);
      if (isContentEditable) {
        await inputArea.evaluate((el: any, text: string) => {
          el.innerText = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, aiAnswer);
        // Also trigger keystrokes to ensure Naukri's state detects text
        await page.keyboard.press('End');
        await page.keyboard.type(' ');
        await page.keyboard.press('Backspace');
      } else {
        await inputArea.fill('').catch(() => null);
        await inputArea.pressSequentially(aiAnswer, { delay: 30 }).catch(() => null);
      }

      await page.waitForTimeout(600);

      // Click Send / Save button or press Enter
      const sendBtn = drawer.locator('.sendMsg, .send, [class*="sendMsg"], button:has-text("Save"), button:has-text("Send"), [tabindex="0"]:has-text("Save")').first();
      if (await sendBtn.isVisible().catch(() => false)) {
        console.log(`📤 Submitting answer...`);
        await sendBtn.click().catch(() => null);
        await page.waitForTimeout(2000);
      } else {
        await page.keyboard.press('Enter').catch(() => null);
        await page.waitForTimeout(2000);
      }
      continue;
    }

    // C. Check for Resume Upload Input if requested
    const fileInput = drawer.locator('input.chatbot_Uploader[type="file"], input[type="file"]').first();
    if (await fileInput.count() > 0) {
      const resumeCandidates = [
        profile.resumeUploadPath ? path.resolve(profile.resumeUploadPath) : '',
        path.join(process.cwd(), 'resume.pdf'),
        path.join(process.cwd(), 'Mohammad_Zuber_Resume.pdf')
      ].filter(Boolean);

      const validPdf = resumeCandidates.find(p => fs.existsSync(p));
      if (validPdf) {
        console.log(`📎 Uploading resume to chatbot: ${path.basename(validPdf)}`);
        await fileInput.setInputFiles(validPdf).catch(() => null);
        await page.waitForTimeout(2000);
      }
    }

    // D. Check for generic primary action button (e.g. "Apply", "Save & Continue", "Submit")
    const actionBtn = drawer.locator('button[class*="primary"], button:has-text("Apply"), button:has-text("Submit"), button:has-text("Done")').first();
    if (await actionBtn.isVisible().catch(() => false)) {
      console.log(`👆 Clicking chatbot primary button...`);
      await actionBtn.click().catch(() => null);
      await page.waitForTimeout(2000);
    }
  }

  // Final check if drawer is still open
  const drawerStillOpen = await page.locator(drawerSelector).first().isVisible().catch(() => false);
  if (drawerStillOpen) {
    // Attempt closing via cross icon
    const crossIcon = page.locator('.chatbot_Drawer .crossIcon, .chatbot_Drawer [class*="cross"]').first();
    if (await crossIcon.isVisible().catch(() => false)) {
      await crossIcon.click().catch(() => null);
      await page.waitForTimeout(1000);
    }
  }

  return true;
}

/** Main Entry Point: Apply to a Naukri.com Job */
export async function applyNaukriJob(job: JobRecord, options: ApplyOptions = {}): Promise<ApplyResult> {
  const profile = loadProfile();
  let browserContext = options.browserContext;
  let page: Page | null = null;
  let isCdp = false;

  try {
    // Connect to active Chrome session
    if (!browserContext) {
      try {
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CONFIG.cdpPort}`);
        browserContext = browser.contexts()[0] || await browser.newContext();
        page = await browserContext.newPage();
        isCdp = true;
        await page.bringToFront().catch(() => null);
      } catch (cdpErr: any) {
        console.log(`⚠️ Chrome CDP port ${CONFIG.cdpPort} connection failed (${cdpErr.message}).`);
        console.log(`💡 Tip: Run "npx ts-node src/index.ts launch-chrome" to open your logged-in Chrome session.`);
        return 'connection_error';
      }
    } else {
      page = await browserContext.newPage();
    }

    page.setDefaultTimeout(15000);

    console.log(`🌐 Navigating to Naukri job page: ${job.url}`);
    try {
      await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (navErr: any) {
      console.log(`⚠️ Navigation to ${job.url} failed (${navErr.message}). Skipping.`);
      updateJobStatus(job.external_job_id, 'skipped');
      return 'skipped';
    }

    await simulateMouseMovement(page);
    await humanDelay(page, 2000, 3500);

    // 1. Check if user is logged into Naukri
    const loginIndicator = await findVisibleElement(page, [
      '#continue-with-google-button',
      'button:has-text("Continue with Google")',
      'a:has-text("Login to apply")',
      '.login-btn'
    ], 2000);

    if (loginIndicator) {
      console.log(`\n🛑 [Not Logged In] Naukri session not active. Please log in to Naukri in your Chrome window.`);
      return 'not_logged_in';
    }

    // 1b. Strict Experience & Seniority Guard (Candidate has 2.5 YOE: strictly target 2-3 yrs, max 1-4 yrs)
    const combinedText = `${job.title} ${job.url} ${job.jd_text}`.toLowerCase();
    const isOverExperienced = /(\b[4-9]\s*to\s*\d+\s*years|\b1\d\s*to\s*\d+\s*years|\b[4-9]\s*-\s*\d+\s*yrs|\b[4-9]\+\s*yrs|\b[4-9]\+\s*years)/i.test(combinedText);
    const isSeniorTitle = /\b(lead|principal|architect|director|staff|manager|team lead|head)\b/i.test(job.title);

    if (isOverExperienced || isSeniorTitle) {
      console.log(`⏩ [Senior/Experience Mismatch]: "${job.title}" requires 4+ years (Candidate has ${profile.totalYoe} YOE). Skipping.`);
      updateJobStatus(job.external_job_id, 'skipped');
      return 'skipped';
    }

    // 1c. Freshness Guard: Skip stale jobs (30+ days old)
    const isStale = /30\+\s*days|1\s*month\s*ago|2\s*months\s*ago/i.test(combinedText);
    if (isStale) {
      console.log(`⏩ [Stale Job Skipped]: "${job.title}" at ${job.company} is 30+ days old. Skipping.`);
      updateJobStatus(job.external_job_id, 'skipped');
      return 'skipped';
    }

    // 2. Check for external company site apply button FIRST (to skip external redirects immediately)
    const isExternalSite = await page.evaluate(() => {
      const compSiteBtn = document.querySelector('#company-site-button, [class*="company-site"], a[class*="company-site"]');
      const container = document.querySelector('[class*="apply-button-container"]');
      const text = ((container as HTMLElement)?.innerText || container?.textContent || '') + ' ' + ((compSiteBtn as HTMLElement)?.innerText || compSiteBtn?.textContent || '');
      return /company site/i.test(text);
    });

    if (isExternalSite) {
      console.log(`⏩ [External Company Site]: "${job.title}" at ${job.company} redirects to third-party portal ("Apply on company site"). Skipping.`);
      updateJobStatus(job.external_job_id, 'skipped');
      return 'skipped';
    }

    // 3. Check if already applied (strictly scoped inside the job action container, NOT global navbar)
    const alreadyApplied = await page.evaluate(() => {
      const container = document.querySelector('[class*="apply-button-container"]');
      if (!container) return false;
      const text = ((container as HTMLElement)?.innerText || container?.textContent || '').trim();
      const innerAppliedBadge = container.querySelector('.already-applied, [class*="alreadyApplied"]');
      
      // Container text must explicitly be "Applied" or "Already Applied", not "Apply" or "Apply on company site"
      return /^applied$/i.test(text) || /^already applied$/i.test(text) || !!innerAppliedBadge;
    });

    if (alreadyApplied) {
      console.log(`ℹ️ Job "${job.title}" at ${job.company} is already applied on Naukri.`);
      updateJobStatus(job.external_job_id, 'applied');
      return 'already_applied';
    }

    // 4. Locate visible direct Apply button
    const applyBtn = await findVisibleElement(page, [
      '#apply-button',
      'button.apply-button',
      '[class*="apply-button-container"] button:has-text("Apply")',
      'button:has-text("Apply")'
    ], 5000);

    if (!applyBtn) {
      console.log(`⏩ Direct "Apply" button not found on Naukri page. Skipping.`);
      updateJobStatus(job.external_job_id, 'skipped');
      return 'skipped';
    }

    // 5. User Confirmation (if not in auto mode)
    if (!options.autoSubmit) {
      const answer = await inquirer.prompt<{ confirmSubmit: boolean }>([
        {
          type: 'confirm',
          name: 'confirmSubmit',
          message: `Ready to submit Naukri Apply for "${job.title}" at "${job.company}"?`,
          default: true
        }
      ]);

      if (!answer.confirmSubmit) {
        console.log(`🛑 Application cancelled by user.`);
        updateJobStatus(job.external_job_id, 'skipped');
        return 'skipped';
      }
    } else {
      console.log(`⚡ Auto-applying on Naukri (Hands-Free Mode)...`);
    }

    // 6. Click Apply button
    await simulateMouseMovement(page);
    await humanDelay(page, 600, 1200);

    console.log(`👆 Clicking Naukri Apply button...`);
    try {
      await applyBtn.click();
    } catch {
      await applyBtn.click({ force: true }).catch(() => null);
    }

    await page.waitForTimeout(3000);

    // 7. Check if Chatbot Drawer appears or if 1-click apply succeeded
    const chatbotDrawer = page.locator('.chatbot_Drawer, [class*="chatbot_Drawer"]').first();
    const hasChatbot = await chatbotDrawer.isVisible().catch(() => false);

    if (hasChatbot) {
      console.log(`💬 Naukri Chatbot Questionnaire detected! Engaging AI solver...`);
      await solveChatbotQuestions(page, job, profile);
    } else {
      console.log(`⚡ 1-Click Direct Apply completed!`);
    }

    await page.waitForTimeout(2000);

    // 8. Confirm application status
    const currentUrl = page.url();
    const currentTitle = await page.title().catch(() => '');
    const isUrlConfirmed = currentUrl.includes('myapply/saveApply') || currentTitle.includes('Apply Confirmation');

    const isNowApplied = await page.evaluate(() => {
      if (window.location.href.includes('myapply/saveApply') || document.title.includes('Apply Confirmation')) {
        return true;
      }
      const container = document.querySelector('[class*="apply-button-container"]');
      const text = (container as HTMLElement)?.innerText || container?.textContent || '';
      const toasts = Array.from(document.querySelectorAll('.toast, .snackbar, [class*="toast"], [class*="success"]')).map(t => (t as HTMLElement)?.innerText || t?.textContent || '');
      const hasSuccessToast = toasts.some(t => /applied|submitted|success/i.test(t));
      return /applied/i.test(text.trim()) || hasSuccessToast;
    });

    if (isNowApplied || isUrlConfirmed || hasChatbot) {
      console.log(`🎉 [Naukri Apply Success] Successfully applied for "${job.title}" at ${job.company}!`);
      updateJobStatus(job.external_job_id, 'applied');
      return 'applied';
    }

    console.log(`⚠️ Naukri application state unclear. Marking as evaluated for retry.`);
    updateJobStatus(job.external_job_id, 'evaluated');
    return 'skipped';

  } catch (err: any) {
    console.error(`❌ [Naukri Apply Error]: ${err.message}`);
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
    if (page && isCdp) {
      await page.close().catch(() => null);
    }
  }
}
