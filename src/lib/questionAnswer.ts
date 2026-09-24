/**
 * Auto-answer JobStreet screening questions.
 *
 * Handles the mixed CSV format seen in practice:
 *   - old rows:  url, question, optionsRaw               (3 columns)
 *   - new rows:  url, question, type, optionsRaw          (4 columns)
 *     where type is "dropdown" | "radiobutton" | "checklist".
 *     "checklist" means multiple options can be selected at once —
 *     everything else is single-select.
 *
 * Strategy (unchanged from v1, just extended):
 *   1. Regex/keyword classification first — free, instant, predictable.
 *   2. Anything unclassified falls back to the Claude API, which is told
 *      whether it may pick one option or several (based on `type`).
 *
 * Run with: npx tsx answer-screening-questions-v2.ts input.csv
 * (needs: npm install csv-parse @google/generative-ai tsx)
 * Set GEMINI_API_KEY in your environment before running.
 */

import { parse } from "csv-parse/sync";
import fs, { readFileSync, writeFileSync } from "fs";
import path from "path";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { AppConfig, getConfig } from "./config";
import { getQuestionsFromSheet, ScreeningQuestionItem } from "./googleSheets";

/**
 * Gemini system instruction for CV Blaster questionnaire answering.
 * This is intentionally strict: factual profile fields must come from the
 * candidate profile; AI must not invent values, and option answers must be
 * selected from the supplied options.
 */
export const GEMINI_QUESTIONNAIRE_SYSTEM_INSTRUCTION = `
You are the questionnaire-answering engine for a job application automation tool.
Your job is to answer screening questions using ONLY the candidate profile and the
question/options supplied by the application.

NON-NEGOTIABLE RULES:
1. Never invent, guess, or substitute candidate facts.
2. For dropdown/radio/checklist questions, return only an exact option supplied by
   the application. Never return a placeholder such as "Select option", "Bulan",
   "Tahun", "Select one option", or "Select options" unless it is explicitly
   the only meaningful answer.
3. Treat the available option list as authoritative. Match the option's meaning to
   the candidate profile, but copy the selected option verbatim.
4. Date of birth is deterministic. If the profile contains a DOB in YYYY-MM-DD:
   - day = the DD component
   - month = the calendar month represented by the available option
   - year = the YYYY component
   Never choose another date/year.
5. When the question label is generic (for example "Select option"), infer the
   field from the available options and surrounding context.
6. For checklist questions, select only options supported by the candidate profile.
7. For free-text questions, answer truthfully from the profile. Do not invent
   employers, projects, certifications, metrics, tools, degrees, or achievements.
8. Return exactly what the application requests; do not add explanations around an
   option answer.
`;

const defaultSkills = [
  "JavaScript", "TypeScript", "Python", "Java", "C#", "C++", "PHP", "Go", "HTML", "CSS",
  "React", "React.js", "Next.js", "Angular", "Angular.js", "Tailwind CSS", "Bootstrap", "jQuery",
  "Framer Motion", "Three.js", "React Three Fiber", "Drei", "Node.js", "Express.js", "Fiber", "GORM",
  "REST API", "RESTful API", "Redis", "RabbitMQ", "Celery", "Asynq", "message queue", "kafka",
  "PostgreSQL", "MySQL", "Supabase", "Prisma", "SQL", "Docker", "Nginx", "PM2", "Git", "GitHub",
  "GitHub Actions", "Cloudflare", "Let's Encrypt", "Certbot", "CI/CD", "Postman", "VS Code",
  "Full Stack Development", "Backend Development", "Frontend Development", "Web Development",
  "API Development", "Database Design", "Microservices", "Object-Oriented Programming",
  "Asynchronous Programming", "Blender", "TouchDesigner", "MediaPipe", "figma", "clickup", "jira",
  "trello", "slack", "notion", "Agile", "Scrum", "Problem Solving", "Debugging"
];

export function getDynamicProfile(customConfig?: AppConfig) {
  try {
    const cfg = customConfig || getConfig();
    return {
      email: cfg.email || "candidate@example.com",
      expectedMonthlySalaryIDR: Number(cfg.expectedSalary) || 8_000_000,
      educationLevel: cfg.educationLevel || "Sarjana (S1)",
      gpa: cfg.gpa || "",
      defaultExperienceYears: Number.isFinite(Number(cfg.yearsOfExperience)) ? Number(cfg.yearsOfExperience) : 0,
      experienceByRole: [
        { keywords: ["full stack", "fullstack"], years: Number.isFinite(Number(cfg.yearsOfExperience)) ? Number(cfg.yearsOfExperience) : 0 },
        { keywords: ["backend"], years: Number.isFinite(Number(cfg.yearsOfExperience)) ? Number(cfg.yearsOfExperience) : 0 },
        { keywords: ["java developer", "java"], years: 0 },
        { keywords: ["postgresql", "postgres"], years: 0 },
        { keywords: ["web developer"], years: Number.isFinite(Number(cfg.yearsOfExperience)) ? Number(cfg.yearsOfExperience) : 0 },
        { keywords: ["software development", "programmer"], years: Number.isFinite(Number(cfg.yearsOfExperience)) ? Number(cfg.yearsOfExperience) : 0 },
        { keywords: ["sales", "marketing"], years: 0 },
      ],
      workRights: {
        id: "Saya adalah warga negara Indonesia",
        en: "I'm an Indonesian citizen",
      },
      preferredResumeHint: "Full Stack Developer - Glints TapLoker",
      resumeFallback: "Don't include a resumé",
      coverLetterPreference: "Don't include a cover letter",
      wantDefaultResume: true,
      knownTools: ["git", "svn", "subversion"],
      portfolio: cfg.portfolioUrl || "https://github.com/yogaadi",
      github: cfg.githubUrl || "https://github.com/yogaadi",
      linkedin: cfg.linkedinUrl || "https://www.linkedin.com",
      noticePeriod: cfg.noticePeriod || "Immediately",
      dateOfBirth: (() => {
        const canonical = (cfg.dateOfBirth || '').trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(canonical)) return canonical;
        const y = (cfg.dateOfBirthYear || '').trim();
        const m = (cfg.dateOfBirthMonth || '').trim().padStart(2, '0');
        const d = (cfg.dateOfBirthDay || '').trim().padStart(2, '0');
        return /^\d{4}$/.test(y) && /^(0[1-9]|1[0-2])$/.test(m) && /^(0[1-9]|[12]\d|3[01])$/.test(d) ? `${y}-${m}-${d}` : '';
      })(),
      languages: cfg.languages || '',
    };
  } catch {
    return {
      email: "candidate@example.com",
      expectedMonthlySalaryIDR: 8_000_000,
      educationLevel: "Sarjana (S1)",
      gpa: "",
      defaultExperienceYears: 0,
      experienceByRole: [
        { keywords: ["full stack", "fullstack"], years: 0 },
        { keywords: ["backend"], years: 0 },
        { keywords: ["web developer"], years: 0 },
      ],
      workRights: {
        id: "Saya adalah warga negara Indonesia",
        en: "I'm an Indonesian citizen",
      },
      preferredResumeHint: "Full Stack Developer",
      resumeFallback: "Don't include a resumé",
      coverLetterPreference: "Don't include a cover letter",
      wantDefaultResume: true,
      knownTools: ["git"],
      portfolio: "https://github.com/yogaadi",
      github: "https://github.com/yogaadi",
      linkedin: "https://www.linkedin.com",
      noticePeriod: "Immediately",
      dateOfBirth: "",
      languages: "",
    };
  }
}

