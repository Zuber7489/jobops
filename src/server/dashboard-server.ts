import express from 'express';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { getDb } from '../db/schema';
import { loadProfile, saveProfile } from '../config';
import { ensureChromeCdpRunning } from '../utils/chrome-launcher';

const recentLogs: string[] = [
  `[${new Date().toLocaleTimeString()}] 🚀 JobOps Live Automation Console initialized.`
];
const sseSubscribers: express.Response[] = [];

function broadcastLog(line: string) {
  const formattedLine = line.startsWith('[') ? line : `[${new Date().toLocaleTimeString()}] ${line}`;
  recentLogs.push(formattedLine);
  if (recentLogs.length > 500) recentLogs.shift();

  // Send SSE payload to all open web dashboard browser windows
  sseSubscribers.forEach(res => {
    try {
      res.write(`data: ${JSON.stringify({ log: formattedLine })}\n\n`);
    } catch (e) {}
  });
}

let currentChildProcess: any = null;

function stopActiveChildProcess(): boolean {
  if (currentChildProcess) {
    broadcastLog(`\n🛑 [Stop Automation] Halting active process...`);
    try {
      if (process.platform === 'win32' && currentChildProcess.pid) {
        spawn('taskkill', ['/F', '/T', '/PID', currentChildProcess.pid.toString()]);
      } else {
        currentChildProcess.kill('SIGINT');
      }
    } catch (e) {}
    currentChildProcess = null;
    return true;
  }
  return false;
}

function runCliCommand(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    stopActiveChildProcess(); // Stop any existing process first

    broadcastLog(`\n💻 Executing: npx ts-node src/index.ts ${args.join(' ')}`);
    
    const child = spawn('npx', ['ts-node', 'src/index.ts', ...args], {
      cwd: process.cwd(),
      shell: true,
      env: { ...process.env, FORCE_COLOR: '1' }
    });

    currentChildProcess = child;

    child.stdout.on('data', data => {
      const lines = data.toString().split('\n');
      lines.forEach((l: string) => {
        const clean = l.replace(/\r/g, '').trim();
        if (clean) broadcastLog(clean);
      });
    });

    child.stderr.on('data', data => {
      const lines = data.toString().split('\n');
      lines.forEach((l: string) => {
        const clean = l.replace(/\r/g, '').trim();
        if (clean && !clean.includes('ExperimentalWarning')) broadcastLog(`⚠️ ${clean}`);
      });
    });

    child.on('close', code => {
      currentChildProcess = null;
      broadcastLog(`✨ [Process Completed] Exit Code: ${code}`);
      resolve(code || 0);
    });
  });
}

