import Database from 'better-sqlite3';
import { CONFIG } from '../config';

export interface JobRecord {
  id?: number;
  platform: 'naukri' | 'linkedin';
  external_job_id: string;
  title: string;
  company: string;
  location: string;
  url: string;
  jd_text: string;
  apply_type: string; // '1-click' | 'easy-apply' | 'external'
  score: number;
  evaluation_reason?: string;
  status: 'scanned' | 'evaluated' | 'applied' | 'skipped' | 'failed';
  scanned_at: string;
  applied_at?: string;
}

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!dbInstance) {
    dbInstance = new Database(CONFIG.dbPath);
    initDb(dbInstance);
  }
  return dbInstance;
}

function initDb(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      external_job_id TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      company TEXT NOT NULL,
      location TEXT NOT NULL,
      url TEXT NOT NULL,
      jd_text TEXT,
      apply_type TEXT NOT NULL DEFAULT 'unknown',
      score REAL DEFAULT 0.0,
      evaluation_reason TEXT,
      status TEXT NOT NULL DEFAULT 'scanned',
      scanned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      applied_at DATETIME
    );
  `);
}

import fs from 'fs';
import path from 'path';

export function exportJobsToJson() {
  try {
    const db = getDb();
    const allJobs = db.prepare(`SELECT * FROM jobs ORDER BY id DESC`).all();
    const jsonPath = path.join(process.cwd(), 'public', 'jobs.json');
    fs.writeFileSync(jsonPath, JSON.stringify(allJobs, null, 2));
  } catch {
    // Soft catch
  }
}

export function saveJobRecord(job: Omit<JobRecord, 'id' | 'scanned_at'>): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO jobs (platform, external_job_id, title, company, location, url, jd_text, apply_type, score, evaluation_reason, status)
    VALUES (@platform, @external_job_id, @title, @company, @location, @url, @jd_text, @apply_type, @score, @evaluation_reason, @status)
    ON CONFLICT(external_job_id) DO UPDATE SET
      title=excluded.title,
      company=excluded.company,
      location=excluded.location,
      url=excluded.url,
      jd_text=excluded.jd_text,
      apply_type=excluded.apply_type;
  `);

  const recordToInsert = {
    evaluation_reason: '',
    ...job
  };

  const info = stmt.run(recordToInsert);

  // Static JSON export for Netlify live app
  exportJobsToJson();

  return info.lastInsertRowid as number;
}

export function getUnappliedJobs(platform?: 'naukri' | 'linkedin', minScore: number = 0): JobRecord[] {
  const db = getDb();
  if (platform) {
    return db.prepare(`
      SELECT * FROM jobs WHERE platform = ? AND score >= ? AND status IN ('scanned', 'evaluated') ORDER BY score DESC
    `).all(platform, minScore) as JobRecord[];
  }
  return db.prepare(`
    SELECT * FROM jobs WHERE score >= ? AND status IN ('scanned', 'evaluated') ORDER BY score DESC
  `).all(minScore) as JobRecord[];
}

export function updateJobStatus(externalJobId: string, status: JobRecord['status']) {
  const db = getDb();
  db.prepare(`
    UPDATE jobs SET status = ?, applied_at = CURRENT_TIMESTAMP WHERE external_job_id = ?
  `).run(status, externalJobId);

  exportJobsToJson();
}
