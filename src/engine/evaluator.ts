import { getDb, JobRecord } from '../db/schema';
import { loadProfile } from '../config';

export interface EvaluateOptions {
  forceAll?: boolean;
  reevaluateSkipped?: boolean;
}

export function evaluateJobs(options?: EvaluateOptions | boolean): JobRecord[] {
  const opts: EvaluateOptions = typeof options === 'boolean' 
    ? { forceAll: options } 
    : (options || { forceAll: true });
  const forceAll = opts.forceAll ?? true;
  const reevaluateSkipped = opts.reevaluateSkipped ?? false;

  const profile = loadProfile();
  const db = getDb();

  console.log(`\n⚡ [Instant Match Engine] Evaluating scanned jobs for candidate ${profile.name}...`);

  let whereClause = '';
  if (reevaluateSkipped) {
    whereClause = `WHERE status IN ('scanned', 'evaluated', 'skipped') AND (apply_type IS NULL OR apply_type != 'external') AND evaluation_reason != 'Blacklisted fake company'`;
  } else if (forceAll) {
    whereClause = `WHERE status IN ('scanned', 'evaluated') AND (apply_type IS NULL OR apply_type != 'external')`;
  } else {
    whereClause = `WHERE status = 'scanned' AND (apply_type IS NULL OR apply_type != 'external')`;
  }
  const jobsToEvaluate = db.prepare(`SELECT * FROM jobs ${whereClause}`).all() as JobRecord[];

  const primaryTech = ['angular', 'angularjs', 'ionic', 'typescript', 'rxjs', 'signals', 'standalone components', 'frontend', 'ui developer', 'web developer'];
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
    const textToMatch = `${job.title} ${job.company} ${job.location || ''} ${job.jd_text}`.toLowerCase();

    // 1. Strict Role Filter: Candidate Mohammad Zuber ONLY targets Pure Angular / Frontend / UI roles!
    // Disqualify any Java, React, Fullstack, .NET, Python, Backend, or non-Angular roles
    const isForbiddenTech = /(^|\W)(java|spring|springboot|hibernate|j2ee|react|reactjs|react\.js|react-native|\.?net|dotnet|c#|asp\.net|python|django|flask|fastapi|php|laravel|codeigniter|wordpress|ruby|rails|golang|c\+\+|embedded|full\s*stack|fullstack|mean\s*stack|mern\s*stack|backend|back-end|qa|testing|tester|test engineer|devops|cloud|salesforce|servicenow|sharepoint|android|ios|flutter|data engineer|data scientist|musician|annotation|mentor|sales|recruiter)(\W|$)/i.test(titleLower);

    // Pure Angular, AngularJS, Ionic, or Frontend / UI / Web developer roles (as long as forbidden tech like React/Java/Python/.NET is NOT present), or jobs matching Angular in JD
    const isAngularOrFrontendRole = 
      /(^|\W)(angular|angularjs|ionic)(\W|$)/i.test(titleLower) ||
      (/(^|\W)(frontend|front-end|ui|web)\s*(developer|engineer|consultant|specialist|programmer)(\W|$)/i.test(titleLower) && !isForbiddenTech) ||
      (textToMatch.includes('angular') && !isForbiddenTech);

    if (isForbiddenTech || !isAngularOrFrontendRole) {
      const skipReason = isForbiddenTech 
        ? `Non-Angular tech in title: "${job.title}" (Disqualified)`
        : `Non-Angular role: "${job.title}" (Candidate strictly targets Angular/Frontend)`;

      db.prepare(`
        UPDATE jobs 
        SET score = 0.0, evaluation_reason = ?, status = 'skipped' 
        WHERE external_job_id = ?
      `).run(skipReason, job.external_job_id);

      job.score = 0.0;
      job.evaluation_reason = skipReason;
      job.status = 'skipped';
      console.log(`⏩ [Role Mismatch Skipped] Job #${job.id}: ${job.title} @ ${job.company} (${skipReason})`);
      continue;
    }

    // 1. Strict Experience & Seniority Guard (Candidate has 2.5 YOE: strictly target 2-3 YOE, max 1-4 YOE)
    let minExp = -1;
    let maxExp = -1;
    const expMatch = textToMatch.match(/experience:\s*(\d+)(?:\s*-\s*(\d+))?\s*(?:yr|year)/i) 
      || (job.url || '').match(/(\d+)-to-(\d+)-years/i)
      || textToMatch.match(/(\d+)\s*(?:to|-)\s*(\d+)\s*(?:years?|yrs?)/i);
    if (expMatch) {
      minExp = parseInt(expMatch[1], 10);
      if (expMatch[2]) maxExp = parseInt(expMatch[2], 10);
    }

    const hasSeniorExpRegex = /(\b[4-9]\s*to\s*\d+\s*years|\b1\d\s*to\s*\d+\s*years|\b[4-9]\s*-\s*\d+\s*yrs|\b[4-9]\+\s*yrs|\b[4-9]\+\s*years)/i.test(textToMatch + ' ' + (job.url || ''));
    const isSeniorTitle = /\b(lead|principal|architect|director|staff|manager|team lead|head)\b/i.test(titleLower);

    if (minExp >= 4 || hasSeniorExpRegex || isSeniorTitle) {
      const skipReason = isSeniorTitle 
        ? `Senior/Lead title mismatch ("${job.title}")`
        : `Experience mismatch: Requires ${minExp > 0 ? minExp : '4'}+ Yrs (Candidate has ${profile.totalYoe} YOE)`;

      db.prepare(`
        UPDATE jobs 
        SET score = 0.0, evaluation_reason = ?, status = 'skipped' 
        WHERE external_job_id = ?
      `).run(skipReason, job.external_job_id);

      job.score = 0.0;
      job.evaluation_reason = skipReason;
      job.status = 'skipped';
      console.log(`⏩ [Senior/Experience Mismatch Skipped] Job #${job.id}: ${job.title} @ ${job.company} (${skipReason})`);
      continue;
    }

    // Freshness Guard: Skip stale jobs (30+ days old / 1+ month old)
    const isStale = /30\+\s*days|30\+d\b|30\+\s*days\s*ago|1\s*month\s*ago|2\s*months\s*ago/i.test(textToMatch);
    if (isStale) {
      const skipReason = 'Stale job posting (30+ days old)';
      db.prepare(`
        UPDATE jobs 
        SET score = 0.0, evaluation_reason = ?, status = 'skipped' 
        WHERE external_job_id = ?
      `).run(skipReason, job.external_job_id);

      job.score = 0.0;
      job.evaluation_reason = skipReason;
      job.status = 'skipped';
      console.log(`⏩ [Stale Job Skipped] Job #${job.id}: ${job.title} @ ${job.company} (${skipReason})`);
      continue;
    }

    let score = 1.0; // Baseline candidate score
    const matchedKeywords: string[] = [];

    // 2. Exact 2-3 YOE Target Boost
    if (minExp >= 0 && minExp <= 3 && (maxExp >= 2 || maxExp === -1)) {
      score += 1.0;
      matchedKeywords.push('2-3 YOE (exact match)');
    }

    // 3. Workplace Type Matching (MAIN FOCUS: REMOTE, followed by Hybrid, then Onsite)
    const locLower = (job.location || '').toLowerCase();
    const isRemote = /remote|work from home|wfh|anywhere/i.test(locLower) || /remote|work from home|wfh/i.test(textToMatch);
    const isHybrid = /hybrid/i.test(locLower) || /hybrid/i.test(textToMatch);

    if (isRemote) {
      score += 1.5; // Top priority boost for remote roles
      matchedKeywords.push('remote (top priority)');
    } else if (isHybrid) {
      score += 0.8; // High priority for hybrid roles
      matchedKeywords.push('hybrid');
    }

    // 4. Primary Stack Matching (Angular, RxJS, Signals, TS, Frontend, UI Developer)
    for (const tech of primaryTech) {
      if (textToMatch.includes(tech)) {
        score += 0.8;
        if (tech === 'angular') score += 1.0; // Bonus for explicit Angular title/JD
        matchedKeywords.push(tech);
      }
    }

    // 5. Secondary Skill Matching
    for (const tech of secondaryTech) {
      if (textToMatch.includes(tech)) {
        score += 0.2;
        if (!matchedKeywords.includes(tech)) matchedKeywords.push(tech);
      }
    }

    // 6. Penalty for Unrelated Technologies
    for (const tech of unrelatedTech) {
      if (textToMatch.includes(tech)) {
        score -= 1.0;
      }
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
