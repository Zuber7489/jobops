import { Command } from 'commander';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { scanLinkedInJobs } from './scraper/linkedin-scanner';
import { evaluateJobs } from './engine/evaluator';
import { applyLinkedInJob } from './engine/linkedin-apply';
import { getUnappliedJobs, getDb } from './db/schema';
import { CONFIG } from './config';

const program = new Command();

program
  .name('jobops')
  .description('JobOps CLI - LinkedIn Easy Apply AI Automation Engine')
  .version('1.0.0');

// Command 1: launch-chrome
program
  .command('launch-chrome')
  .description('Launch Google Chrome with Remote Debugging port 9222 enabled for session reuse')
  .action(() => {
    console.log(`\n🚀 Launching Google Chrome with remote debugging port 9222...`);
    console.log(`📌 Chrome Path: ${CONFIG.chromeExecutablePath}`);
    console.log(`💡 Once Chrome opens, log into LinkedIn, then run linkedin-apply!\n`);

    const chromeProcess = spawn(CONFIG.chromeExecutablePath, [
      '--remote-debugging-port=9222',
      `--user-data-dir=${CONFIG.userDataDir}`
    ], {
      detached: true,
      stdio: 'ignore'
    });
    chromeProcess.unref();

    console.log(`✅ Chrome launched successfully on port 9222.`);
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

// Command 3: evaluate
program
  .command('evaluate')
  .description('Evaluate scanned LinkedIn jobs instantly against candidate skills')
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

// Command 5: status
program
  .command('status')
  .description('Display summary of tracked LinkedIn jobs and application history')
  .action(() => {
    const db = getDb();
    const totalScanned = (db.prepare(`SELECT COUNT(*) as count FROM jobs`).get() as any).count;
    const totalApplied = (db.prepare(`SELECT COUNT(*) as count FROM jobs WHERE status = 'applied'`).get() as any).count;
    const totalSkipped = (db.prepare(`SELECT COUNT(*) as count FROM jobs WHERE status = 'skipped'`).get() as any).count;

    console.log(`\n📊 [JobOps Automation Status Summary]`);
    console.log(`- Total Scanned LinkedIn Jobs: ${totalScanned}`);
    console.log(`- Applications Submitted: ${totalApplied}`);
    console.log(`- Skipped / Pending: ${totalSkipped}`);

    const recentApplied = db.prepare(`SELECT * FROM jobs WHERE status = 'applied' ORDER BY applied_at DESC LIMIT 5`).all();
    if (recentApplied.length > 0) {
      console.log(`\n✅ Recently Applied:`);
      recentApplied.forEach((j: any) => console.log(`  • ${j.title} @ ${j.company}`));
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
        "location (city)": "Pune",
        "city": "Pune",
        "notice period": "15",
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
      console.log(`✅ [Cache Reset] answers.json has been restored to safe defaults.`);
      console.log(`📁 Path: ${answersPath}`);
    }
  });

program.parse(process.argv);
