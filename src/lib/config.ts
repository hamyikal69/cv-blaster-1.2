import fs from 'fs';
import path from 'path';

export interface AppConfig {
  spreadsheetId: string;
  sheetName: string;
  questionsSheetName?: string;
  googleCredentialsJson: string;
  searchKeywords: string;
  location: string;
  minSalary: string;
  limitPerDay: number;
  limitMode?: 'shared' | 'per_platform';
  limitGlints?: number;
  limitJobstreet?: number;
  limitLinkedin?: number;
  limitIndeed?: number;
  enableGlints: boolean;
  enableJobstreet: boolean;
  enableLinkedin: boolean;
  enableIndeed: boolean;
  indeedNoJobTitleFilter?: boolean;
  debugTest: boolean;
  concurrency: number;
  useSystemChrome?: boolean;
  customChromePath?: string;
  noticePeriod: string;
  // Candidate Profile Fields
  fullName: string;
  email: string;
  expectedSalary: number;
  educationLevel: string;
  gpa: string;
  yearsOfExperience: number;
  skills: string;
  portfolioUrl: string;
  githubUrl: string;
  linkedinUrl: string;
  phoneNumber: string;
  domicile: string;
  /** Canonical DOB. YYYY-MM-DD when all parts are known. */
  dateOfBirth: string;
  /** Individual DOB fields are persisted so partial edits survive. */
  dateOfBirthDay?: string;
  dateOfBirthMonth?: string;
  dateOfBirthYear?: string;
  /** Optional explicit language evidence used for questionnaire checklists. */
  languages?: string;
  geminiApiKey?: string;
}

const CONFIG_DIR = process.env.APP_USER_DATA || process.cwd();
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export const DEFAULT_CONFIG: AppConfig = {
  spreadsheetId: '',
  sheetName: 'Sheet1',
  questionsSheetName: 'Sheet2',
  googleCredentialsJson: '',
  geminiApiKey: '',
  searchKeywords: '',
  location: '',
  minSalary: '',
  limitPerDay: 50,
  limitMode: 'shared',
  limitGlints: 20,
  limitJobstreet: 20,
  limitLinkedin: 20,
  limitIndeed: 20,
  enableGlints: true,
  enableJobstreet: true,
  enableLinkedin: true,
  enableIndeed: true,
  indeedNoJobTitleFilter: false,
  debugTest: false,
  concurrency: 2,
  useSystemChrome: true,
  customChromePath: '',
  noticePeriod: 'Immediately',
  fullName: '',
  email: '',
  expectedSalary: 0,
  educationLevel: 'Sarjana (S1)',
  gpa: '',
  yearsOfExperience: 0,
  skills: '',
  portfolioUrl: '',
  githubUrl: '',
  linkedinUrl: '',
  phoneNumber: '',
  domicile: '',
  dateOfBirth: '',
  dateOfBirthDay: '',
  dateOfBirthMonth: '',
  dateOfBirthYear: '',
  languages: '',
};


const MAX_APPLICATION_LIMIT = 50;

function clampApplicationLimit(value: unknown, fallback = 50): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(MAX_APPLICATION_LIMIT, Math.trunc(parsed)));
}

function normalizeDateOfBirth(config: AppConfig): AppConfig {
  let year = (config.dateOfBirthYear || '').trim();
  let month = (config.dateOfBirthMonth || '').trim().padStart(2, '0');
  let day = (config.dateOfBirthDay || '').trim().padStart(2, '0');

  const canonical = (config.dateOfBirth || '').trim();
  const match = canonical.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    year = year || match[1];
    month = month || match[2];
    day = day || match[3];
  }

  const validYear = /^\d{4}$/.test(year);
  const validMonth = /^(0[1-9]|1[0-2])$/.test(month);
  const validDay = /^(0[1-9]|[12]\d|3[01])$/.test(day);
  const normalized: AppConfig = {
    ...config,
    dateOfBirthYear: validYear ? year : '',
    dateOfBirthMonth: validMonth ? month : '',
    dateOfBirthDay: validDay ? day : '',
  };

  normalized.dateOfBirth = validYear && validMonth && validDay
    ? `${year}-${month}-${day}`
    : '';

  return normalized;
}

function normalizeConfigValues(config: AppConfig): AppConfig {
  const normalized: AppConfig = {
    ...config,
    limitPerDay: clampApplicationLimit(config.limitPerDay, 50),
    limitGlints: clampApplicationLimit(config.limitGlints ?? 20, 20),
    limitJobstreet: clampApplicationLimit(config.limitJobstreet ?? 20, 20),
    limitLinkedin: clampApplicationLimit(config.limitLinkedin ?? 20, 20),
    limitIndeed: clampApplicationLimit(config.limitIndeed ?? 20, 20),
  };
  return normalizeDateOfBirth(normalized);
}

// In-memory runtime fallback for serverless environments
let memoryConfig: AppConfig | null = null;

export function getConfig(override?: Partial<AppConfig>): AppConfig {
  let base = DEFAULT_CONFIG;

  if (memoryConfig) {
    base = memoryConfig;
  } else {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const data = fs.readFileSync(CONFIG_PATH, 'utf8');
        const parsed = JSON.parse(data);
        const resolved = normalizeConfigValues({ ...DEFAULT_CONFIG, ...parsed });
        memoryConfig = resolved;
        base = resolved;
      }
    } catch {
      // Readonly / serverless environment fallback
    }
  }

  if (override && Object.keys(override).length > 0) {
    const merged = { ...base };
    for (const [key, value] of Object.entries(override)) {
      if (value !== undefined && value !== null) {
        (merged as any)[key] = value;
      }
    }
    return normalizeConfigValues(merged);
  }

  return base;
}

export function saveConfig(config: Partial<AppConfig>): AppConfig {
  const current = getConfig();
  const updated = normalizeConfigValues({ ...current, ...config });
  memoryConfig = updated;

  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2), 'utf8');
  } catch (error) {
    // In serverless / read-only environments, writing to disk fails silently while memoryConfig holds the state
    console.warn('Filesystem is read-only (serverless mode). Config saved in memory.');
  }

  return updated;
}
