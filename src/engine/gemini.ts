import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs';
import path from 'path';
import { CONFIG, loadProfile } from '../config';

let genAI: GoogleGenerativeAI | null = null;
const ANSWERS_FILE = path.join(process.cwd(), 'answers.json');

// ── Model Waterfall ───────────────────────────────────────────────────────────
// Priority order: highest free-tier limits first (RPM × RPD).
// Gemini 3.1 Flash Lite  = 15 RPM, 250K TPM, 500 RPD ← PRIMARY (best overall)
// Gemini 2.5 Flash Lite  = 10 RPM, 250K TPM, 500 RPD ← fallback #1
// Gemini 2.0 Flash Lite  = generous free tier         ← fallback #2
// Gemini 1.5 Flash       = very generous RPD          ← fallback #3
// Gemini flash-latest    = 24 RPD only                ← last resort
const MODEL_WATERFALL = [
  'gemini-3.1-flash-lite',               // Gemini 3.1 Flash Lite  — 15 RPM, 500 RPD ⭐ PRIMARY
  'gemini-2.5-flash-lite-preview-06-17', // Gemini 2.5 Flash Lite  — 10 RPM, 500 RPD
  'gemini-2.0-flash-lite',               // Gemini 2.0 Flash Lite  — generous free tier
  'gemini-1.5-flash-latest',             // Gemini 1.5 Flash       — very generous RPD
  'gemini-flash-latest',                 // 3.6 Flash last resort  — only 24 RPD
];

function getGeminiClient(): GoogleGenerativeAI | null {
  const apiKey = CONFIG.geminiApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    return null;
  }
  if (!genAI) {
    genAI = new GoogleGenerativeAI(apiKey);
  }
  return genAI;
}

/**
 * Calls Gemini with automatic model waterfall + exponential backoff.
 * On 429 / quota errors it tries the next model in the tier list.
 */
