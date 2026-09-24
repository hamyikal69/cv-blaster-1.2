import { GoogleGenerativeAI } from '@google/generative-ai';
import { AppConfig, getConfig } from './config';
import { getDynamicProfile, getDynamicSkills } from './questionAnswer';

export interface EligibilityResult {
  eligible: boolean;
  confidence: number;
  reasons: string[];
  missingRequirements: string[];
  source?: 'gemini' | 'local-fallback';
}

const SYSTEM = `
You are an experienced Indonesian recruiter acting as a job-application eligibility gate.
Compare the CANDIDATE PROFILE against the JOB LISTING and decide whether this specific candidate
should apply, the way a thoughtful recruiter would — not a keyword scanner.

Rules:
1. Read the full job description, not just the title. Infer the REAL core requirements (hard
   skills, minimum years of experience, education level, domicile/location constraints, language
   requirements, on-site vs remote, salary range) from the text itself.
2. Distinguish HARD requirements (explicitly required, "wajib", "minimum", "required") from SOFT/
   preferred ones ("nilai plus", "diutamakan", "preferred", "nice to have"). Only reject for hard
   requirement mismatches.
3. Related/transferable skills and adjacent job titles count as partial evidence — e.g. "Admin
   Gudang" experience is relevant evidence for "Staff Logistik", "warehouse operator" is relevant
   for "warehouse supervisor" if years roughly line up. Do not reject purely because the exact
   keyword string is missing; reason about semantic/domain overlap instead of literal substring
   matching.
4. Never invent candidate experience, skills, education, certifications, employers, tools,
   languages, or achievements that are not present in the candidate profile below.
5. Treat a requirement as UNKNOWN (not automatically a fail) if the job listing does not clearly
   state it as mandatory, or if the profile is silent about something the listing only lists as
   "preferred".
6. Weigh domicile/location: if the job requires being based in a specific city/region and the
   candidate's domicile clearly differs (and no "remote"/"WFH" signal exists), that is a hard
   mismatch.
7. Weigh years of experience conservatively but fairly: entry-level/junior/"fresh graduate" job
   postings should not be rejected for "insufficient experience".
8. confidence must reflect how well-evidenced your decision is: 0.9+ only when the match/mismatch
   is unambiguous and explicit in the text; 0.5-0.7 when reasoning from partial/adjacent evidence;
   below 0.5 when the listing is too vague to judge confidently (in that case prefer eligible=true
   with a note in missingRequirements, unless there is an explicit hard blocker).

Return STRICT JSON only, no prose before or after, no markdown code fences:
{"eligible":true|false,"confidence":0-1,"reasons":[string],"missingRequirements":[string]}
`;

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9+#.]+/g) || [];
}

function localEligibility(title: string, description: string, config: AppConfig): EligibilityResult {
  const text = `${title}\n${description}`.toLowerCase();
  const tokens = new Set(tokenize(text));
  const skillList = getDynamicSkills(config).map(s => s.trim()).filter(Boolean);
  const matched: string[] = [];
  for (const skill of skillList) {
    const skillTokens = tokenize(skill);
    if (skillTokens.length === 0) continue;
    // Whole-word / whole-phrase match instead of naive substring (avoids false positives like
    // a 2-letter skill "es" matching inside unrelated words).
    const isPhraseMatch = skillTokens.length > 1 && text.includes(skill.toLowerCase());
    const isWordMatch = skillTokens.length === 1 && tokens.has(skillTokens[0]);
    if (isPhraseMatch || isWordMatch) matched.push(skill);
  }
  const matchRatio = skillList.length > 0 ? matched.length / skillList.length : 0;

  const education = (config.educationLevel || '').toLowerCase();
  const educationMismatch = /\b(s2|master|magister|doctoral|phd|doctorate)\b/.test(text) && !/s2|master|magister|doctoral|phd/.test(education);
  const years = Number(config.yearsOfExperience) || 0;
  const yearsMatch = text.match(/(?:minimum|min\.|at least|minimal)\s*(\d+)\s*(?:years?|tahun)/i);
  const requiredYears = yearsMatch ? Number(yearsMatch[1]) : 0;
  const seniorTitle = /\b(manager|supervisor|superintendent|head|lead|director|manajer|supervisor|kepala|koordinator|coordinator)\b/i.test(title);
  const seniorityMismatch = seniorTitle && years < 2 && requiredYears === 0;

  if (educationMismatch || requiredYears > years || seniorityMismatch) {
    return {
      eligible: false,
      confidence: 0.85,
      source: 'local-fallback',
      reasons: ['Hard requirement is not supported by the configured candidate profile (local fallback gate — Gemini was unavailable for this job).'],
      missingRequirements: [
        educationMismatch
          ? 'Required education level is not supported by profile.'
          : seniorityMismatch
            ? 'Senior job title requires stronger documented experience in the configured profile.'
            : `At least ${requiredYears} years of experience required.`,
      ],
    };
  }

  // Confidence now scales with how much of the configured skill list actually shows up, instead
  // of a flat fixed number for every job — a much weaker/stronger match now reads differently.
  if (skillList.length > 0 && matchRatio === 0) {
    return {
      eligible: false,
      confidence: 0.5,
      source: 'local-fallback',
      reasons: ['No configured profile skill was found in the job listing (local fallback gate — Gemini was unavailable for this job).'],
      missingRequirements: ['Relevant skills/experience cannot be verified from the configured profile.'],
    };
  }
  const confidence = Math.min(0.75, 0.5 + matchRatio * 0.35);
  return {
    eligible: true,
    confidence,
    source: 'local-fallback',
    reasons: [matched.length > 0 ? `Matched profile skills: ${matched.join(', ')}` : 'No hard mismatch detected; skill list not configured to verify further.'],
    missingRequirements: [],
  };
}

