import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import yaml from 'yaml';

dotenv.config();

export interface UserProfile {
  name: string;
  email: string;
  phone: string;
  totalYoe: number;
  relevantYoe: number;
  currentCtcLpa: number;
  expectedCtcLpa: number;
  noticePeriodDays: number;
  location: string;
  skills: string[];
  resumePath: string;
  resumeUploadPath?: string; // Optional: Path to PDF resume for auto-upload on LinkedIn Easy Apply
  currentCompany?: string;
}

export const CONFIG = {
  cdpPort: parseInt(process.env.CDP_PORT || '9222', 10),
  chromeExecutablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  userDataDir: process.env.CHROME_USER_DATA_DIR || path.join(process.cwd(), '.chrome-user-data'),
  dbPath: process.env.DB_PATH || path.join(process.cwd(), 'jobops.sqlite'),
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  minScoreThreshold: parseFloat(process.env.MIN_SCORE_THRESHOLD || '3.5'),
  firebaseApiKey: process.env.FIREBASE_API_KEY || '',
  firebaseAuthDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID || '',
  firebaseStorageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
  firebaseMessagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
  firebaseAppId: process.env.FIREBASE_APP_ID || '',
  firebaseMeasurementId: process.env.FIREBASE_MEASUREMENT_ID || ''
};

export function loadProfile(profilePath: string = path.join(process.cwd(), 'profile.yml')): UserProfile {
  if (!fs.existsSync(profilePath)) {
    // Return sensible defaults if profile.yml does not exist yet
    return {
      name: 'Candidate',
      email: 'candidate@example.com',
      phone: '9876543210',
      totalYoe: 5,
      relevantYoe: 4,
      currentCtcLpa: 15,
      expectedCtcLpa: 20,
      noticePeriodDays: 30,
      location: 'Pune',
      skills: ['Angular', 'RxJS', 'NgRx', 'TypeScript', 'Signals', 'JavaScript', 'HTML', 'CSS'],
      resumePath: path.join(process.cwd(), 'resume.pdf')
    };
  }

  const fileContent = fs.readFileSync(profilePath, 'utf8');
  return yaml.parse(fileContent) as UserProfile;
}

export function saveProfile(updatedFields: Partial<UserProfile>, profilePath: string = path.join(process.cwd(), 'profile.yml')): UserProfile {
  const currentProfile = loadProfile(profilePath);
  const newProfile = { ...currentProfile, ...updatedFields };
  fs.writeFileSync(profilePath, yaml.stringify(newProfile), 'utf8');
  return newProfile;
}
