import { GoogleGenerativeAI } from '@google/generative-ai';
import { AppConfig, getConfig } from './config';
import { getDynamicProfile, getDynamicSkills } from './questionAnswer';

export interface EligibilityResult {
  eligible: boolean;
  confidence: number;
  reasons: string[];
  missingRequirements: string[];
}

const SYSTEM = `
You are a strict job-application eligibility gate.
Determine whether a candidate should apply to a specific job using ONLY the candidate profile and the supplied job listing.
Never invent candidate experience, skills, education, certifications, employers, tools, or achievements.
Treat missing evidence as UNKNOWN, not YES.
Return JSON only: {"eligible":true|false,"confidence":0-1,"reasons":[string],"missingRequirements":[string]}.
A job is eligible only when the candidate has sufficient documented evidence for the core requirements and there is no explicit hard mismatch.
If a core requirement cannot be verified from the profile, prefer eligible=false and explain it in missingRequirements.
Do not reject merely because an optional/preferred requirement is missing.
`;

function localEligibility(title: string, description: string, config: AppConfig): EligibilityResult {
  const text = `${title}\n${description}`.toLowerCase();
  const skills = getDynamicSkills(config).map(s => s.toLowerCase());
  const matched = skills.filter(s => s.length >= 3 && text.includes(s)).slice(0, 8);
  const education = (config.educationLevel || '').toLowerCase();
  const educationMismatch = /master|s2|doctoral|phd|doctorate/.test(text) && !/s2|master|magister|doctoral|phd/.test(education);
  const years = Number(config.yearsOfExperience) || 0;
  const yearsMatch = text.match(/(?:minimum|min\.|at least)\s*(\d+)\s*(?:years?|tahun)/i);
  const requiredYears = yearsMatch ? Number(yearsMatch[1]) : 0;
  const seniorTitle = /\b(manager|supervisor|superintendent|head|lead|director|manajer|supervisor|kepala|koordinator|coordinator)\b/i.test(title);
  const seniorityMismatch = seniorTitle && years < 2;
  if (educationMismatch || requiredYears > years || seniorityMismatch) {
    return { eligible: false, confidence: 0.9, reasons: ['Hard requirement is not supported by the configured candidate profile.'], missingRequirements: [educationMismatch ? 'Required education level is not supported by profile.' : seniorityMismatch ? 'Senior job title requires stronger documented experience in the configured profile.' : `At least ${requiredYears} years of experience required.`] };
  }
  if (matched.length === 0) {
    return { eligible: false, confidence: 0.55, reasons: ['No configured profile skill was found in the job listing.'], missingRequirements: ['Relevant skills/experience cannot be verified from the configured profile.'] };
  }
  return { eligible: true, confidence: 0.65, reasons: [`Matched profile skills: ${matched.join(', ')}`], missingRequirements: [] };
}

export async function assessJobEligibility(
  title: string,
  company: string,
  description: string,
  customConfig?: AppConfig
): Promise<EligibilityResult> {
  const config = customConfig || getConfig();
  const apiKey = (config.geminiApiKey || process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) return localEligibility(title, description, config);

  const profile = getDynamicProfile(config);
  const prompt = `Candidate profile:\n- Education: ${profile.educationLevel}\n- GPA: ${profile.gpa || 'not provided'}\n- Experience: ${profile.defaultExperienceYears} years\n- Skills: ${getDynamicSkills(config).join(', ')}\n- Domicile: ${config.domicile || 'not provided'}\n\nJob:\n- Company: ${company}\n- Title: ${title}\n- Description:\n${description.slice(0, 15000)}`;

  try {
    const ai = new GoogleGenerativeAI(apiKey);
    const model = ai.getGenerativeModel({ model: 'gemini-1.5-flash', systemInstruction: SYSTEM });
    const result = await model.generateContent(prompt);
    const raw = (result.response.text() || '').trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
    const parsed = JSON.parse(raw) as EligibilityResult;
    if (typeof parsed.eligible === 'boolean' && Number.isFinite(Number(parsed.confidence))) {
      return { eligible: parsed.eligible && Number(parsed.confidence) >= 0.75, confidence: Number(parsed.confidence), reasons: Array.isArray(parsed.reasons) ? parsed.reasons.slice(0, 6) : [], missingRequirements: Array.isArray(parsed.missingRequirements) ? parsed.missingRequirements.slice(0, 6) : [] };
    }
  } catch (e) {
    console.warn('[Eligibility] Gemini assessment failed; using conservative local gate.', e);
  }
  return localEligibility(title, description, config);
}