/** Pull out the first well-formed JSON object from a model response, tolerating any prose,
 * markdown fences, or trailing commentary the model adds around it. The previous version only
 * stripped a leading/trailing ``` fence, so any extra text made JSON.parse throw and silently
 * fall back to the crude local keyword-matching gate for EVERY job — this is very likely why
 * eligibility looked inaccurate even with a working Gemini key. */
function extractJson(raw: string): any | null {
  const cleaned = (raw || '').trim();
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
  const candidate = cleaned.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    // Model sometimes emits a trailing comma or single quotes; try light repairs before giving up.
    const repaired = candidate
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/'([^']*)'\s*:/g, '"$1":')
      .replace(/:\s*'([^']*)'/g, ': "$1"');
    try {
      return JSON.parse(repaired);
    } catch {
      return null;
    }
  }
}

export async function assessJobEligibility(
  title: string,
  company: string,
  description: string,
  customConfig?: AppConfig,
  onLog?: (msg: string) => void
): Promise<EligibilityResult> {
  const config = customConfig || getConfig();

  // On/off toggle (Konfigurasi Bot). When disabled, every job is treated as eligible —
  // no Gemini call, no local keyword gate — and the bot proceeds straight to applying.
  if (config.eligibilityCheckEnabled === false) {
    return {
      eligible: true,
      confidence: 1,
      source: 'local-fallback',
      reasons: ['Eligibility check dimatikan di Konfigurasi Bot — semua lowongan dianggap eligible.'],
      missingRequirements: [],
    };
  }

  const apiKey = (config.geminiApiKey || process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    // This used to fail completely silently — every job in the session would quietly use the
    // crude local keyword gate below with no indication Gemini was never actually consulted.
    onLog?.(`⚠️ Gemini API key kosong — eligibility "${title}" pakai gate lokal (kasar, berbasis kata kunci), bukan penilaian AI.`);
    return localEligibility(title, description, config);
  }

  const profile = getDynamicProfile(config);
  const skills = getDynamicSkills(config).join(', ') || 'not provided';
  const prompt = `CANDIDATE PROFILE:
- Full name: ${config.fullName || 'not provided'}
- Education: ${profile.educationLevel || 'not provided'}
- GPA: ${profile.gpa || 'not provided'}
- Total years of professional experience: ${profile.defaultExperienceYears ?? config.yearsOfExperience ?? 0}
- Skills / tools / relevant experience keywords: ${skills}
- Languages: ${config.languages || 'not provided'}
- Domicile: ${config.domicile || 'not provided'}
- Expected monthly salary: ${config.expectedSalary ? `Rp ${config.expectedSalary}` : 'not provided'}
- Notice period: ${config.noticePeriod || 'not provided'}
- Target role keywords the candidate is searching for: ${config.searchKeywords || 'not provided'}
- Portfolio/GitHub/LinkedIn: ${[config.portfolioUrl, config.githubUrl, config.linkedinUrl].filter(Boolean).join(', ') || 'not provided'}

JOB LISTING:
- Company: ${company}
- Title: ${title}
- Full description:
${description.slice(0, 18000)}`;

  try {
    const ai = new GoogleGenerativeAI(apiKey);
    const model = ai.getGenerativeModel({
      model: 'gemini-1.5-flash',
      systemInstruction: SYSTEM,
      generationConfig: { responseMimeType: 'application/json' },
    });
    const result = await model.generateContent(prompt);
    const raw = result.response.text() || '';
    const parsed = extractJson(raw);
    if (parsed && typeof parsed.eligible === 'boolean' && Number.isFinite(Number(parsed.confidence))) {
      const confidence = Math.max(0, Math.min(1, Number(parsed.confidence)));
      // Trust the model's own eligible/not-eligible verdict directly instead of silently
      // overriding it to false whenever confidence < 0.75 (the previous hard-coded floor).
      // A confident "false" from the model is still respected; only an internally-inconsistent
      // answer (eligible=true but the model itself is very unsure) gets the conservative nudge.
      const inconsistentLowConfidence = parsed.eligible === true && confidence < 0.35;
      return {
        eligible: inconsistentLowConfidence ? false : parsed.eligible,
        confidence,
        source: 'gemini',
        reasons: Array.isArray(parsed.reasons) ? parsed.reasons.slice(0, 6) : [],
        missingRequirements: Array.isArray(parsed.missingRequirements) ? parsed.missingRequirements.slice(0, 6) : [],
      };
    }
    onLog?.(`⚠️ Gemini eligibility: respons tidak berupa JSON valid untuk "${title}", memakai gate lokal sementara. Raw (dipotong): ${raw.slice(0, 160).replace(/\n/g, ' ')}`);
  } catch (e: any) {
    onLog?.(`⚠️ Gemini eligibility gagal untuk "${title}" (${e?.message || e}), memakai gate lokal sementara.`);
    console.warn('[Eligibility] Gemini assessment failed; using conservative local gate.', e);
  }
  return localEligibility(title, description, config);
}