export function getDynamicSkills(customConfig?: AppConfig): string[] {
  try {
    const cfg = customConfig || getConfig();
    if (cfg.skills && cfg.skills.trim().length > 0) {
      const userSkills = cfg.skills.split(',').map(s => s.trim()).filter(s => s.length > 0);
      return Array.from(new Set(userSkills));
    }
  } catch {}
  return [];
}

// ---------------------------------------------------------------------------
// 2. Types
// ---------------------------------------------------------------------------

type QuestionType = "dropdown" | "radiobutton" | "checklist" | "text" | "unknown";

interface Row {
  url: string;
  question: string;
  type: QuestionType;
  optionsRaw: string;
}

interface AnsweredRow extends Row {
  options: string[];
  answers: string[]; // one item unless type === "checklist"
  source: "regex" | "llm" | "unmatched";
}

// ---------------------------------------------------------------------------
// 3. CSV loading — tolerates both 3-column and 4-column rows
// ---------------------------------------------------------------------------

function loadRows(csvPath: string): Row[] {
  const raw = readFileSync(csvPath, "utf-8");
  const records: string[][] = parse(raw, {
    columns: false,
    skip_empty_lines: true,
    relax_column_count: true,
  });

  return records.map((cols) => {
    if (cols.length >= 4) {
      const [url, question, type, optionsRaw] = cols;
      const normalizedType: QuestionType =
        type === "dropdown" || type === "radiobutton" || type === "checklist"
          ? type
          : "unknown";
      return { url, question, type: normalizedType, optionsRaw };
    }
    // old 3-column format: no type column, assume single-select
    const [url, question, optionsRaw] = cols;
    return { url, question, type: "unknown" as QuestionType, optionsRaw };
  });
}

function splitOptions(optionsRaw: string): string[] {
  return optionsRaw
    .split("|")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

// ---------------------------------------------------------------------------
// 4. Regex-based matching (fast path, no API call)
// ---------------------------------------------------------------------------

function parseSalaryOption(opt: string): number | null {
  const match = opt.match(/Rp\s*([\d.,]+)\s*(Jt|million)?/i);
  if (!match) return null;
  const num = parseFloat(match[1].replace(",", "."));
  if (isNaN(num)) return null;
  return num * 1_000_000;
}

function closestSalaryOption(options: string[], target: number): string {
  let best = options[0];
  let bestDiff = Infinity;
  for (const opt of options) {
    const val = parseSalaryOption(opt);
    if (val === null) continue;
    const diff = Math.abs(val - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = opt;
    }
  }
  return best;
}

function closestExperienceOption(options: string[], years: number): string {
  const parseYears = (opt: string): number | null => {
    const lower = opt.toLowerCase().trim();
    if (/no experience|tidak berpengalaman|tidak ada pengalaman/i.test(lower)) return 0;
    if (/<1|< 1|less than 1|kurang dari 1/i.test(lower)) return 0.5;
    if (/10\+|more than 10|lebih dari 10/i.test(lower)) return 10;
    if (/5\s*-\s*10/i.test(lower)) return 7.5;
    if (/3\s*-\s*5/i.test(lower)) return 4;
    if (/1\s*-\s*3/i.test(lower)) return 2;
    if (/more than 5|lebih dari 5/i.test(lower)) return 6;
    const rangeMatch = lower.match(/(\d+)\s*-\s*(\d+)/);
    if (rangeMatch) {
      return (parseInt(rangeMatch[1], 10) + parseInt(rangeMatch[2], 10)) / 2;
    }
    const m = lower.match(/(\d+)\s*(thn|tahun|yr|yrs|year|years)?/);
    return m ? parseInt(m[1], 10) : null;
  };
  let best = options[0];
  let bestDiff = Infinity;
  for (const opt of options) {
    const val = parseYears(opt);
    if (val === null) continue;
    const diff = Math.abs(val - years);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = opt;
    }
  }
  return best;
}

