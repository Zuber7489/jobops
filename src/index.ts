import { Command } from 'commander';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { scanLinkedInJobs } from './scraper/linkedin-scanner';
import { scanIndeedJobs } from './scraper/indeed-scanner';
import { scanNaukriJobs } from './scraper/naukri-scanner';
import { evaluateJobs } from './engine/evaluator';
import { applyLinkedInJob } from './engine/linkedin-apply';
import { applyIndeedJob } from './engine/indeed-apply';
import { applyNaukriJob } from './engine/naukri-apply';
import { getUnappliedJobs, getDb } from './db/schema';
import { CONFIG } from './config';

import { chromium } from 'playwright';

const program = new Command();

program
  .name('jobops')
  .description('JobOps CLI - LinkedIn, Indeed & Naukri.com Multi-Platform AI Job Automation Engine')
  .version('1.0.0');

// Command 1: launch-chrome
program
  .command('launch-chrome')
  .description('Launch Google Chrome with Remote Debugging port 9222 enabled for session reuse')
  .action(async () => {
    console.log(`\n🚀 Launching Google Chrome with Remote Debugging on port 9222...`);
    console.log(`📌 Profile Directory: ${CONFIG.userDataDir}`);
    console.log(`💡 Once Chrome opens, log into LinkedIn, Indeed & Naukri.com, then run your apply commands!`);
    console.log(`📌 Keep this terminal open while using JobOps, or press Ctrl+C to close Chrome.\n`);

    try {
      const context = await chromium.launchPersistentContext(CONFIG.userDataDir, {
        headless: false,
        channel: 'chrome',
        args: [
          '--remote-debugging-port=9222',
          '--no-first-run',
          '--no-default-browser-check',
          '--start-maximized'
        ],
        viewport: null
      });

      const page = context.pages()[0] || await context.newPage();
      await page.goto('https://www.naukri.com/mnjuser/homepage').catch(() => null);

      console.log(`✅ Chrome is running with Remote Debugging on port 9222.`);
      console.log(`🟢 Chrome window is open on your screen!`);

      await new Promise((resolve) => {
        context.on('close', () => resolve(null));
      });
      console.log(`👋 Chrome window closed.`);
      process.exit(0);
    } catch (err: any) {
      console.error(`❌ Failed to launch Chrome: ${err.message}`);
    }
  });

// Command 2: linkedin-scan
program
  .command('linkedin-scan')
  .description('Scan jobs from LinkedIn Easy Apply (Filtered for Remote & Hybrid, Past 24 hours)')
  .option('-q, --query <text>', 'Job title / skills query', 'Angular Developer')
  .option('-l, --location <city>', 'Job location', 'India')
  .option('-p, --pages <number>', 'Number of pages to scan', '3')
  .option('--work-types <types>', 'LinkedIn work type filter (2=Remote, 3=Hybrid, default: "2,3")', '2,3')
  .option('-t, --time <seconds>', 'LinkedIn time posted filter (default: "r86400" for past 24 hours)', 'r86400')
  .option('--headed', 'Run browser in headed mode', false)
  .action(async (options) => {
    await scanLinkedInJobs({
      query: options.query,
      location: options.location,
      maxPages: parseInt(options.pages, 10),
      headless: !options.headed,
      workTypes: options.workTypes,
      timePosted: options.time
    });
  });

// Command 2b: indeed-scan
program
  .command('indeed-scan')
  .description('Scan jobs from Indeed India (Filtered for Easily Apply + Remote/Hybrid Focus)')
  .option('-q, --query <text>', 'Job title / skills query', 'Angular Developer')
  .option('-l, --location <city>', 'Job location', 'India')
  .option('-p, --pages <number>', 'Number of pages to scan', '3')
  .option('--headed', 'Run browser in headed mode', false)
  .action(async (options) => {
    await scanIndeedJobs({
      query: options.query,
      location: options.location,
      maxPages: parseInt(options.pages, 10),
      headless: !options.headed
    });
  });