export function startDashboardServer(port: number = 3000) {
  const app = express();

  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));
  app.use(express.static(path.join(process.cwd(), 'public')));

  // SSE Live Log Streaming Endpoint
  app.get('/api/logs/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    sseSubscribers.push(res);

    req.on('close', () => {
      const index = sseSubscribers.indexOf(res);
      if (index !== -1) sseSubscribers.splice(index, 1);
    });
  });

  // GET /api/logs - Initial Log History
  app.get('/api/logs', (req, res) => {
    res.json({ logs: recentLogs });
  });

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

  // DELETE /api/jobs - Bulk clear all job records
  app.delete('/api/jobs', (req, res) => {
    try {
      const db = getDb();
      const info = db.prepare(`DELETE FROM jobs`).run();
      broadcastLog(`🗑️ [Database Cleared] Removed all ${info.changes} job records.`);
      res.json({ success: true, deletedCount: info.changes, message: `🗑️ Cleared all ${info.changes} job records!` });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/jobs/:id - Delete single job
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

  // POST /api/profile
  app.post('/api/profile', (req, res) => {
    try {
      const updatedProfile = saveProfile(req.body);
      
      const answersPath = path.join(process.cwd(), 'answers.json');
      let cache: Record<string, string> = {};
      if (fs.existsSync(answersPath)) {
        try { cache = JSON.parse(fs.readFileSync(answersPath, 'utf8')); } catch (e) {}
      }

      cache['full name'] = updatedProfile.name;
      cache['first name'] = updatedProfile.name.split(' ')[0] || updatedProfile.name;
      cache['last name'] = updatedProfile.name.split(' ').slice(1).join(' ') || '';
      cache['email address'] = updatedProfile.email;
      cache['mobile phone number'] = updatedProfile.phone;
      cache['phone number'] = updatedProfile.phone;
      cache['city'] = updatedProfile.location;
      cache['location (city)'] = updatedProfile.location;
      cache['notice period'] = updatedProfile.noticePeriodDays.toString();
      cache['current ctc'] = (updatedProfile.currentCtcLpa * 100000).toString();
      cache['expected ctc'] = (updatedProfile.expectedCtcLpa * 100000).toString();
      cache['total years of professional experience'] = Math.floor(updatedProfile.totalYoe).toString();
      cache['what is your total years of experience?'] = Math.floor(updatedProfile.totalYoe).toString();
      if (updatedProfile.currentCompany) {
        cache['current company'] = updatedProfile.currentCompany;
      }

      fs.writeFileSync(answersPath, JSON.stringify(cache, null, 2), 'utf8');

      broadcastLog(`👤 [Profile Updated] Candidate: ${updatedProfile.name} (${updatedProfile.location})`);
      res.json({ message: '✅ Candidate Profile updated!', profile: updatedProfile });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/resume
  app.post('/api/resume', (req, res) => {
    try {
      const { fileName, fileData } = req.body;
      if (!fileData) {
        return res.status(400).json({ error: 'No resume file data provided.' });
      }

      const base64Data = fileData.replace(/^data:application\/pdf;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');

      const resumePdfPath = path.join(process.cwd(), 'resume.pdf');
      fs.writeFileSync(resumePdfPath, buffer);

      saveProfile({
        resumePath: resumePdfPath,
        resumeUploadPath: resumePdfPath
      });

      broadcastLog(`📄 [Resume Uploaded] Saved PDF resume file (${buffer.length} bytes) to resume.pdf`);
      res.json({ message: '✅ PDF Resume uploaded successfully!', resumePath: resumePdfPath });
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

  // POST /api/answers
  app.post('/api/answers', (req, res) => {
    try {
      const { question, answer } = req.body;
      if (!question || answer === undefined) {
        return res.status(400).json({ error: 'Question and Answer fields required.' });
      }

      const answersPath = path.join(process.cwd(), 'answers.json');
      let cache: Record<string, string> = {};
      if (fs.existsSync(answersPath)) {
        try { cache = JSON.parse(fs.readFileSync(answersPath, 'utf8')); } catch (e) {}
      }

      const normalizedKey = question.toLowerCase().trim();
      cache[normalizedKey] = answer.toString();

      fs.writeFileSync(answersPath, JSON.stringify(cache, null, 2), 'utf8');
      broadcastLog(`💾 [Knowledge Base Saved] "${question}" ➔ "${answer}"`);
      res.json({ message: `✅ Saved answer for "${question}"`, cache });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/answers/:key
  app.delete('/api/answers/:key', (req, res) => {
    try {
      const key = decodeURIComponent(req.params.key).toLowerCase().trim();
      const answersPath = path.join(process.cwd(), 'answers.json');
      let cache: Record<string, string> = {};
      if (fs.existsSync(answersPath)) {
        try { cache = JSON.parse(fs.readFileSync(answersPath, 'utf8')); } catch (e) {}
      }

      if (cache[key] !== undefined) {
        delete cache[key];
        fs.writeFileSync(answersPath, JSON.stringify(cache, null, 2), 'utf8');
        return res.json({ message: `✅ Deleted answer key: "${key}"` });
      }

      res.status(404).json({ error: 'Key not found.' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/launch-chrome - Manual or Auto Launch Chrome Debugging Browser
  app.post('/api/launch-chrome', async (req, res) => {
    try {
      const launched = await ensureChromeCdpRunning(9222);
      if (launched) {
        broadcastLog(`🌐 [Chrome Auto-Launcher] Chrome opened with --remote-debugging-port=9222`);
        res.json({ message: `✅ Chrome browser launched with debugging port 9222!` });
      } else {
        res.status(500).json({ error: `Could not auto-launch Chrome. Please launch Chrome manually.` });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Action 1: POST /api/scan
  app.post('/api/scan', async (req, res) => {
    try {
      const body = req.body || {};
      const query = body.query || 'Angular Developer';
      const location = body.location || 'India';
      const pages = body.pages ? body.pages.toString() : '3';

      res.json({ message: `🔍 Step 1: LinkedIn 24-hour Job Scan launched!` });
      await ensureChromeCdpRunning(9222);
      runCliCommand(['linkedin-scan', '--query', query, '--location', location, '--pages', pages, '-t', 'r86400']);
    } catch (err: any) {
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  // Action 2: POST /api/evaluate
  app.post('/api/evaluate', (req, res) => {
    try {
      res.json({ message: `⚡ Step 2: AI Job Evaluator launched!` });
      runCliCommand(['evaluate']);
    } catch (err: any) {
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  // Action 3: POST /api/apply-all
  app.post('/api/apply-all', async (req, res) => {
    try {
      const body = req.body || {};
      const minScore = body.minScore || '2.5';
      res.json({ message: `🤖 Step 3: AI Easy Apply Auto-Apply launched!` });
      await ensureChromeCdpRunning(9222);
      runCliCommand(['linkedin-apply', '--min-score', minScore, '--auto']);
    } catch (err: any) {
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  // Action 4: POST /api/run-all (Full Pipeline: Scan ➔ Evaluate ➔ Auto-Apply)
  app.post('/api/run-all', async (req, res) => {
    try {
      const body = req.body || {};
      const query = body.query || 'Angular Developer';
      const location = body.location || 'India';

      res.json({ message: `🔥 Full Automated Job Pipeline launched! (Scan ➔ Evaluate ➔ Auto-Apply)` });

      (async () => {
        broadcastLog(`\n🚀 [Full Automation Pipeline] Starting 3-Step Workflow...`);
        await ensureChromeCdpRunning(9222);
        await runCliCommand(['linkedin-scan', '--query', query, '--location', location, '--pages', '3', '-t', 'r86400']);
        await runCliCommand(['evaluate']);
        await runCliCommand(['linkedin-apply', '--min-score', '2.5', '--auto']);
        broadcastLog(`🎉 [Full Automation Pipeline Completed] All 3 steps finished successfully!`);
      })();
    } catch (err: any) {
      if (!res.headersSent) res.status(500).json({ error: err.message });
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