function yearsForRole(question: string, customConfig?: AppConfig): number {
  const cfg = customConfig || getConfig();
  const profile = getDynamicProfile(cfg);
  const configuredYears = Number(cfg.yearsOfExperience);
  const defaultYrs = Number.isFinite(configuredYears) ? Math.max(0, configuredYears) : 0;
  const lower = question.toLowerCase();
  const roleMatch = lower.match(/(?:as|sebagai|for|untuk|di bidang|in)\s+(.+?)(?:\?|$)/i);
  const rolePhrase = roleMatch?.[1]?.replace(/\b(years?|tahun|experience|pengalaman|do you have|apakah kamu|are you)\b/gi, ' ').replace(/\s+/g, ' ').trim() || '';

  for (const entry of profile.experienceByRole) {
    if (entry.keywords.some((kw) => lower.includes(kw))) {
      return entry.years;
    }
  }

  // For role-specific questions, do not transform unrelated overall experience into
  // experience in that role unless the configured skills actually mention the role.
  if (rolePhrase) {
    const evidence = getDynamicSkills(cfg).join(' ').toLowerCase();
    const roleTokens = rolePhrase.split(/[^a-z0-9+#.]+/i).filter(t => t.length >= 4);
    const hasRoleEvidence = roleTokens.some(token => evidence.includes(token));
    if (!hasRoleEvidence) return 0;
  }

  return defaultYrs;
}

// ---------------------------------------------------------------------------
// 4. Deterministic rules (instant, 0 tokens)
// ---------------------------------------------------------------------------

function tryRegexAnswer(
  question: string,
  options: string[],
  type: QuestionType,
  customConfig?: AppConfig
): string[] | null {
  const cfg = customConfig || getConfig();
  const q = question.toLowerCase();
  const profile = getDynamicProfile(cfg);
  const dynamicSkills = getDynamicSkills(cfg);

  const fullName = (cfg.fullName || "Yoga Adi Saputra").trim();
  const nameParts = fullName.split(/\s+/);
  const firstName = nameParts[0] || "Yoga";
  const lastName = nameParts.slice(1).join(" ") || "Adi Saputra";

  // 1. Profil Pribadi: First Name, Last Name, Full Name
  if (/^(?:first\s*name|given\s*name|nama\s*depan)(\s*\*|\s*:)?$/i.test(q) || /(?:first|given)\s*name|nama\s*depan/i.test(q)) {
    return [firstName];
  }

  if (/^(?:last\s*name|family\s*name|surname|nama\s*belakang)(\s*\*|\s*:)?$/i.test(q) || /(?:last|family|sur)\s*name|nama\s*belakang/i.test(q)) {
    return [lastName];
  }

  if (/^(?:full\s*name|nama\s*lengkap)(\s*\*|\s*:)?$/i.test(q)) {
    return [fullName];
  }

  // 2. Kontak: Nomor Telepon, Handphone, Mobile, WhatsApp
  if (/^(?:phone|telephone|mobile|handphone|nomor\s*hp|nomor\s*telepon|nomor\s*wa|whatsapp|telp)(\s*\*|\s*:)?$/i.test(q) || /\b(phone|mobile|telepon|handphone|hp)\b/i.test(q)) {
    return [cfg.phoneNumber || "081234567890"];
  }

  // 3. Email
  if (/^(?:email|surel|alamat\s*email|e-mail)(\s*\*|\s*:)?$/i.test(q)) {
    return [cfg.email || "candidate@example.com"];
  }

  // 4. Date of birth / DOB — deterministic from profile, never guessed by Gemini.
  // The UI stores DOB as YYYY-MM-DD. The website may expose separate day/month/year dropdowns.
  const dob = (profile.dateOfBirth || cfg.dateOfBirth || '').trim();
  const dobMatch = dob.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dobMatch) {
    const [, dobYear, dobMonth, dobDay] = dobMatch;
    const monthNames: Record<string, RegExp> = {
      '01': /^(jan|january|januari|1)$/i, '02': /^(feb|february|februari|2)$/i,
      '03': /^(mar|march|maret|3)$/i, '04': /^(apr|april|4)$/i,
      '05': /^(may|mei|5)$/i, '06': /^(jun|june|juni|6)$/i,
      '07': /^(jul|july|juli|7)$/i, '08': /^(aug|august|agustus|agu|8)$/i,
      '09': /^(sep|september|9)$/i, '10': /^(oct|okt|october|oktober|10)$/i,
      '11': /^(nov|november|11)$/i, '12': /^(dec|des|december|desember|12)$/i,
    };
    const isYearQuestion = options.some(o => /^(19|20)\d{2}$/.test(o.trim())) && !options.some(o => /^(jan|feb|mar|apr|may|mei|jun|jul|aug|agu|sep|oct|okt|nov|dec|des)$/i.test(o.trim()));
    const isMonthQuestion = options.some(o => monthNames[Object.keys(monthNames).find(k => monthNames[k].test(o.trim())) || '']?.test(o.trim()) || /^(jan|feb|mar|apr|may|mei|jun|jul|agu|aug|sep|okt|oct|nov|des)/i.test(o.trim()));
    const isDayQuestion = options.length > 0 && options.every(o => /^\d{1,2}$/.test(o.trim())) && options.some(o => o.trim() === dobDay);
    const hasExplicitBirthKeyword = /birth|lahir|dob|date.*birth|tanggal.*lahir|day.*birth|hari.*lahir/i.test(q);
    // JobStreet frequently renders BOTH the real "date of birth" picker AND unrelated
    // date-range pickers (e.g. employment history start/end date) with the exact same
    // generic label "Select option" and no distinguishing text. Previously this code
    // guessed DOB for every single "Select option" dropdown, which caused the bot to
    // stuff the configured birth year/month into unrelated fields (reported as always
    // landing on the oldest option in the list, e.g. year 1926).
    // Fix: only allow the blind "Select option" guess ONCE per job application (the
    // first Bulan/Tahun/day trio encountered — almost always the real DOB field).
    // Subsequent generic "Select option" dropdowns fall through and are left for the
    // normal LLM/skip logic instead of being force-filled with birth date data.
    if (hasExplicitBirthKeyword || (q === 'select option' && !dobGuessUsedForCurrentJob)) {
      if (isYearQuestion && options.includes(dobYear)) {
        if (!hasExplicitBirthKeyword) dobGuessUsedForCurrentJob = true;
        return [dobYear];
      }
      if (isMonthQuestion) {
        const monthOpt = options.find(o => monthNames[dobMonth]?.test(o.trim()));
        if (monthOpt) {
          if (!hasExplicitBirthKeyword) dobGuessUsedForCurrentJob = true;
          return [monthOpt];
        }
      }
      if (isDayQuestion) {
        if (!hasExplicitBirthKeyword) dobGuessUsedForCurrentJob = true;
        return [dobDay];
      }
      if (options.length === 0 && /date.*birth|tanggal.*lahir|dob/i.test(q)) return [dob];
    }
  }

  // 5. Umur / Usia / Age
  if (/^(?:age|umur|usia)(\s*\*|\s*:)?$/i.test(q) || /\b(umur|usia)\b|^age$/i.test(q)) {
    if (dobMatch) {
      const birth = new Date(`${dobMatch[1]}-${dobMatch[2]}-${dobMatch[3]}T00:00:00`);
      const now = new Date();
      let age = now.getFullYear() - birth.getFullYear();
      const m = now.getMonth() - birth.getMonth();
      if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;
      return [String(age)];
    }
    return null;
  }

  // 5. Negara / Country / Kewarganegaraan
  if (/^(?:country|negara|nationality|kewarganegaraan)(\s*\*|\s*:)?$/i.test(q) || /country|negara/i.test(q)) {
    if (options.length > 0) {
      const match = options.find(o => /^(indonesia|indonesian|wni)$/i.test(o.trim())) || options.find(o => /indonesia/i.test(o));
      if (match) return [match];
    }
    return ["Indonesia"];
  }

  // 6. Kota / Lokasi / Alamat / Kode Pos
  if (/^(?:city|kota|kabupaten|lokasi|domisili)(\s*\*|\s*:)?$/i.test(q)) {
    if (options.length > 0) {
      const match = options.find(o => /jakarta/i.test(o));
      if (match) return [match];
    }
    return [cfg.location || cfg.domicile || "Jakarta"];
  }

  if (/(?:street\s*address|address|alamat|street|domisili)/i.test(q)) {
    return [cfg.domicile || "Jakarta Selatan, DKI Jakarta"];
  }

  if (/^(?:postal\s*code|zip\s*code|kode\s*pos)(\s*\*|\s*:)?$/i.test(q)) {
    return ["12190"];
  }

  // 7. Pemilihan Resume / CV (Indeed / Glints / JobStreet)
  if (options.some(o => /resume|cv|\.pdf/i.test(o))) {
    const indeedResumeMatch = options.find(o => /use your indeed resume|indeed resume/i.test(o));
    if (indeedResumeMatch) return [indeedResumeMatch];

    const pdfCandidateMatch = options.find(o => /yoga|ats_cv|\.pdf/i.test(o) && !/don't include|tidak sertakan/i.test(o));
    if (pdfCandidateMatch) return [pdfCandidateMatch];

    const anyValidResume = options.find(o => !/don't include|tidak sertakan|batal/i.test(o));
    if (anyValidResume) return [anyValidResume];
  }

  // 8. Gender / Jenis Kelamin
  if (/gender|jenis\s*kelamin/i.test(q)) {
    if (options.length > 0) {
      const match = options.find(o => /laki-laki|male|pria/i.test(o));
      if (match) return [match];
    }
    return ["Laki-laki"];
  }

  // 9. Status Pernikahan / Marital Status (e.g. Single, Belum Menikah)
  if (/marital|pernikahan|status\s*perkawinan|status\s*nikah/i.test(q) || options.some(o => /single|lajang|belum\s*menikah/i.test(o))) {
    if (options.length > 0) {
      const match = options.find(o => /^(single|lajang|belum\s*menikah)$/i.test(o.trim())) || options.find(o => /single|lajang|belum\s*menikah/i.test(o));
      if (match) return [match];
    }
    return ["Single"];
  }

  // 10. Pertanyaan Demografis / EEO / Keberagaman (Demographic, Disability, Veteran, Race, Consent)
  if (/demographic|ras|ethnicity|etnis|race|veteran|disability|disabilitas|difabel|sukarela|voluntary|declaration|persetujuan|consent/i.test(q)) {
    if (options.length > 0) {
      const declineMatch = options.find(o => /prefer not to say|decline|tidak ingin menjawab|rahasia|tidak berkenan/i.test(o));
      if (declineMatch) return [declineMatch];

      const noMatch = options.find(o => /^(no|tidak|i am not|saya bukan|tidak ada)$/i.test(o.trim())) || options.find(o => /tidak|no/i.test(o));
      if (noMatch) return [noMatch];

      const asianMatch = options.find(o => /asian|asia|indonesia/i.test(o));
      if (asianMatch) return [asianMatch];

      return [options[0]];
    }
    return ["Yes"];
  }

  // 11. Bahasa / English Language Skills
  if (/bahasa\s*inggris|english|bahasa|language/i.test(q)) {
    if (options.length > 0) {
      const match = options.find(o => /^(ya|yes|bisa|fluent|proficient|aktif|advanced)$/i.test(o.trim())) || options.find(o => /ya|yes|fluent|bisa/i.test(o));
      if (match) return [match];
    }
    return ["Ya"];
  }

  // 12. Tingkat Pendidikan Tertinggi (S1 / Sarjana / Bachelor)
  if (/tingkat\s*pendidikan|pendidikan\s*tertinggi|education\s*level|highest\s*education|kualifikasi\s*pendidikan/i.test(q)) {
    if (options.length > 0) {
      const s1Match = options.find(o => /^(s1|sarjana|bachelor|s1\s*\(sarjana\))$/i.test(o.trim())) || options.find(o => /s1|sarjana|bachelor/i.test(o));
      if (s1Match) return [s1Match];
      const generalMatch = options.find(o => o.toLowerCase().includes('s1') || o.toLowerCase().includes('sarjana') || o.toLowerCase().includes('bachelor'));
      if (generalMatch) return [generalMatch];
    }
    return ["S1"];
  }

  // 13. Open-ended Experience Questions — never manufacture a positive claim.
  if (/do you have experience|apakah anda memiliki pengalaman|apakah anda berpengalaman|do you have experince/i.test(q)) {
    const yes = options.find(o => /^(ya|yes)$/i.test(o.trim()));
    const no = options.find(o => /^(tidak|no)$/i.test(o.trim()));
    if (yes || no) {
      const evidenceText = [
        cfg.skills || '',
        profile.knownTools.join(' '),
        profile.experienceByRole.flatMap(e => e.keywords).join(' '),
      ].join(' ').toLowerCase();
      const tokens = q.replace(/[^a-z0-9+#]+/g, ' ').split(/\s+/)
        .filter(t => t.length >= 4 && !/experience|pengalaman|memiliki|mempunyai|do|you|have|apakah|kamu|punya|does|with|dengan/i.test(t));
      const supported = tokens.some(token => evidenceText.includes(token));
      if (supported && yes) return [yes];
      if (!supported && no) return [no];
      return no ? [no] : [];
    }

    const evidence = `${cfg.skills || ''} ${profile.knownTools.join(' ')}`.toLowerCase();
    if (/playwright|selenium/i.test(q) && /playwright|selenium/i.test(evidence)) {
      return ["Yes, based on the configured candidate profile."];
    }
    if (/ci\/cd|jenkins|github\s*actions|pipeline/i.test(q) && /ci\/cd|jenkins|github\s*actions|pipeline/i.test(evidence)) {
      return ["Yes, based on the configured candidate profile."];
    }
    return null;
  }

  if (/salary|gaji/.test(q) && options.length > 0) {
    return [closestSalaryOption(options, profile.expectedMonthlySalaryIDR)];
  }

  if (/qualification|kualifikasi/.test(q)) {
    const match = options.find((o) =>
      o.toLowerCase().includes(profile.educationLevel.toLowerCase()) || /s1|sarjana/i.test(o)
    );
    return match ? [match] : ["S1"];
  }

  // Pertanyaan angka tahun pengalaman (hanya jika murni menanyakan durasi angka dan bukan deskripsi project/cerita)
  const isDescriptiveQ = /jelaskan|ceritakan|sebutkan|describe|explain|project|proyek|portfolio|contoh|apa saja|why|bagaimana|how did/i.test(q);

  if (!isDescriptiveQ) {
    if (/how many years|berapa tahun|years of (work )?experience|tahun pengalaman|years of experience/i.test(q)) {
      const yrs = yearsForRole(question, cfg);
      if (options.length > 0) {
        return [closestExperienceOption(options, yrs)];
      }
      return [String(yrs)];
    }

    if (options.some(o => /thn|tahun|berpengalaman/i.test(o)) && options.length > 0) {
      return [closestExperienceOption(options, yearsForRole(question, cfg))];
    }
  }

  if (/right to work|hak.*bekerja/.test(q)) {
    const match = options.find(
      (o) => o.includes(profile.workRights.id) || o.includes(profile.workRights.en)
    );
    return match ? [match] : null;
  }

  // Truth gate for yes/no experience questions. Never let Gemini invent a positive
  // experience claim when the configured profile has no supporting evidence.
  const yesOption = options.find(o => /^(ya|yes)$/i.test(o.trim()));
  const noOption = options.find(o => /^(tidak|no)$/i.test(o.trim()));
  if ((yesOption || noOption) && /(?:do you have|does|apakah.*(?:punya|memiliki)|memiliki|mempunyai|have you).*(?:experience|pengalaman|skill|keahlian|proficiency|kemampuan)/i.test(q)) {
    const evidenceText = [
      cfg.skills || '',
      profile.knownTools.join(' '),
      profile.experienceByRole.flatMap(e => e.keywords).join(' '),
    ].join(' ').toLowerCase();
    const questionTokens = q.replace(/[^a-z0-9+#]+/g, ' ').split(/\s+/).filter(t => t.length >= 4 && !/experience|pengalaman|memiliki|memiliki|do|you|have|apakah|kamu|punya|memiliki|does|with|dengan/i.test(t));
    const evidenceMatch = questionTokens.some(token => evidenceText.includes(token));
    if (evidenceMatch && yesOption) return [yesOption];
    if (!evidenceMatch && noOption) return [noOption];
  }

  // Explicit language checklist: only select languages that the user has entered.
  if (type === 'checklist' && options.some(o => /^(english|indonesian|mandarin|japanese|french|german|korean|malaysian|bahasa indonesia|bahasa inggris)/i.test(o.trim()))) {
    const configuredLanguages = String((profile as any).languages || '').split(',').map((x: string) => x.trim().toLowerCase()).filter(Boolean);
    const matches = options.filter(o => {
      const lower = o.toLowerCase().trim();
      return configuredLanguages.some((lang: string) => lower === lang || lower.includes(lang) || lang.includes(lower));
    });
    if (matches.length > 0) return matches;
    const none = options.find(o => /none|tidak satupun|tidak ada|other \(language not listed\)/i.test(o));
    return none ? [none] : null;
  }

  // Cover letter question: options mention "cover letter" but question
  // text itself is often generic ("Select one option").
  if (options.some((o) => /cover letter|surat lamaran/i.test(o))) {
    // JobStreet: prefer writing a cover letter so the AI can tailor it to this job.
    const writeMatch = options.find((o) => /tulis.*surat lamaran|write.*cover letter|write.*letter|compose.*cover letter/i.test(o));
    if (writeMatch) return [writeMatch];
    const includeMatch = options.find((o) => /upload.*cover|unggah.*surat/i.test(o));
    if (includeMatch) return [includeMatch];
    const match = options.find((o) => o === profile.coverLetterPreference);
    return match ? [match] : [options[0]];
  }

  // Pertanyaan notice period / kapan bisa mulai bekerja (e.g. Kapan kamu dapat mulai bekerja? / Notice period)
  const isNoticePeriodQ = /mulai.*bekerja|notice.*period|start.*work|availability|kapan.*dapat|earliest.*start|ketersediaan|kapan.*bisa|join.*date|available.*to.*start|when.*start/i.test(q);
  const hasNoticePeriodOptions = options.some(o => /immediately|immediate|asap|as soon as possible|secepatnya|segera|langsung|2 weeks|1 month|2 months|2 minggu|1 bulan|2 bulan/i.test(o));

  if (isNoticePeriodQ || hasNoticePeriodOptions) {
    const pref = (profile.noticePeriod || "immediately").toLowerCase();

    if (/2\s*week|two\s*week|2\s*minggu|14\s*hari|14\s*days/i.test(pref)) {
      const match = options.find(o => /2\s*week|two\s*week|2\s*minggu|14\s*hari|14\s*days/i.test(o));
      if (match) return [match];
    } else if (/1\s*month|one\s*month|1\s*bulan|30\s*hari|30\s*days|4\s*week/i.test(pref)) {
      const match = options.find(o => /1\s*month|one\s*month|1\s*bulan|30\s*hari|30\s*days|4\s*week/i.test(o));
      if (match) return [match];
    } else if (/2\s*month|two\s*month|2\s*bulan|60\s*hari|60\s*days|8\s*week/i.test(pref)) {
      const match = options.find(o => /2\s*month|two\s*month|2\s*bulan|60\s*hari|60\s*days|8\s*week/i.test(o));
      if (match) return [match];
    } else {
      // Default: Immediately / ASAP / Secepatnya / Segera / Langsung
      const asapRegex = /immediately|immediate|asap|as soon as possible|secepatnya|segera|langsung|bisa langsung|siap segera|now|sekarang|0\s*day|0\s*hari/i;
      const match = options.find(o => asapRegex.test(o));
      if (match) return [match];
    }
    return [options[0]];
  }

  // Kesediaan kerja / Relocation / Onsite / Working Policy / Yes-No Suitability
  if (/bersedia|willing|relocate|di lokasi|onsite|on-site|hybrid|remote|wfo|wfh|policy/i.test(q) && options.some(o => /^(ya|yes|true)$/i.test(o.trim()))) {
    const match = options.find(o => /^(ya|yes|true)$/i.test(o.trim())) || options.find(o => /ya|yes/i.test(o));
    if (match) return [match];
  }

  // Resume file selection: options look like filenames (.pdf) plus a
  // "don't include" choice.
  if (options.some((o) => /\.pdf$/i.test(o))) {
    const match = options.find((o) =>
      o.toLowerCase().includes(profile.preferredResumeHint.toLowerCase())
    );
    return match ? [match] : [profile.resumeFallback];
  }

  // "Make this my default resumé" style single checkbox (checklist with
  // exactly one option).
  if (
    type === "checklist" &&
    options.length === 1 &&
    /default resum/i.test(options[0])
  ) {
    return profile.wantDefaultResume ? [options[0]] : [];
  }

  if (type === 'checklist' && /^(select options|select option|pilih opsi|pilih pilihan)$/i.test(q.trim())) {
    const none = options.find(o => /none|tidak satupun|tidak ada|none of these|tidak berlaku/i.test(o));
    if (none) return [none];
    // Generic checkbox groups are not safe for guessing. Let the caller leave optional
    // groups untouched rather than hallucinating an answer.
    return null;
  }

  // Tools/technology/skills/languages/data analysis checklist (multi-select)
  if (type === "checklist" && /revision control|tools|alat|technolog|skill|kemampuan|language|bahasa|program|analisis|data|software|aplikasi/i.test(q)) {
    const allKnown = [...profile.knownTools, ...dynamicSkills].map(s => s.toLowerCase().trim());
    const matches = options.filter((o) => {
      const optLower = o.toLowerCase().trim();
      if (/tidak satupun|none of the above|none/i.test(optLower)) return false;
      return allKnown.some((tool) => {
        if (tool.length <= 2) {
          // Exact match for short names like "C", "R", "Go"
          return optLower === tool || optLower.split(/\s+/).includes(tool);
        }
        return optLower.includes(tool) || tool.includes(optLower);
      });
    });

    if (matches.length > 0) {
      return matches;
    }
    
    // If no tools match, pick "Tidak satupun" / "None of these"
    const noneOption = options.find(o => /tidak satupun|none|tidak ada/i.test(o));
    return noneOption ? [noneOption] : null;
  }

  // Skill proficiency rating question (Glints matrix sub-questions: Tidak Berpengalaman / Dasar / Menengah / Ahli)
  if (options.some(o => /Tidak Berpengalaman|Dasar|Menengah|Ahli|NO_EXPERIENCE|BASIC|INTERMEDIATE|ADVANCED/i.test(o))) {
    const allKnown = [...profile.knownTools, ...dynamicSkills].map(s => s.toLowerCase());
    const cleanQ = q.replace(/seberapa mahir.*keahlian berikut.*-?/i, '').trim();
    const isKnown = allKnown.some(skill => cleanQ.includes(skill) || skill.includes(cleanQ));
    
    if (isKnown) {
      // Selalu pilih "Ahli" (atau ADVANCED/Expert) untuk skill yang dikuasai
      const expertMatch = options.find(o => /^(Ahli|ADVANCED|Expert)$/i.test(o.trim())) ||
                          options.find(o => /Ahli|ADVANCED|Expert/i.test(o)) ||
                          options.find(o => /Menengah|INTERMEDIATE/i.test(o));
      return expertMatch ? [expertMatch] : [options[options.length - 1]];
    } else {
      // Pilih "Dasar" untuk skill di luar profil
      const basicMatch = options.find(o => /^(Dasar|BASIC)$/i.test(o.trim())) ||
                         options.find(o => /Dasar|BASIC/i.test(o)) ||
                         options.find(o => /Tidak Berpengalaman|NO_EXPERIENCE/i.test(o));
      return basicMatch ? [basicMatch] : [options[0]];
    }
  }

  // Pertanyaan Kemahiran Bahasa Inggris / Language Proficiency (Rating 1 - 10 atau isian teks)
  if (/english|bahasa inggris|proficiency|self-rate|1 to 10|1-10|kemampuan bahasa/i.test(q)) {
    if (/1 to 10|1-10|scale|rate.*from|score/i.test(q)) {
      return ["8"];
    }
    if (options.length > 0) {
      const match = options.find(o => /fluent|mahir|proficient|advanced|professional/i.test(o));
      if (match) return [match];
    }
    return ["Proficient / Fluent (8/10)"];
  }

  // Pertanyaan GPA / IPK
  if (/gpa|ipk|grade point/i.test(q)) {
    return profile.gpa ? [profile.gpa] : null;
  }

  // Pertanyaan Gaji jika open text
  if (/salary|gaji|penghasilan/i.test(q) && (options.length === 0 || type === "text")) {
    return profile.expectedMonthlySalaryIDR > 0 ? [String(profile.expectedMonthlySalaryIDR)] : null;
  }

  // Pertanyaan Portofolio / GitHub / LinkedIn jika open text
  if (/github/i.test(q)) {
    return [profile.github || "https://github.com/yogaadi"];
  }
  if (/linkedin/i.test(q)) {
    return [profile.linkedin || "https://www.linkedin.com"];
  }
  if (/portfolio|portofolio|website|link/i.test(q) && (options.length === 0 || type === "text")) {
    return [profile.portfolio || "https://github.com/yogaadi"];
  }

  // Pertanyaan Kesiapan Mulai Bekerja (Notice Period / ASAP / Kapan Bisa Bergabung)
  if (/notice period|notice periode|asap|kapan bisa mulai|kapan bisa bergabung|join immediately|start immediately|ketersediaan mulai|kapan bersedia|available to start|waktu mulai bekerja/i.test(q)) {
    const notice = profile.noticePeriod || "Immediately";
    if (options.length > 0) {
      const match = options.find(o => /immediately|secepatnya|asap|segera|1 month|1 bulan/i.test(o));
      if (match) return [match];
    }
    if (/asap|immediately|segera/i.test(notice)) {
      return ["Saya bersedia untuk segera bergabung (ASAP / Immediately)."];
    }
    return [notice];
  }

  // Pertanyaan Tahun Pengalaman jika murni numerik
  if (/how many years|berapa tahun/i.test(q) && (options.length === 0 || type === "text")) {
    return [String(yearsForRole(question, cfg))];
  }

  return null;
}

// ---------------------------------------------------------------------------
// 5. LLM fallback for anything regex couldn't classify
// ---------------------------------------------------------------------------

function getGeminiAi(customConfig?: AppConfig): GoogleGenerativeAI | null {
  const cfg = customConfig || getConfig();
  const apiKey = (cfg.geminiApiKey || process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) return null;
  return new GoogleGenerativeAI(apiKey);
}

async function askLLM(
  question: string,
  options: string[],
  type: QuestionType,
  customConfig?: AppConfig,
  strict = false
): Promise<string[]> {
  const cfg = customConfig || getConfig();
  const profile = getDynamicProfile(cfg);
  const dynamicSkills = getDynamicSkills(cfg);

  if (type === "text" || options.length === 0) {
    const prompt = `You are answering a job application screening question on behalf of a candidate.

Candidate profile:
- Role: Full Stack Developer (Skills: ${dynamicSkills.slice(0, 15).join(', ')})
- Experience: ${profile.defaultExperienceYears} years
- Education: ${profile.educationLevel}, GPA: ${profile.gpa}
- Expected salary: Rp ${profile.expectedMonthlySalaryIDR.toLocaleString("id-ID")}
- Availability: ${profile.noticePeriod}
- Date of birth: ${profile.dateOfBirth || "not provided"}

Question: "${question}"

Reply with a concise, highly professional, direct answer (1-2 sentences maximum, or just the number/fact if it's a simple factual question). Reply in the same language as the question (Indonesian or English).`;

    try {
      const aiInstance = getGeminiAi(customConfig);
      if (aiInstance) {
        const model = aiInstance.getGenerativeModel({ model: "gemini-1.5-flash", systemInstruction: GEMINI_QUESTIONNAIRE_SYSTEM_INSTRUCTION });
        const result = await model.generateContent(prompt);
        const text = (result.response.text() || "").trim();
        if (text) return [text];
      }
    } catch {}

    if (strict) return [];

    // Smart context-aware fallback based on question intent (when AI is unavailable or offline)
    const lowerQ = question.toLowerCase();
    if (/notice|asap|join|mulai kerja|bergabung/i.test(lowerQ)) {
      const notice = profile.noticePeriod || "Immediately";
      return [/asap|immediately|segera/i.test(notice) ? "Saya bersedia untuk segera bergabung (ASAP / Immediately)." : notice];
    }
    if (/salary|gaji|penghasilan|upah|ekspektasi gaji/i.test(lowerQ)) {
      return profile.expectedMonthlySalaryIDR > 0 ? [String(profile.expectedMonthlySalaryIDR)] : [];
    }
    if (/english|bahasa inggris|rate|1 to 10|skala 1/i.test(lowerQ)) return [];
    if (/gpa|ipk/i.test(lowerQ)) return profile.gpa ? [profile.gpa] : [];
    if (/experience|tahun|lama bekerja/i.test(lowerQ)) return profile.defaultExperienceYears > 0 ? [String(profile.defaultExperienceYears)] : [];
    if (/project|proyek/i.test(lowerQ)) return [];
    if (/age|umur|usia/i.test(lowerQ)) return profile.dateOfBirth ? [] : [];
    if (/phone|telepon|hp|mobile|wa|whatsapp/i.test(lowerQ)) return [cfg.phoneNumber || "081234567890"];
    if (/name|nama/i.test(lowerQ)) return [cfg.fullName || "Yoga Adi Saputra"];
    if (/why|alasan|describe|ceritakan|jelaskan|introduce|tentang anda/i.test(lowerQ)) {
      return ["Saya memiliki keahlian dan pengalaman kerja yang relevan serta siap berkontribusi secara maksimal untuk posisi ini."];
    }
    return ["Ya"];
  }

  const multiSelect = type === "checklist";

  const prompt = `You are filling out a job application screening question on behalf of a candidate.

Candidate profile:
- Expected monthly salary: Rp ${profile.expectedMonthlySalaryIDR.toLocaleString("id-ID")}
- Education: ${profile.educationLevel}
- Experience: ${profile.experienceByRole
    .map((e) => `${e.keywords[0]}: ${e.years} years`)
    .join(", ")}; overall configured experience: ${profile.defaultExperienceYears} years.
- Role-specific experience rule: never transfer overall experience to a different job function.
  If the question asks experience AS / SEBAGAI / IN a specific role or function that is not
  explicitly supported by the profile's configured skills/role evidence, answer the lowest
  applicable experience option (prefer "No experience" / "Tidak ada pengalaman").
- Right to work: ${profile.workRights.en}
- Known tools: ${profile.knownTools.join(", ")}
- Date of birth: ${profile.dateOfBirth || "not provided"}

Question: "${question}"
Question type: ${type} (${multiSelect ? "you may choose MULTIPLE options" : "choose exactly ONE option"})
Allowed options (copy chosen ones verbatim): ${options.map((o) => `"${o}"`).join(" | ")}

Reply with ONLY the chosen option(s), copied exactly from the list. If choosing multiple, separate them with " || ". Nothing else.`;

  try {
    const aiInstance = getGeminiAi(customConfig);
    if (aiInstance) {
      const model = aiInstance.getGenerativeModel({ model: "gemini-1.5-flash", systemInstruction: GEMINI_QUESTIONNAIRE_SYSTEM_INSTRUCTION });
      const result = await model.generateContent(prompt);
      const text = (result.response.text() || "").trim();

      const picked = text.split("||").map((s: string) => s.trim()).filter(Boolean);
      const valid = picked.filter((p: string) => options.includes(p));
      if (valid.length > 0 && valid.length === picked.length) return valid;
      if (options.length > 0) {
        console.warn(`[Gemini] Rejected non-option answer for "${question}": ${text}`);
      }
    }
  } catch {}

  // In strict mode, an unresolved/invalid AI answer is unsafe: do not guess.
  if (strict) return [];

  // Smart options fallback (legacy mode only)
  const firstMatch = options.find(o => /^(ya|yes|setuju|agree|fluent|mahir|sarjana|s1|full-time|wfo|hybrid|remote|bersedia|ada|siap|sangat siap|bisa|bisa segera)$/i.test(o.trim()));
  return [firstMatch || options[0] || "Ya"];
}

// ---------------------------------------------------------------------------
// 6. In-Memory Knowledge Base Cache (Google Sheets & Local Fallback)
// ---------------------------------------------------------------------------

interface CachedQuestion {
  rawQuestion: string;
  normalized: string;
  words: Set<string>;
  type: string;
  options: string[];
  answers: string[];
}

let memoryCache: {
  timestamp: number;
  items: CachedQuestion[];
} | null = null;

export function invalidateKnowledgeBaseCache() {
  memoryCache = null;
}

export function transformQuestionsToCache(
  questions: Array<{ question: string; type?: string; options?: string; answer?: string }>
): CachedQuestion[] {
  const items: CachedQuestion[] = [];
  for (const row of questions) {
    const q = (row.question || '').trim();
    const answerRaw = (row.answer || '').trim();
    if (!q || !answerRaw) continue;

    const clean = q.toLowerCase().trim();
    const normalized = clean.replace(/[^a-z0-9]/g, '');
    const words = new Set(clean.split(/\s+/).filter(w => w.length > 2));
    const answers = answerRaw.split('||').map(a => a.trim()).filter(a => a.length > 0);
    const options = (row.options || '').split('|').map(o => o.trim()).filter(o => o.length > 0);

    items.push({
      rawQuestion: q,
      normalized,
      words,
      type: (row.type || 'radiobutton').toLowerCase().trim(),
      options,
      answers,
    });
  }
  return items;
}

export async function ensureKnowledgeBaseLoaded(customConfig?: AppConfig): Promise<CachedQuestion[]> {
  const now = Date.now();
  if (memoryCache && now - memoryCache.timestamp < 60000) {
    return memoryCache.items;
  }

  const cfg = customConfig || getConfig();

  // 1. Priority: Load from Google Sheets (Screening Questions tab)
  if (cfg.googleCredentialsJson && cfg.spreadsheetId) {
    try {
      const sheetQuestions = await getQuestionsFromSheet(false, cfg);
      if (sheetQuestions.length > 0) {
        const items = transformQuestionsToCache(sheetQuestions);
        memoryCache = { timestamp: now, items };
        return items;
      }
    } catch (e) {
      console.warn('[KnowledgeBase] Failed to fetch from Google Sheets, falling back to local CSV if available:', e);
    }
  }

  // 2. Fallback: Read local imploye-question.csv if exists
  try {
    const csvPath = path.join(process.cwd(), 'public', 'imploye-question.csv');
    if (fs.existsSync(csvPath)) {
      const content = fs.readFileSync(csvPath, 'utf8');
      const records: string[][] = parse(content, {
        columns: false,
        skip_empty_lines: true,
        relax_column_count: true,
        relax_quotes: true,
      });

      const parsed: Array<{ question: string; type: string; options: string; answer: string }> = [];
      for (let i = 1; i < records.length; i++) {
        const cols = records[i];
        if (!cols || cols.length < 2) continue;
        if (cols.length >= 4) {
          parsed.push({ question: cols[0] || '', type: cols[1] || '', options: cols[2] || '', answer: cols[3] || '' });
        } else if (cols.length === 3) {
          parsed.push({ question: cols[0] || '', type: 'radiobutton', options: cols[1] || '', answer: cols[2] || '' });
        }
      }

      const items = transformQuestionsToCache(parsed);
      memoryCache = { timestamp: now, items };
      return items;
    }
  } catch {}

  return memoryCache ? memoryCache.items : [];
}

export function getKnowledgeBase(): CachedQuestion[] {
  return memoryCache ? memoryCache.items : [];
}

// Search knowledge base cache for matching question
function getPreAnsweredQuestion(questionText: string, options: string[], cachedItems: CachedQuestion[]): string[] | null {
  if (cachedItems.length === 0) return null;
  if (/^(select option|select options|select one option|pilih opsi|pilih pilihan)$/i.test(questionText.trim())) {
    return null;
  }

  try {
    const targetClean = questionText.toLowerCase().trim();
    const targetNormalized = targetClean.replace(/[^a-z0-9]/g, '');
    const targetWords = new Set(targetClean.split(/\s+/).filter(w => w.length > 2));

    let bestMatchAnswers: string[] | null = null;
    let highestOverlap = 0;

    for (const item of cachedItems) {
      // 1. Exact Normalized Match
      const isExactMatch = targetNormalized === item.normalized;

      // 2. Substring Match
      const isSubstringMatch = !isExactMatch && targetNormalized.length > 10 && item.normalized.length > 10 &&
        (targetNormalized.includes(item.normalized) || item.normalized.includes(targetNormalized));

      // 3. Word Overlap Similarity (jika kemiripan kata >= 70%)
      let matchCount = 0;
      for (const w of item.words) {
        if (targetWords.has(w)) matchCount++;
      }
      const overlapScore = item.words.size > 0 ? matchCount / Math.max(item.words.size, targetWords.size) : 0;

      if (isExactMatch || isSubstringMatch || overlapScore >= 0.7) {
        // Untuk pertanyaan tipe text / isian bebas
        if (item.type === 'text' || options.length === 0) {
          if (isExactMatch) return item.answers;
          if (overlapScore > highestOverlap) {
            highestOverlap = overlapScore;
            bestMatchAnswers = item.answers;
          }
          continue;
        }

        // Untuk dropdown/radio/checklist, validasi apakah jawaban ada di pilihan yang tersedia
        const validAnswers = item.answers.filter(ans => 
          options.includes(ans) || options.some(o => o.toLowerCase() === ans.toLowerCase())
        );

        if (validAnswers.length > 0) {
          if (isExactMatch) return validAnswers;
          if (overlapScore > highestOverlap) {
            highestOverlap = overlapScore;
            bestMatchAnswers = validAnswers;
          }
        }
      }
    }

    if (bestMatchAnswers !== null) {
      return bestMatchAnswers;
    }
  } catch (error) {
    console.error('Failed to match pre-answered questions in memory:', error);
  }
  return null;
}

// Guards the blind "generic Select-option dropdown = date of birth" heuristic so it
// only fires once per job application. Call resetDobGuessState() right before a bot
// starts processing a new job listing (see jobstreet.ts).
let dobGuessUsedForCurrentJob = false;
export function resetDobGuessState(): void {
  dobGuessUsedForCurrentJob = false;
}

// Export answerQuestion for bot integration
export async function answerQuestion(
  question: string,
  options: string[],
  type: "dropdown" | "checklist" | "radiobutton" | "text" | "unknown",
  customConfig?: AppConfig,
  strict = false
): Promise<string[]> {
  const cfg = customConfig || getConfig();
  try {
    // 1. Deterministic profile facts MUST outrank the Knowledge Base.
    // This prevents generic labels such as "Select option" from reusing a stale
    // Sheet2 answer for a different field (especially DOB day/month/year).
    const normType = type as QuestionType;
    const regexAnswer = tryRegexAnswer(question, options, normType, cfg);
    if (regexAnswer !== null) {
      const { appendQuestionToSheet } = require('./googleSheets');
      appendQuestionToSheet(question, type, options, regexAnswer, cfg).catch(() => {});
      return regexAnswer;
    }

    // 2. Then consult the Knowledge Base, but only after deterministic profile facts.
    const cachedItems = await ensureKnowledgeBaseLoaded(cfg);
    const cachedAnswers = getPreAnsweredQuestion(question, options, cachedItems);
    if (cachedAnswers !== null) {
      return cachedAnswers;
    }

    // 3. Fallback: Ask Gemini LLM. In strict mode, unresolved questions are not guessed.
    const llmAnswer = await askLLM(question, options, normType, cfg, strict);
    const { appendQuestionToSheet } = require('./googleSheets');
    if (llmAnswer.length > 0) {
      appendQuestionToSheet(question, type, options, llmAnswer, cfg).catch(() => {});
    }
    return llmAnswer;
  } catch (err) {
    console.error(`AI failed to answer "${question}":`, err);
    if (strict) return [];
    return [options[0] || ""]; // fallback to first option
  }
}