// Command 2c: naukri-scan
program
  .command('naukri-scan')
  .description('Scan jobs from Naukri.com (India Remote, Hybrid & In-Office Focus)')
  .option('-q, --query <text>', 'Job title / skills query', 'Angular Developer')
  .option('-l, --location <city>', 'Job location', 'India')
  .option('-p, --pages <number>', 'Number of pages to scan', '3')
  .option('--headed', 'Run browser in visible headed mode', false)
  .action(async (options) => {
    await scanNaukriJobs({
      query: options.query,
      location: options.location,
      maxPages: parseInt(options.pages, 10),
      headless: !options.headed
    });
  });

// Command 3: evaluate
program
  .command('evaluate')
  .description('Evaluate all scanned jobs (LinkedIn, Indeed & Naukri) against candidate skills')
  .action(() => {
    evaluateJobs();
  });

// Command 4: linkedin-apply
program
  .command('linkedin-apply')
  .description('Apply to top evaluated LinkedIn Easy Apply jobs with AI Form Solver')
  .option('--id <externalJobId>', 'Specific LinkedIn Job ID to apply')
  .option('--min-score <score>', 'Minimum threshold score (0.0 - 5.0)', CONFIG.minScoreThreshold.toString())
  .option('--auto', 'Run in 100% automatic hands-free mode without confirmation prompt', false)
  .option('--limit <n>', 'Max applications per session (anti-ban safety cap)', '25')
  .action(async (options) => {
    const minScore = parseFloat(options.minScore);
    const sessionLimit = parseInt(options.limit, 10);
    const db = getDb();

    let jobsToApply: any[] = [];
    if (options.id) {
      jobsToApply = db.prepare(`SELECT * FROM jobs WHERE external_job_id = ?`).all(options.id);
    } else {
      jobsToApply = getUnappliedJobs('linkedin', minScore);
    }

    if (jobsToApply.length === 0) {
      console.log(`⚠️ No unapplied LinkedIn jobs found matching criteria (Min Score: ${minScore}). Run linkedin-scan & evaluate first.`);
      return;
    }

    // Enforce per-session safety cap to reduce LinkedIn bot detection risk
    if (jobsToApply.length > sessionLimit) {
      console.log(`⚠️ [Safety Cap] ${jobsToApply.length} jobs queued. Limiting to ${sessionLimit} applications this session to reduce ban risk.`);
      jobsToApply = jobsToApply.slice(0, sessionLimit);
    }

    console.log(`📋 Found ${jobsToApply.length} LinkedIn job(s) ready for application (Auto Mode: ${options.auto ? 'ENABLED ⚡' : 'DISABLED ✋'}).\n`);
    let appliedCount = 0;
    let skippedCount = 0;

    for (let i = 0; i < jobsToApply.length; i++) {
      const job: any = jobsToApply[i];
      console.log(`--------------------------------------------------`);
      console.log(`📌 Processing job [${i + 1}/${jobsToApply.length}]: "${job.title}" at ${job.company}`);

      const result = await applyLinkedInJob(job, { autoSubmit: options.auto });

      if (result === 'connection_error' || result === 'not_logged_in') {
        console.log(`\n🛑 Aborting job queue due to browser session or CDP connection error.`);
        break;
      }

      if (result === 'limit_reached') {
        console.log(`\n🛑 [LinkedIn Daily Limit Reached] LinkedIn caps Easy Apply submissions per 24 hours. Pausing until tomorrow.`);
        break;
      }

      if (result === 'applied' || result === 'already_applied') {
        appliedCount++;
      } else {
        skippedCount++;
      }

      // ⏳ Random human-like inter-job pause (5s – 15s) to reduce bot fingerprint
      if (i < jobsToApply.length - 1) {
        const interJobPause = 5000 + Math.floor(Math.random() * 10000);
        console.log(`⏳ Waiting ${(interJobPause / 1000).toFixed(1)}s before next application...`);
        await new Promise(r => setTimeout(r, interJobPause));
      }
    }

    console.log(`\n✨ Queue Complete! Processed ${appliedCount + skippedCount} jobs (${appliedCount} applied/already applied, ${skippedCount} skipped/failed).`);
  });

