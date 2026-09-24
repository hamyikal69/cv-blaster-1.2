import fs from 'fs';
import path from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { AppConfig, getConfig } from './config';

export const COVER_LETTER_SYSTEM_INSTRUCTION = `
You are a professional job-application cover-letter writer.
Write a concise, truthful, job-specific cover letter for the candidate.

RULES:
1. Use only facts contained in the candidate profile and job description.
2. Never invent company facts, products, employers, achievements, certifications,
   technologies, metrics, or responsibilities.
3. Tailor the letter to the exact job title and the strongest relevant requirements
   in the job description.
4. Do not merely replace the job title in a generic template. The body must explain
   why the candidate's documented background is relevant to this particular role.
5. Use Indonesian unless the job description is predominantly English; then use
   professional English.
6. Keep it suitable for a JobStreet text box: approximately 150-220 words, no
   markdown, no bullet list, no subject line, no fake recipient name, and no claims
   that cannot be supported by the profile.
7. Do not mention that AI wrote the letter.
8. End with a professional closing using the candidate's real name.
`;

function profileText(config: AppConfig): string {
  return [
    `Name: ${config.fullName || 'Not provided'}`,
    `Education: ${config.educationLevel || 'Not provided'}`,
    `GPA: ${config.gpa || 'Not provided'}`,
    `Experience: ${config.yearsOfExperience || 0} years`,
    `Skills: ${config.skills || 'Not provided'}`,
    `Portfolio: ${config.portfolioUrl || 'Not provided'}`,
    `GitHub: ${config.githubUrl || 'Not provided'}`,
    `LinkedIn: ${config.linkedinUrl || 'Not provided'}`,
    `Domicile: ${config.domicile || 'Not provided'}`,
  ].join('\n');
}

/** Generate a static fallback only when Gemini is unavailable. */
export function generateCoverLetter(companyName: string, jobTitle: string, customConfig?: AppConfig): string {
  const config = customConfig || getConfig();
  const cleanCompany = (companyName || 'Perusahaan').trim();
  const cleanTitle = (jobTitle || 'Posisi yang dilamar').trim();
  const cleanFullName = (config.fullName || 'Pelamar').trim();
  return `Yth. Tim Rekrutmen ${cleanCompany},\n\nSaya bermaksud mengajukan lamaran untuk posisi ${cleanTitle}. Dengan latar belakang ${config.educationLevel || 'pendidikan yang relevan'} dan pengalaman ${config.yearsOfExperience || 0} tahun, saya memiliki keterampilan yang dapat mendukung kebutuhan posisi tersebut. Saya tertarik untuk membawa kemampuan ${config.skills || 'yang relevan'} dan pengalaman bekerja secara kolaboratif ke dalam tim ${cleanCompany}.\n\nSaya terbuka untuk mendiskusikan bagaimana pengalaman dan keterampilan saya dapat memberikan kontribusi pada posisi ${cleanTitle}. Terima kasih atas waktu dan pertimbangannya.\n\nHormat saya,\n${cleanFullName}`;
}

export async function generateAICoverLetter(
  companyName: string,
  jobTitle: string,
  jobDescription: string,
  customConfig?: AppConfig
): Promise<string> {
  const config = customConfig || getConfig();
  const apiKey = (config.geminiApiKey || process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) return generateCoverLetter(companyName, jobTitle, config);

  const languageHint = /\b(the|your|you|experience|requirements|responsibilities|about the role)\b/i.test(jobDescription) ? 'English' : 'Indonesian';
  const prompt = `Create a tailored cover letter for this job application.\n\nCandidate profile:\n${profileText(config)}\n\nCompany: ${companyName || 'Not provided'}\nJob title: ${jobTitle || 'Not provided'}\nJob description:\n${(jobDescription || 'Not provided').slice(0, 12000)}\n\nPreferred output language: ${languageHint}.\nReturn only the final cover letter text.`;

  try {
    const ai = new GoogleGenerativeAI(apiKey);
    const model = ai.getGenerativeModel({
      model: 'gemini-1.5-flash',
      systemInstruction: COVER_LETTER_SYSTEM_INSTRUCTION,
    });
    const result = await model.generateContent(prompt);
    const text = (result.response.text() || '').trim();
    if (text && text.length >= 80) return text;
  } catch (error: any) {
    console.warn(`[CoverLetter] Gemini generation failed: ${error?.message || error}`);
  }

  return generateCoverLetter(companyName, jobTitle, config);
}