async function callGeminiWithFallback(client: GoogleGenerativeAI, prompt: string): Promise<string> {
  for (const modelName of MODEL_WATERFALL) {
    const model = client.getGenerativeModel({ model: modelName });
    // Exponential backoff within a single model: 0s → 6s → 12s → 24s
    for (const delay of [0, 6000, 12000, 24000]) {
      if (delay > 0) {
        console.log(`⏳ Rate limited on ${modelName}. Retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      }
      try {
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        if (modelName !== MODEL_WATERFALL[0]) {
          console.log(`🔄 [Model Fallback] Used ${modelName} (primary model rate limited)`);
        }
        return text;
      } catch (err: any) {
        const isRateLimit = err.message && (
          err.message.includes('429') ||
          err.message.includes('quota') ||
          err.message.includes('RESOURCE_EXHAUSTED')
        );
        if (!isRateLimit) {
          // Non-rate-limit error — skip to next model immediately
          console.warn(`⚠️ [${modelName}] Error: ${err.message}`);
          break;
        }
        // Rate limit — keep looping with backoff
        if (delay === 24000) {
          console.warn(`⚠️ [${modelName}] Still rate limited after max backoff. Trying next model.`);
        }
      }
    }
  }
  throw new Error('All Gemini models exhausted or rate limited. Please wait and try again.');
}

function loadAnswersCache(): Record<string, string> {
  if (fs.existsSync(ANSWERS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(ANSWERS_FILE, 'utf8'));
    } catch (e) {
      return {};
    }
  }
  return {};
}

function saveAnswerToCache(question: string, answer: string) {
  try {
    const cache = loadAnswersCache();
    const normalizedKey = question.toLowerCase().trim();
    cache[normalizedKey] = answer;
    fs.writeFileSync(ANSWERS_FILE, JSON.stringify(cache, null, 2), 'utf8');
    console.log(`💾 [Knowledge Base Saved] "${question}" ➔ "${answer}"`);
  } catch (e) {
    // Soft catch
  }
}

export async function evaluateJobWithGemini(jobTitle: string, company: string, jdText: string): Promise<{ score: number; reason: string }> {
  const client = getGeminiClient();
  if (!client) {
    return { score: 3.5, reason: 'Local Rule Engine Baseline' };
  }

  try {
    const profile = loadProfile();
    const cvPath = path.join(process.cwd(), 'cv.md');
    const cvText = fs.existsSync(cvPath) ? fs.readFileSync(cvPath, 'utf8') : JSON.stringify(profile);

    const prompt = `
You are an expert AI Job Match Evaluator analyzing an Angular Developer candidate.

Candidate Resume:
${cvText}

Target Job:
- Title: ${jobTitle}
- Company: ${company}
- Job Description: ${jdText}

Task:
Evaluate how strong of a match candidate ${profile.name} is for this role.
Rules:
- Give a high score (4.0 to 5.0) if job requires Angular, RxJS, Signals, Standalone Components, or Frontend/Fullstack skills matching candidate experience.
- Give a lower score (1.0 to 3.0) if job is unrelated (e.g., pure DevOps, Python only).

Return ONLY valid JSON:
{
  "score": <number 0.0 to 5.0>,
  "reason": "<1 short sentence summary highlighting matched skills>"
}
`;

    const text = await callGeminiWithFallback(client, prompt);

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        score: Math.min(5.0, Math.max(0.0, parseFloat(parsed.score) || 3.5)),
        reason: parsed.reason || 'Evaluated by Gemini AI'
      };
    }
  } catch (err: any) {
    console.error(`⚠️ [Gemini AI Evaluation Note]: ${err.message}`);
  }

  return { score: 3.5, reason: 'Gemini AI Rule Baseline' };
}

export async function answerQuestionWithGemini(questionText: string, jobTitle: string): Promise<string> {
  const profile = loadProfile();
  const qLower = questionText.toLowerCase().trim();

  // 1. Exact Contact & Standard Metric Direct Mappings
  if (qLower.includes('first name') || qLower.includes('given name')) {
    return profile.name.split(' ')[0] || 'Mohammad';
  }
  if (qLower.includes('last name') || qLower.includes('surname') || qLower.includes('family name')) {
    return profile.name.split(' ').slice(1).join(' ') || 'Zuber';
  }
  if (qLower.includes('full name') || qLower === 'name') {
    return profile.name;
  }
  if (qLower.includes('phone') || qLower.includes('mobile') || qLower.includes('contact number')) {
    return profile.phone;
  }
  if (qLower.includes('email') || qLower.includes('e-mail')) {
    return profile.email;
  }
  if (qLower.includes('city') || qLower.includes('location') || qLower.includes('address')) {
    return 'Pune';
  }

  // Current Compensation / CTC / Salary / Package
  if (qLower.includes('current') || qLower.includes('present') || qLower.includes('existing')) {
    if (qLower.includes('ctc') || qLower.includes('salary') || qLower.includes('compensation') || qLower.includes('package') || qLower.includes('pay')) {
      if (qLower.includes('lpa') || qLower.includes('lakh')) {
        return profile.currentCtcLpa.toString(); // 3.2
      }
      return (profile.currentCtcLpa * 100000).toString(); // 320000
    }
  }

  // Expected Compensation / CTC / Salary / Package
  if (qLower.includes('expected') || qLower.includes('desired') || qLower.includes('requirement')) {
    if (qLower.includes('ctc') || qLower.includes('salary') || qLower.includes('compensation') || qLower.includes('package') || qLower.includes('pay')) {
      if (qLower.includes('lpa') || qLower.includes('lakh')) {
        return profile.expectedCtcLpa.toString(); // 6.5
      }
      return (profile.expectedCtcLpa * 100000).toString(); // 650000
    }
  }

  if (qLower.includes('notice period') || qLower.includes('how soon can you join') || qLower.includes('start date')) {
    return profile.noticePeriodDays.toString(); // 15
  }

  // 2. Check persistent Answers Knowledge Base (answers.json) for exact match
  const cache = loadAnswersCache();
  if (cache[qLower]) {
    console.log(`🧠 [Knowledge Base Hit] "${questionText}" ➔ "${cache[qLower]}"`);
    return cache[qLower];
  }

  // 3. Dynamic Gemini AI Reasoning Engine for ALL skill, custom, and new questions
  const client = getGeminiClient();
  let aiAnswer = '';

  if (client) {
    try {
      const cvPath = path.join(process.cwd(), 'cv.md');
      const cvText = fs.existsSync(cvPath) ? fs.readFileSync(cvPath, 'utf8') : JSON.stringify(profile);

      const prompt = `
You are an expert AI Job Application Assistant reasoning on behalf of candidate ${profile.name} applying for "${jobTitle}".

Candidate Resume & Detailed Background:
${cvText}

Candidate Core Profile:
- Full Name: ${profile.name}
- Email: ${profile.email}
- Phone: ${profile.phone}
- Location: ${profile.location}
- Notice Period: ${profile.noticePeriodDays} days
- Total Professional Experience: ${Math.round(profile.totalYoe)} years
- Relevant Angular/Frontend Experience: 2 years
- Current Salary / CTC: 3.2 LPA (320000 INR)
- Expected Salary / CTC: 6.5 LPA (650000 INR)

Question asked on application form:
"${questionText}"

Instructions & Response Rules:
1. Read the candidate's resume carefully.
2. If the question asks for years of experience with a skill (e.g. Angular, Node.js, RxJS, MEAN stack, HTML, CSS):
   - Output 2 if candidate has experience with that skill in their resume.
   - Output 0 if candidate does NOT have experience with that skill in their resume (e.g. Java, Python, C++, Go, D3.js).
3. If the question is a Yes/No question (e.g. "Are you comfortable commuting?", "Are you authorized to work?"):
   - Output Yes or No based on reasonable candidate interest.
4. Output ONLY the concise final answer string value (e.g., 2, 0, 15, 320000, 650000, Yes, No). No sentences or markdown formatting.
`;

      const rawText = await callGeminiWithFallback(client, prompt);
      aiAnswer = rawText ? rawText.trim().replace(/^["']|["']$/g, '') : '';
      console.log(`🤖 [Gemini AI Reasoned] "${questionText}" ➔ "${aiAnswer}"`);
    } catch (aiErr: any) {
      console.error(`⚠️ [Gemini AI Reasoning Note]: ${aiErr.message}`);
    }
  }

  // Fallback if Gemini AI client unavailable
  if (!aiAnswer) {
    if (qLower.includes('java') && !qLower.includes('javascript')) {
      aiAnswer = '0';
    } else if (qLower.includes('sponsorship') || qLower.includes('visa')) {
      aiAnswer = 'No';
    } else if (qLower.includes('authorized') || qLower.includes('commuting') || qLower.includes('pune')) {
      aiAnswer = 'Yes';
    } else {
      aiAnswer = Math.round(profile.totalYoe).toString();
    }
  }

  saveAnswerToCache(questionText, aiAnswer);
  return aiAnswer;
}