// Command 4b: indeed-apply
program
  .command('indeed-apply')
  .description('Apply to top evaluated Indeed Easily Apply jobs with AI Form Solver')
  .option('--id <externalJobId>', 'Specific Indeed Job ID to apply')
  .option('--min-score <score>', 'Minimum threshold score (0.0 - 5.0)', CONFIG.minScoreThreshold.toString())
  .option('--auto', 'Run in 100% automatic hands-free mode without confirmation prompt', false)
  .option('--limit <n>', 'Max applications per session', '25')
  .action(async (options) => {
    const minScore = parseFloat(options.minScore);
    const sessionLimit = parseInt(options.limit, 10);
    const db = getDb();

    let jobsToApply: any[] = [];
    if (options.id) {
      jobsToApply = db.prepare(`SELECT * FROM jobs WHERE external_job_id = ?`).all(options.id);
    } else {
      jobsToApply = getUnappliedJobs('indeed', minScore);
    }

    if (jobsToApply.length === 0) {
      console.log(`⚠️ No unapplied Indeed jobs found matching criteria (Min Score: ${minScore}). Run indeed-scan & evaluate first.`);
      return;
    }

    if (jobsToApply.length > sessionLimit) {
      console.log(`⚠️ [Safety Cap] ${jobsToApply.length} jobs queued. Limiting to ${sessionLimit} applications this session.`);
      jobsToApply = jobsToApply.slice(0, sessionLimit);
    }

    console.log(`📋 Found ${jobsToApply.length} Indeed job(s) ready for application (Auto Mode: ${options.auto ? 'ENABLED ⚡' : 'DISABLED ✋'}).\n`);
    let appliedCount = 0;
    let skippedCount = 0;

    const { chromium } = require('playwright');
    let browserContext: any = null;
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CONFIG.cdpPort}`);
      browserContext = browser.contexts()[0] || await browser.newContext();
    } catch {
      console.log(`⚠️ Chrome CDP connection port ${CONFIG.cdpPort} failed. Make sure Chrome is open.`);
    }

    for (let i = 0; i < jobsToApply.length; i++) {
      const job: any = jobsToApply[i];
      console.log(`--------------------------------------------------`);
      console.log(`📌 Processing job [${i + 1}/${jobsToApply.length}]: "${job.title}" at ${job.company}`);

      const result = await applyIndeedJob(job, { autoSubmit: options.auto, browserContext });

      if (result === 'connection_error' || result === 'not_logged_in') {
        console.log(`\n🛑 Aborting job queue due to browser session or CDP connection error.`);
        break;
      }

      if (result === 'applied' || result === 'already_applied') {
        appliedCount++;
      } else {
        skippedCount++;
      }

      if (i < jobsToApply.length - 1) {
        const interJobPause = 5000 + Math.floor(Math.random() * 8000);
        console.log(`⏳ Waiting ${(interJobPause / 1000).toFixed(1)}s before next application...`);
        await new Promise(r => setTimeout(r, interJobPause));
      }
    }

    console.log(`\n✨ Queue Complete! Processed ${appliedCount + skippedCount} Indeed jobs (${appliedCount} applied/already applied, ${skippedCount} skipped/failed).`);
  });

// Command 4c: naukri-apply
program
  .command('naukri-apply')
  .description('Apply to top evaluated Naukri.com jobs with AI Chatbot Form Solver')
  .option('--id <externalJobId>', 'Specific Naukri Job ID to apply')
  .option('--min-score <score>', 'Minimum threshold score (0.0 - 5.0)', CONFIG.minScoreThreshold.toString())
  .option('--auto', 'Run in 100% automatic hands-free mode without confirmation prompt', false)
  .option('--limit <n>', 'Max applications per session', '25')
  .action(async (options) => {
    const minScore = parseFloat(options.minScore);
    const sessionLimit = parseInt(options.limit, 10);
    const db = getDb();

    let jobsToApply: any[] = [];
    if (options.id) {
      jobsToApply = db.prepare(`SELECT * FROM jobs WHERE external_job_id = ?`).all(options.id);
    } else {
      jobsToApply = getUnappliedJobs('naukri', minScore);
    }

    if (jobsToApply.length === 0) {
      console.log(`⚠️ No unapplied Naukri jobs found matching criteria (Min Score: ${minScore}). Run naukri-scan & evaluate first.`);
      return;
    }

    if (jobsToApply.length > sessionLimit) {
      console.log(`⚠️ [Safety Cap] ${jobsToApply.length} jobs queued. Limiting to ${sessionLimit} applications this session.`);
      jobsToApply = jobsToApply.slice(0, sessionLimit);
    }

    console.log(`📋 Found ${jobsToApply.length} Naukri job(s) ready for application (Auto Mode: ${options.auto ? 'ENABLED ⚡' : 'DISABLED ✋'}).\n`);
    let appliedCount = 0;
    let skippedCount = 0;

    const { chromium } = require('playwright');
    let browserContext: any = null;
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CONFIG.cdpPort}`);
      browserContext = browser.contexts()[0] || await browser.newContext();
    } catch {
      console.log(`⚠️ Chrome CDP connection port ${CONFIG.cdpPort} failed. Make sure Chrome is open.`);
    }

    for (let i = 0; i < jobsToApply.length; i++) {
      const job: any = jobsToApply[i];
      console.log(`--------------------------------------------------`);
      console.log(`📌 Processing Naukri job [${i + 1}/${jobsToApply.length}]: "${job.title}" at ${job.company}`);

      const result = await applyNaukriJob(job, { autoSubmit: options.auto, browserContext });

      if (result === 'connection_error' || result === 'not_logged_in') {
        console.log(`\n🛑 Aborting Naukri application queue due to browser session or login issue.`);
        break;
      }

      if (result === 'limit_reached') {
        console.log(`\n🛑 [Naukri Limit Reached] Application limit reached for today.`);
        break;
      }

      if (result === 'applied' || result === 'already_applied') {
        appliedCount++;
      } else {
        skippedCount++;
      }

      if (i < jobsToApply.length - 1) {
        const interJobPause = 5000 + Math.floor(Math.random() * 8000);
        console.log(`⏳ Waiting ${(interJobPause / 1000).toFixed(1)}s before next application...`);
        await new Promise(r => setTimeout(r, interJobPause));
      }
    }

    console.log(`\n✨ Queue Complete! Processed ${appliedCount + skippedCount} Naukri jobs (${appliedCount} applied/already applied, ${skippedCount} skipped/failed).`);
  });

