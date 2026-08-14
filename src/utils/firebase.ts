import http from 'http';
import https from 'https';
import { JobRecord } from '../db/schema';
import { CONFIG } from '../config';

/**
 * Syncs a single job record to Firebase Firestore via Firebase REST API
 * (No heavy npm dependencies required)
 */
export async function syncJobToFirebase(job: JobRecord): Promise<boolean> {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) {
    // Firebase not configured in .env, skip silently
    return false;
  }

  try {
    const docId = job.external_job_id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/jobs/${docId}`;

    const fieldsPayload: Record<string, any> = {
      external_job_id: { stringValue: job.external_job_id || '' },
      title: { stringValue: job.title || '' },
      company: { stringValue: job.company || '' },
      location: { stringValue: job.location || '' },
      url: { stringValue: job.url || '' },
      apply_type: { stringValue: job.apply_type || '' },
      platform: { stringValue: job.platform || 'linkedin' },
      score: { doubleValue: typeof job.score === 'number' ? job.score : 0.0 },
      evaluation_reason: { stringValue: job.evaluation_reason || '' },
      status: { stringValue: job.status || 'scanned' },
      scanned_at: { stringValue: job.scanned_at || new Date().toISOString() },
      applied_at: { stringValue: job.applied_at || '' }
    };

    const bodyData = JSON.stringify({ fields: fieldsPayload });

    await new Promise((resolve, reject) => {
      const req = https.request(url, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyData)
        }
      }, (res) => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`🔥 [Firebase Sync] Synced job ${job.external_job_id} to Firestore`);
          resolve(true);
        } else {
          resolve(false);
        }
      });

      req.on('error', (err) => resolve(false));
      req.write(bodyData);
      req.end();
    });

    return true;
  } catch (err: any) {
    console.error(`⚠️ [Firebase Sync Error]: ${err.message}`);
    return false;
  }
}

export async function syncAllExistingJobsToFirebase(): Promise<number> {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) return 0;

  const { getDb } = require('../db/schema');
  const db = getDb();
  const allJobs: JobRecord[] = db.prepare(`SELECT * FROM jobs`).all() as JobRecord[];

  console.log(`🔥 [Firebase Sync] Syncing ${allJobs.length} existing local jobs to Firestore...`);
  let synced = 0;
  for (const j of allJobs) {
    const success = await syncJobToFirebase(j);
    if (success) synced++;
  }
  console.log(`✅ [Firebase Sync] Successfully synced ${synced}/${allJobs.length} jobs to Firebase Firestore.`);
  return synced;
}

/**
 * Deletes a single job document from Firebase Firestore
 */
export async function deleteJobFromFirebase(externalJobId: string): Promise<boolean> {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) return false;

  try {
    const docId = externalJobId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/jobs/${docId}`;

    await new Promise((resolve) => {
      const req = https.request(url, { method: 'DELETE' }, (res) => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`🗑️ [Firebase Sync] Deleted job ${externalJobId} from Firestore`);
          resolve(true);
        } else {
          resolve(false);
        }
      });
      req.on('error', () => resolve(false));
      req.end();
    });

    return true;
  } catch (err: any) {
    console.error(`⚠️ [Firebase Delete Error]: ${err.message}`);
    return false;
  }
}

/**
 * Syncs a Q&A pair to Firebase Firestore 'answers' collection
 */
export async function syncAnswerToFirebase(question: string, answer: string): Promise<boolean> {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) return false;

  try {
    const docId = Buffer.from(question.toLowerCase().trim()).toString('hex').substring(0, 50);
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/answers/${docId}`;

    const bodyData = JSON.stringify({
      fields: {
        question: { stringValue: question },
        answer: { stringValue: answer },
        updated_at: { stringValue: new Date().toISOString() }
      }
    });

    await new Promise((resolve) => {
      const req = https.request(url, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyData)
        }
      }, (res) => resolve(res.statusCode && res.statusCode < 300));
      req.on('error', () => resolve(false));
      req.write(bodyData);
      req.end();
    });

    return true;
  } catch (err: any) {
    return false;
  }
}

/**
 * Deletes a Q&A pair from Firebase Firestore 'answers' collection
 */
export async function deleteAnswerFromFirebase(question: string): Promise<boolean> {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) return false;

  try {
    const docId = Buffer.from(question.toLowerCase().trim()).toString('hex').substring(0, 50);
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/answers/${docId}`;

    await new Promise((resolve) => {
      const req = https.request(url, { method: 'DELETE' }, (res) => resolve(res.statusCode && res.statusCode < 300));
      req.on('error', () => resolve(false));
      req.end();
    });

    return true;
  } catch {
    return false;
  }
}

/**
 * Syncs candidate profile and parsed resume text to Firebase Firestore 'candidate_profile' collection
 */
export async function syncCandidateProfileToFirebase(profileData: any, parsedResumeText: string = ''): Promise<boolean> {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) return false;

  try {
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/candidate_profile/details`;

    const bodyData = JSON.stringify({
      fields: {
        name: { stringValue: profileData.name || '' },
        email: { stringValue: profileData.email || '' },
        phone: { stringValue: profileData.phone || '' },
        totalYoe: { doubleValue: Number(profileData.totalYoe || 0) },
        relevantYoe: { doubleValue: Number(profileData.relevantYoe || 0) },
        currentCtcLpa: { doubleValue: Number(profileData.currentCtcLpa || 0) },
        expectedCtcLpa: { doubleValue: Number(profileData.expectedCtcLpa || 0) },
        noticePeriodDays: { integerValue: String(profileData.noticePeriodDays || 15) },
        location: { stringValue: profileData.location || '' },
        currentCompany: { stringValue: profileData.currentCompany || '' },
        resume_text: { stringValue: parsedResumeText || '' },
        updated_at: { stringValue: new Date().toISOString() }
      }
    });

    await new Promise((resolve) => {
      const req = https.request(url, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyData)
        }
      }, (res) => resolve(res.statusCode && res.statusCode < 300));
      req.on('error', () => resolve(false));
      req.write(bodyData);
      req.end();
    });

    return true;
  } catch (err: any) {
    return false;
  }
}

export async function syncAllAnswersToFirebase(): Promise<number> {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) return 0;

  const fs = require('fs');
  const path = require('path');
  const answersPath = path.join(process.cwd(), 'answers.json');
  if (!fs.existsSync(answersPath)) return 0;

  try {
    const cache = JSON.parse(fs.readFileSync(answersPath, 'utf8'));
    let synced = 0;
    for (const [q, a] of Object.entries(cache)) {
      const ok = await syncAnswerToFirebase(q, String(a));
      if (ok) synced++;
    }
    console.log(`🧠 [Firebase Sync] Synced ${synced} Q&A knowledge base entries to Firestore.`);
    return synced;
  } catch {
    return 0;
  }
}
