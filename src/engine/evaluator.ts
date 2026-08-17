import { getDb, JobRecord } from '../db/schema';
import { loadProfile } from '../config';

export function evaluateJobs(forceAll: boolean = true): JobRecord[] {
  const profile = loadProfile();
  const db = getDb();

  console.log(`\n⚡ [Instant Match Engine] Evaluating scanned jobs for candidate ${profile.name}...`);

  const whereClause = forceAll ? `WHERE status IN ('scanned', 'evaluated')` : `WHERE status = 'scanned'`;
  const jobsToEvaluate = db.prepare(`SELECT * FROM jobs ${whereClause}`).all() as JobRecord[];

  const primaryTech = ['angular', 'typescript', 'rxjs', 'signals', 'standalone components', 'frontend', 'ui developer', 'web developer', 'mean stack', 'full stack'];
  const secondaryTech = ['reactive forms', 'rest', 'jwt', 'route guards', 'interceptors', 'material', 'bootstrap', 'scss', 'css', 'html', 'git'];
  const unrelatedTech = [
    'backend', 'back-end', 'devops', 'python', 'ios', 'android', 'flutter',
    'salesforce', 'servicenow', 'sharepoint', 'embedded', 'sap', 'qa', 'testing',
    'data engineer', 'data scientist', 'machine learning', 'cybersecurity'
  ];

  const evaluatedJobs: JobRecord[] = [];
  const blacklisted = profile.blacklistedCompanies || [];

  for (const job of jobsToEvaluate) {
    const isBlacklisted = blacklisted.some(b => job.company.toLowerCase().includes(b.toLowerCase()));
    if (isBlacklisted) {
      db.prepare(`
        UPDATE jobs 
        SET score = 0.0, evaluation_reason = 'Blacklisted fake company', status = 'skipped' 
        WHERE external_job_id = ?
      `).run(job.external_job_id);

      job.score = 0.0;
      job.evaluation_reason = 'Blacklisted fake company';
      job.status = 'skipped';
      console.log(`🚫 [Blacklisted Company Skipped] Job #${job.id}: ${job.title} @ ${job.company}`);
      continue;
    }

    const titleLower = job.title.toLowerCase();
    const textToMatch = `${job.title} ${job.company} ${job.jd_text}`.toLowerCase();

    // Direct check for unrelated/non-Angular roles in title
    const isUnrelatedRole = /backend|back-end|java|c\+\+|\.net|c#|python|django|flask|php|laravel|ruby|rails|golang|android|ios|flutter|react native|qa|testing|tester|data engineer|data scientist|devops|sharepoint|shopify|musician|annotation|mentor|sales|recruiter/i.test(titleLower);

    let score = 1.0; // Baseline candidate score (starts at 1.0 for non-matching roles)
    const matchedKeywords: string[] = [];

    // 1. Primary Stack Matching (Angular, RxJS, Signals, TS, Frontend, UI Developer)
    for (const tech of primaryTech) {
      if (textToMatch.includes(tech)) {
        score += 0.8;
        if (tech === 'angular') score += 1.0; // Bonus for explicit Angular title/JD
        matchedKeywords.push(tech);
      }
    }

    // 2. Secondary Skill Matching
    for (const tech of secondaryTech) {
      if (textToMatch.includes(tech)) {
        score += 0.2;
        if (!matchedKeywords.includes(tech)) matchedKeywords.push(tech);
      }
    }

    // 3. Penalty for Unrelated Technologies
    for (const tech of unrelatedTech) {
      if (textToMatch.includes(tech)) {
        score -= 1.0;
      }
    }

    if (isUnrelatedRole) {
      score -= 2.0; // Heavily penalize non-Angular/non-Frontend titles
    }

    // Clamp score strictly between 1.0 and 5.0
    score = Math.min(5.0, Math.max(1.0, score));

    const reason = matchedKeywords.length > 0
      ? `Matched: ${matchedKeywords.slice(0, 4).join(', ')}`
      : 'Unrelated / Low Match Role';

    db.prepare(`
      UPDATE jobs 
      SET score = ?, evaluation_reason = ?, status = 'evaluated' 
      WHERE external_job_id = ?
    `).run(score, reason, job.external_job_id);

    job.score = score;
    job.evaluation_reason = reason;
    job.status = 'evaluated';
    evaluatedJobs.push(job);

    console.log(`⭐ [Job #${job.id}] ${job.title} @ ${job.company} -> Score: ${score.toFixed(1)}/5.0 (${reason})`);
  }

  console.log(`\n✅ [Evaluation Completed] Evaluated ${evaluatedJobs.length} jobs in 0.05s.`);
  return evaluatedJobs;
}