// Command 5: status
program
  .command('status')
  .description('Display summary of tracked jobs across platforms and application history')
  .action(() => {
    const db = getDb();
    const totalScanned = (db.prepare(`SELECT COUNT(*) as count FROM jobs`).get() as any).count;
    const totalApplied = (db.prepare(`SELECT COUNT(*) as count FROM jobs WHERE status = 'applied'`).get() as any).count;
    const totalSkipped = (db.prepare(`SELECT COUNT(*) as count FROM jobs WHERE status = 'skipped'`).get() as any).count;

    const linkedinScanned = (db.prepare(`SELECT COUNT(*) as count FROM jobs WHERE platform = 'linkedin'`).get() as any).count;
    const linkedinApplied = (db.prepare(`SELECT COUNT(*) as count FROM jobs WHERE platform = 'linkedin' AND status = 'applied'`).get() as any).count;

    const indeedScanned = (db.prepare(`SELECT COUNT(*) as count FROM jobs WHERE platform = 'indeed'`).get() as any).count;
    const indeedApplied = (db.prepare(`SELECT COUNT(*) as count FROM jobs WHERE platform = 'indeed' AND status = 'applied'`).get() as any).count;

    const naukriScanned = (db.prepare(`SELECT COUNT(*) as count FROM jobs WHERE platform = 'naukri'`).get() as any).count;
    const naukriApplied = (db.prepare(`SELECT COUNT(*) as count FROM jobs WHERE platform = 'naukri' AND status = 'applied'`).get() as any).count;

    console.log(`\n📊 [JobOps Automation Status Summary]`);
    console.log(`- Total Scanned Jobs (All Platforms): ${totalScanned}`);
    console.log(`- Total Applied: ${totalApplied}`);
    console.log(`- Total Skipped / Pending: ${totalSkipped}`);
    console.log(`\n🌐 Platform Breakdown:`);
    console.log(`  • LinkedIn:   ${linkedinScanned} scanned, ${linkedinApplied} applied`);
    console.log(`  • Indeed:     ${indeedScanned} scanned, ${indeedApplied} applied`);
    console.log(`  • Naukri.com: ${naukriScanned} scanned, ${naukriApplied} applied`);

    const recentApplied = db.prepare(`SELECT * FROM jobs WHERE status = 'applied' ORDER BY applied_at DESC LIMIT 5`).all();
    if (recentApplied.length > 0) {
      console.log(`\n✅ Recently Applied:`);
      recentApplied.forEach((j: any) => console.log(`  • [${(j.platform || '').toUpperCase()}] ${j.title} @ ${j.company}`));
    }
  });

