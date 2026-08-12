import { getDb, JobRecord } from '../db/schema';
import { loadProfile, CONFIG } from '../config';
import { evaluateJobWithGemini } from './gemini';

export async function evaluateJobs(forceAll: boolean = true): Promise<JobRecord[]> {
  const profile = loadProfile();
  const db = getDb();

  const useGemini = Boolean(CONFIG.geminiApiKey && CONFIG.geminiApiKey !== 'your_gemini_api_key_here');
  console.log(`\n🤖 Engine Mode: ${useGemini ? 'Gemini 1.5 Flash AI' : 'Local Rule Engine'}`);

  const whereClause = forceAll ? `WHERE status IN ('scanned', 'evaluated')` : `WHERE status = 'scanned'`;
  const jobsToEvaluate = db.prepare(`SELECT * FROM jobs ${whereClause}`).all() as JobRecord[];

  console.log(`🧠 [Evaluator Engine] Evaluating ${jobsToEvaluate.length} jobs against candidate profile (${profile.name})...\n`);

  const userSkills = profile.skills.map(s => s.toLowerCase());
  const evaluatedJobs: JobRecord[] = [];

  for (const job of jobsToEvaluate) {
    let score = 2.5;
    let reason = '';

    if (useGemini) {
      const geminiResult = await evaluateJobWithGemini(job.title, job.company, job.jd_text);
      score = geminiResult.score;
      reason = `[Gemini AI] ${geminiResult.reason}`;
    } else {
      const textToMatch = `${job.title} ${job.company} ${job.jd_text}`.toLowerCase();
      const matchedSkills = userSkills.filter(skill => textToMatch.includes(skill));

      if (textToMatch.includes('angular')) score += 1.5;
      if (textToMatch.includes('rxjs')) score += 0.5;
      if (textToMatch.includes('signals')) score += 0.5;
      if (textToMatch.includes('typescript')) score += 0.5;
      score = Math.min(5.0, score);

      reason = matchedSkills.length > 0 ? `Matched skills: ${matchedSkills.join(', ')}` : 'Basic title match';
    }

    db.prepare(`
      UPDATE jobs 
      SET score = ?, evaluation_reason = ?, status = 'evaluated' 
      WHERE external_job_id = ?
    `).run(score, reason, job.external_job_id);

    job.score = score;
    job.evaluation_reason = reason;
    job.status = 'evaluated';
    evaluatedJobs.push(job);

    console.log(`⭐ [Job #${job.id}] ${job.title} at ${job.company} -> Score: ${score.toFixed(1)}/5.0 (${reason})`);
  }

  console.log(`\n✅ [Evaluation Completed] Evaluated ${evaluatedJobs.length} jobs.`);
  return evaluatedJobs;
}
