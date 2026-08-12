import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs';
import path from 'path';
import { CONFIG, loadProfile } from '../config';

let genAI: GoogleGenerativeAI | null = null;
const ANSWERS_FILE = path.join(process.cwd(), 'answers.json');

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

function getBestModel(client: GoogleGenerativeAI) {
  // Official active model aliases for Gemini API
  return client.getGenerativeModel({ model: 'gemini-flash-latest' });
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

    const model = getBestModel(client);

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

    let text = '';
    try {
      const result = await model.generateContent(prompt);
      text = result.response.text();
    } catch (modelErr) {
      const proModel = client.getGenerativeModel({ model: 'gemini-pro-latest' });
      const result = await proModel.generateContent(prompt);
      text = result.response.text();
    }

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

  // 1. Check persistent Answers Knowledge Base (answers.json)
  const cache = loadAnswersCache();
  if (cache[qLower]) {
    console.log(`🧠 [Knowledge Base Hit] "${questionText}" ➔ "${cache[qLower]}"`);
    return cache[qLower];
  }

  // Check fuzzy key match in cache
  for (const [key, val] of Object.entries(cache)) {
    if (qLower.includes(key) || key.includes(qLower)) {
      console.log(`🧠 [Knowledge Base Fuzzy Match] "${questionText}" ➔ "${val}"`);
      return val;
    }
  }

  // 2. Pattern Matching for Standard Profile Metrics
  let computedAnswer = '';

  if (qLower.includes('in inr') || qLower.includes('compensation in inr') || qLower.includes('annual ctc in inr')) {
    computedAnswer = (profile.expectedCtcLpa * 100000).toString(); // e.g. 650000
  } else if (qLower.includes('current annual ctc') || qLower.includes('current ctc') || qLower.includes('present ctc')) {
    computedAnswer = profile.currentCtcLpa.toString(); // 3.2
  } else if (qLower.includes('expected annual ctc') || qLower.includes('expected ctc') || qLower.includes('salary expectation')) {
    computedAnswer = profile.expectedCtcLpa.toString(); // 6.5
  } else if (qLower.includes('notice period') || qLower.includes('how soon can you join') || qLower.includes('start date')) {
    computedAnswer = profile.noticePeriodDays.toString(); // 15
  } else if (qLower.includes('java') && !qLower.includes('javascript')) {
    computedAnswer = '0';
  } else if (qLower.includes('angular') || qLower.includes('angularjs') || qLower.includes('rxjs') || qLower.includes('typescript')) {
    computedAnswer = Math.floor(profile.totalYoe).toString(); // 2
  } else if (qLower.includes('sponsorship') || qLower.includes('visa')) {
    computedAnswer = 'No';
  } else if (qLower.includes('authorized') || qLower.includes('legally authorized') || qLower.includes('commuting') || qLower.includes('pune')) {
    computedAnswer = 'Yes';
  } else if (qLower.includes('experience') || qLower.includes('years') || qLower.includes('yoe')) {
    computedAnswer = Math.floor(profile.totalYoe).toString(); // 2
  }

  if (computedAnswer) {
    saveAnswerToCache(questionText, computedAnswer);
    return computedAnswer;
  }

  // 3. Fallback to Gemini AI Generation & persist result
  const client = getGeminiClient();
  if (!client) {
    computedAnswer = Math.floor(profile.totalYoe).toString();
    saveAnswerToCache(questionText, computedAnswer);
    return computedAnswer;
  }

  try {
    const cvPath = path.join(process.cwd(), 'cv.md');
    const cvText = fs.existsSync(cvPath) ? fs.readFileSync(cvPath, 'utf8') : JSON.stringify(profile);

    const model = getBestModel(client);

    const prompt = `
You are an AI assistant completing a job application question for ${profile.name} applying for "${jobTitle}".

Candidate Resume & Details:
${cvText}
Notice Period: ${profile.noticePeriodDays} days
Total YOE: ${profile.totalYoe} years
Current CTC: ${profile.currentCtcLpa} LPA
Expected CTC: ${profile.expectedCtcLpa} LPA
Location: ${profile.location}

Question:
"${questionText}"

Task:
Provide a clean numeric or 1-word answer (e.g., 2, 3.2, 6.5, 650000, 15, Yes, No).
Output ONLY the final answer value.
`;

    let text = '';
    try {
      const result = await model.generateContent(prompt);
      text = result.response.text();
    } catch (modelErr) {
      const proModel = client.getGenerativeModel({ model: 'gemini-pro-latest' });
      const result = await proModel.generateContent(prompt);
      text = result.response.text();
    }

    computedAnswer = text.trim().replace(/^["']|["']$/g, '');
    saveAnswerToCache(questionText, computedAnswer);
    return computedAnswer;
  } catch (err: any) {
    computedAnswer = Math.floor(profile.totalYoe).toString();
    saveAnswerToCache(questionText, computedAnswer);
    return computedAnswer;
  }
}
