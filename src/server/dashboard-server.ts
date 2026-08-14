import express from 'express';
import path from 'path';
import fs from 'fs';
import { getDb } from '../db/schema';
import { loadProfile } from '../config';
import { evaluateJobs } from '../engine/evaluator';
import { scanLinkedInJobs } from '../scraper/linkedin-scanner';

export function startDashboardServer(port: number = 3000) {
  const app = express();

  app.use(express.json());
  app.use(express.static(path.join(process.cwd(), 'public')));

  // GET /api/stats
  app.get('/api/stats', (req, res) => {
    try {
      const db = getDb();
      const totalScanned = (db.prepare(`SELECT COUNT(*) as c FROM jobs`).get() as any).c;
      const topMatches = (db.prepare(`SELECT COUNT(*) as c FROM jobs WHERE score >= 2.5`).get() as any).c;
      const totalApplied = (db.prepare(`SELECT COUNT(*) as c FROM jobs WHERE status = 'applied'`).get() as any).c;
      const avgScoreRow = db.prepare(`SELECT AVG(score) as avgScore FROM jobs WHERE score > 0`).get() as any;
      const avgScore = avgScoreRow && avgScoreRow.avgScore ? avgScoreRow.avgScore : 0.0;

      res.json({
        totalScanned,
        topMatches,
        totalApplied,
        avgScore
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/jobs
  app.get('/api/jobs', (req, res) => {
    try {
      const db = getDb();
      const jobs = db.prepare(`SELECT * FROM jobs ORDER BY score DESC, id DESC LIMIT 100`).all();
      res.json(jobs);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/jobs/:id
  app.delete('/api/jobs/:id', (req, res) => {
    try {
      const db = getDb();
      const { id } = req.params;
      const info = db.prepare(`DELETE FROM jobs WHERE id = ?`).run(id);
      res.json({ success: true, deletedCount: info.changes });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/profile
  app.get('/api/profile', (req, res) => {
    try {
      const profile = loadProfile();
      res.json(profile);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/answers
  app.get('/api/answers', (req, res) => {
    try {
      const answersPath = path.join(process.cwd(), 'answers.json');
      if (fs.existsSync(answersPath)) {
        const cache = JSON.parse(fs.readFileSync(answersPath, 'utf8'));
        return res.json(cache);
      }
      res.json({});
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/scan
  app.post('/api/scan', async (req, res) => {
    try {
      scanLinkedInJobs({
        query: 'Angular Developer',
        location: 'India',
        maxPages: 3,
        headless: true,
        timePosted: 'r86400'
      }).catch(err => console.error('Background Scan Error:', err));

      res.json({ message: '🚀 LinkedIn 24-hour scan launched in background!' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/evaluate
  app.post('/api/evaluate', (req, res) => {
    try {
      const evaluated = evaluateJobs();
      res.json({ message: `⚡ AI Evaluated ${evaluated.length} jobs!`, count: evaluated.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Serve SPA index.html for any unmatched route
  app.use((req, res) => {
    res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
  });

  app.listen(port, () => {
    console.log(`\n🌐 [JobOps Dashboard] Live at http://localhost:${port}`);
    console.log(`✨ Open http://localhost:${port} in your browser to view your AI Job Automation Center.`);
  });
}