// Command 6: reset-cache
program
  .command('reset-cache')
  .description('Reset the AI answers knowledge base (answers.json) to fix corrupted/wrong cached values')
  .option('--key <question>', 'Delete only a specific question key from the cache')
  .action((options) => {
    const answersPath = path.join(process.cwd(), 'answers.json');

    if (options.key) {
      // Delete single key
      if (fs.existsSync(answersPath)) {
        const cache = JSON.parse(fs.readFileSync(answersPath, 'utf8'));
        const keyLower = options.key.toLowerCase().trim();
        if (cache[keyLower] !== undefined) {
          delete cache[keyLower];
          fs.writeFileSync(answersPath, JSON.stringify(cache, null, 2), 'utf8');
          console.log(`✅ Deleted cached answer for: "${options.key}"`);
        } else {
          console.log(`⚠️ Key not found in cache: "${options.key}"`);
        }
      }
    } else {
      // Full reset — restore safe defaults only
      const safeDefaults = {
        "first name": "Mohammad",
        "last name": "Zuber",
        "full name": "Mohammad Zuber",
        "email address": "zuber.shaikh.7415@gmail.com",
        "mobile phone number": "+917489898481",
        "phone number": "+917489898481",
        "location (city)": "Indore, Madhya Pradesh",
        "city": "Indore",
        "location": "Indore, Madhya Pradesh",
        "notice period": "1",
        "current ctc": "320000",
        "expected ctc": "650000",
        "current annual ctc": "320000",
        "expected annual ctc": "650000",
        "total years of experience": "2",
        "years of work experience do you have with angular": "2",
        "years of work experience do you have with typescript": "2",
        "years of work experience do you have with javascript": "2",
        "years of work experience do you have with java": "0",
        "are you legally authorized to work in india": "Yes",
        "do you require visa sponsorship": "No"
      };
      fs.writeFileSync(answersPath, JSON.stringify(safeDefaults, null, 2), 'utf8');
    }
  });

// Command 7: dashboard
program
  .command('dashboard')
  .alias('ui')
  .description('Launch JobOps Web Application Dashboard (Visual UI & Control Center)')
  .option('-p, --port <number>', 'Port number to run web dashboard', '3000')
  .action((options) => {
    const { startDashboardServer } = require('./server/dashboard-server');
    const port = parseInt(options.port, 10);
    startDashboardServer(port);
  });

program.parse(process.argv);
