import { Command } from 'commander';
import { spawn } from 'child_process';
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
  .description('Scan jobs from LinkedIn Easy Apply (Filtered for Remote & Hybrid across India)')
  .option('-q, --query <text>', 'Job title / skills query', 'Angular Developer')
  .option('-l, --location <city>', 'Job location', 'India')
  .option('-p, --pages <number>', 'Number of pages to scan', '3')
  .option('--headed', 'Run browser in headed mode', false)
  .action(async (options) => {
    await scanLinkedInJobs({
      query: options.query,
      location: options.location,
      maxPages: parseInt(options.pages, 10),
      headless: !options.headed
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
  .action(async (options) => {
    const minScore = parseFloat(options.minScore);
    const db = getDb();

    let jobsToApply = [];
    if (options.id) {
      jobsToApply = db.prepare(`SELECT * FROM jobs WHERE external_job_id = ?`).all(options.id);
    } else {
      jobsToApply = getUnappliedJobs('linkedin', minScore);
    }

    if (jobsToApply.length === 0) {
      console.log(`⚠️ No unapplied LinkedIn jobs found matching criteria (Min Score: ${minScore}). Run linkedin-scan & evaluate first.`);
      return;
    }

    console.log(`📋 Found ${jobsToApply.length} LinkedIn job(s) ready for application (Auto Mode: ${options.auto ? 'ENABLED ⚡' : 'DISABLED ✋'}).`);
    for (const job of jobsToApply) {
      const success = await applyLinkedInJob(job as any, { autoSubmit: options.auto });
      if (!success) break; // Stop loop cleanly if CDP connection is missing
    }
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

program.parse(process.argv);
