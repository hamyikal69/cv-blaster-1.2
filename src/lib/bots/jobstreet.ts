import { isJobAlreadyApplied, addAppliedJob } from '../googleSheets';
import { answerQuestion, resetDobGuessState } from '../questionAnswer';
import { generateAICoverLetter } from '../coverLetterHelper';
import { assessJobEligibility } from '../jobEligibility';

function isJobstreetHost(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return hostname === 'jobstreet.com' || hostname.endsWith('.jobstreet.com') || hostname === 'seek.com' || hostname.endsWith('.seek.com');
  } catch {
    return true;
  }
}

async function safeGoto(page: any, url: string, timeout = 30000): Promise<void> {
  // JobStreet keeps long-lived network requests open. Waiting for networkidle2
  // therefore causes false timeout failures even when the document is usable.
  // Treat a timeout after the target URL has loaded as a soft navigation success,
  // then retry once for genuine navigation failures.
  let lastError: any;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      return;
    } catch (error: any) {
      lastError = error;
      const message = String(error?.message || error);
      const currentUrl = typeof page.url === 'function' ? page.url() : '';
      if (/timeout/i.test(message) && currentUrl && currentUrl !== 'about:blank') {
        try {
          await page.waitForFunction(() => document.readyState !== 'loading', { timeout: 5000 });
        } catch {}
        return;
      }
      if (attempt < 2) {
        await sleep(1000);
      }
    }
  }
  throw lastError;
}

async function safeEvaluate(page: any, pageFunction: any, ...args: any[]): Promise<any> {
  let lastError: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await page.evaluate(pageFunction, ...args);
    } catch (error: any) {
      lastError = error;
      const message = String(error?.message || error);
      if (!/execution context was destroyed|cannot find context|most likely because of a navigation|target closed/i.test(message) || attempt === 2) {
        throw error;
      }
      await sleep(700);
    }
  }
  throw lastError;
}

function normalizeButtonText(text: string): string {
  // Strip ALL invisible/zero-width formatting characters. JobStreet sometimes injects
  // U+2060 (WORD JOINER) inside button labels (e.g. "Daftar\u2060"), which silently breaks
  // the exact-match regex (/^(Daftar|Register)$/i) used to detect external applications,
  // causing external "Daftar" jobs to be clicked instead of skipped.
  return (text || '')
    .replace(/[\u200B-\u200D\u2060\uFEFF\u2061-\u2064\u00AD]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function recordExternalSkip(
  company: string,
  title: string,
  jobUrl: string,
  buttonText: string,
  onLog: (msg: string) => void,
  workerId: number
): Promise<void> {
  const normalized = normalizeButtonText(buttonText);
  const label = /\bdaftar\b|register/i.test(normalized) ? 'Skipped (External / Daftar)' : 'Skipped (External)';
  onLog(`[Worker ${workerId + 1}] ⏩ ${label}: ${jobUrl}${normalized ? ` (tombol: ${normalized})` : ''}`);
  await addAppliedJob({
    company: company || 'Jobstreet Company',
    title: title || 'Jobstreet Job',
    platform: 'Jobstreet',
    jobUrl,
    status: label,
  });
}

export interface BotMetrics {
  successCount: number;
  alreadyAppliedCount: number;
  errorCount: number;
}

export interface SharedLimiter {
  isLimitReached: (platformSuccess: number) => boolean;
  onJobSuccess: () => void;
  getTargetLimit: () => number;
}

export async function runJobstreetBot(
  page: any, 
  config: any, 
  onLog: (msg: string) => void,
  sharedLimiter?: SharedLimiter
): Promise<BotMetrics> {
  let successCount = 0;
  let alreadyAppliedCount = 0;
  let errorCount = 0;

  onLog('🌐 Navigating to Jobstreet Homepage...');
  await safeGoto(page, 'https://www.jobstreet.co.id/', 30000);

  const isLoggedIn = await page.evaluate(() => {
    return !!document.querySelector('[data-automation="user-menu"], a[href*="/profile"], button[aria-label*="Profile"]');
  });

  if (!isLoggedIn) {
    onLog('⚠️ Jobstreet: Not logged in! Please click "Buka Browser (Login Setup)" to login first.');
    return { successCount, alreadyAppliedCount, errorCount };
  }
  onLog('✅ Jobstreet: Logged in successfully.');

  const formattedKeywords = config.searchKeywords.trim().toLowerCase().replace(/\s+/g, '-');
  const formattedLocation = (config.location || '').trim().toLowerCase().replace(/\s+/g, '-');
  const searchUrl = formattedLocation 
    ? `https://id.jobstreet.com/id/${formattedKeywords}-jobs/in-${formattedLocation}`
    : `https://id.jobstreet.com/id/${formattedKeywords}-jobs`;

  const baseSearchUrl = searchUrl.replace(/[?&]page=\d+/, '');
  const urlSeparator = baseSearchUrl.includes('?') ? '&' : '?';

  let currentPage = 1;
  const targetLimit = sharedLimiter ? sharedLimiter.getTargetLimit() : (config.limitJobstreet || config.limitPerDay || 10);
  const checkLimitReached = () => sharedLimiter ? sharedLimiter.isLimitReached(successCount) : successCount >= targetLimit;
  const maxPages = Math.max(1, Math.ceil(targetLimit / 25) + 3);

  const processedUrls = new Set<string>();

  while (currentPage <= maxPages && global.isBotRunning !== false && !checkLimitReached()) {
    const pageSearchUrl = currentPage === 1 ? searchUrl : `${baseSearchUrl}${urlSeparator}page=${currentPage}`;
    onLog('==================================================');
    onLog(`📄 Membuka Halaman Pencarian Jobstreet ke-${currentPage}: ${pageSearchUrl}`);

    try {
      await safeGoto(page, pageSearchUrl, 30000);
      await sleep(2000);
    } catch (navErr: any) {
      onLog(`⚠️ Gagal membuka halaman Jobstreet ke-${currentPage}: ${navErr.message || navErr}`);
      break;
    }

    // Get job links and active pagination page
    const pageData = await page.evaluate(() => {
      const overlays = Array.from(document.querySelectorAll('a[data-automation="job-list-item-link-overlay"], a[data-automation="jobTitle"], a[href*="/job/"]'));
      const rawUrls = overlays.map((a: any) => a.href).filter(Boolean);
      
      const cleanUrls: string[] = [];
      for (const u of rawUrls) {
        try {
          const parsed = new URL(u);
          const clean = `${parsed.origin}${parsed.pathname}`;
          if (clean.includes('/job/') && !cleanUrls.includes(clean)) {
            cleanUrls.push(clean);
          }
        } catch {}
      }

      const activePageEl = document.querySelector('[aria-current="page"]');
      const pageNum = activePageEl ? activePageEl.textContent?.trim() || '1' : '1';
      
      return { urls: cleanUrls, currentPage: pageNum };
    });

    const newJobUrls = pageData.urls.filter((u: string) => !processedUrls.has(u));
    newJobUrls.forEach((u: string) => processedUrls.add(u));

    onLog(`📊 Halaman ${currentPage}: Ditemukan ${pageData.urls.length} lowongan unik (${newJobUrls.length} loker baru untuk diproses).`);

    if (newJobUrls.length === 0) {
      onLog(`⚠️ Tidak ada loker baru yang ditemukan pada halaman ke-${currentPage}. Selesai.`);
      break;
    }

    // Split job URLs into N workers chunks
    const numWorkers = Math.max(1, config.concurrency || 3);
    const chunks: string[][] = Array.from({ length: numWorkers }, () => []);
    newJobUrls.forEach((url: string, index: number) => {
      chunks[index % numWorkers].push(url);
    });

    const browser = page.browser();
    onLog(`🚀 Menjalankan ${numWorkers} worker concurrent untuk memproses ${newJobUrls.length} lowongan di Jobstreet halaman ${currentPage}...`);

    const workerPromises = chunks.map(async (chunkUrls, workerId) => {
      if (chunkUrls.length === 0) return;

      onLog(`👷 Worker ${workerId + 1} started to process ${chunkUrls.length} jobs.`);

      const workerPage = await browser.newPage();
      await workerPage.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
      await workerPage.setViewport({ width: 1280, height: 800 });

      try {
        for (const url of chunkUrls) {
          // Reset the "generic Select-option" DOB-guess guard for every new job.
          // Prevents a birth-year guess from being reused on unrelated Bulan/Tahun
          // dropdowns later in the same form (e.g. employment history date range).
          resetDobGuessState();

          if (!global.isBotRunning) {
            onLog(`🛑 Worker ${workerId + 1}: Stop signal detected. Exiting worker.`);
            break;
          }

          if (checkLimitReached()) {
            onLog(`🛑 Worker ${workerId + 1}: Reached target limit (${successCount}/${targetLimit} applies). Skipping remaining.`);
            break;
          }

          const alreadyApplied = await isJobAlreadyApplied(url);
          if (alreadyApplied) {
            onLog(`[Worker ${workerId + 1}] ⏩ Already applied (skipped): ${url}`);
            alreadyAppliedCount++;
            continue;
          }

          let applyPage = workerPage;

          try {
          onLog(`[Worker ${workerId + 1}] 🔗 Opening Job: ${url}`);
          await safeGoto(workerPage, url, 30000);
          await sleep(2000);

          // Extract Job Title & Company Name
          const jobDetails = await workerPage.evaluate(() => {
            const titleEl = document.querySelector('[data-automation="job-detail-title"]');
            const companyEl = document.querySelector('[data-automation="advertiser-name"]');
            const descriptionSelectors = [
              '[data-automation="jobAdDetails"]',
              '[data-automation="job-description"]',
              '[data-automation="jobAdDescription"]',
              'article',
              'main'
            ];
            const title = titleEl ? (titleEl.textContent || '').trim() : '';
            let company = '';
            if (companyEl) {
              company = companyEl.childNodes[0] ? (companyEl.childNodes[0].textContent || '').trim() : (companyEl.textContent || '').trim();
              company = company.replace(/\s+/g, ' ');
            }
            let description = '';
            for (const selector of descriptionSelectors) {
              const el = document.querySelector(selector) as HTMLElement | null;
              const text = el?.innerText?.trim() || '';
              if (text.length > description.length) description = text;
            }
            // Remove obvious navigation noise while keeping the job requirements/context.
            description = description.replace(/\n{3,}/g, '\n\n').slice(0, 15000);
            return { title, company, description };
          });

          onLog(`[Worker ${workerId + 1}] 💼 Job: "${jobDetails.title}" at "${jobDetails.company}"`);

          // Eligibility gate: only proceed when the job is supported by the configured profile/CV evidence.
          const eligibility = await assessJobEligibility(jobDetails.title, jobDetails.company, jobDetails.description, config);
          onLog(`[Worker ${workerId + 1}] 🧭 Eligibility: ${eligibility.eligible ? 'ELIGIBLE' : 'SKIP'} (confidence ${Math.round(eligibility.confidence * 100)}%)`);
          if (!eligibility.eligible) {
            onLog(`[Worker ${workerId + 1}] ⏩ Dilewati karena eligibility tidak cukup: ${[...eligibility.reasons, ...eligibility.missingRequirements].join(' | ')}`);
            alreadyAppliedCount++;
            continue;
          }

          // Find Apply button and verify status on Jobstreet
          const applyBtnStatus = await workerPage.evaluate(() => {
            const findApplyElement = (): HTMLElement | null => {
              // 1. Priority by data-automation attributes
              const prioritySelectors = [
                '[data-automation="job-detail-apply"]',
                '[data-automation="apply-now"]',
                '[data-automation="job-detail-apply-button"]',
                '[data-testid="apply-button"]',
                'a[href*="/apply"]'
              ];
              for (const sel of prioritySelectors) {
                const el = document.querySelector(sel) as HTMLElement;
                if (el) return el;
              }

              // 2. Priority by specific text ("Lamar Cepat", "Quick Apply", etc.)
              const candidates = Array.from(document.querySelectorAll('a, button, [role="button"]')) as HTMLElement[];
              const exactMatch = candidates.find(el => {
                const txt = (el.textContent || '').trim();
                return /^(Lamar Cepat|Quick Apply|Lamar Sekarang|Apply Now)$/i.test(txt);
              });
              if (exactMatch) return exactMatch;

              // 3. Fallback text search for Apply/Lamar
              return candidates.find(el => {
                const txt = (el.textContent || '').trim();
                return /Lamar Cepat|Quick Apply|Lamar Sekarang|Apply Now/i.test(txt) || /^(Lamar|Apply)$/i.test(txt);
              }) || null;
            };

            const btn = findApplyElement();
            if (!btn) return { exists: false, text: '', isAlreadyApplied: false, isExternal: false };

            const buttonText = normalizeButtonText(btn.textContent || '');
            const href = btn.getAttribute('href') || '';

            // Check if already applied
            const isAlreadyApplied = /Applied|Dilamar|Sudah Dilamar/i.test(buttonText);

            // External applications are identified before click whenever possible.
            // "Daftar" on JobStreet is the external-registration path in the cases
            // observed in the current flow; it must never be counted as an application.
            let isExternal = /^(Daftar|Register)$/i.test(buttonText) || /situs perusahaan|company website|employer site|situs web|apply on company|visit employer/i.test(buttonText);
            if (!isExternal && href.startsWith('http')) {
              try {
                isExternal = !isJobstreetHost(href);
              } catch {}
            }

            // Explicit internal Quick Apply always wins.
            if (/Lamar Cepat|Quick Apply|Lamar Sekarang|Apply Now/i.test(buttonText)) {
              isExternal = false;
            }

            return { exists: true, text: buttonText, isAlreadyApplied, isExternal };
          });

          if (!applyBtnStatus.exists) {
            onLog(`[Worker ${workerId + 1}] ❌ Tombol Lamar / Apply TIDAK ditemukan untuk: ${url}`);
            errorCount++;
            continue;
          }

          if (applyBtnStatus.isAlreadyApplied) {
            onLog(`[Worker ${workerId + 1}] ⏩ Jobstreet: Sudah pernah dilamar sebelumnya (${applyBtnStatus.text}): ${url}`);
            await addAppliedJob({ 
              company: jobDetails.company || 'Jobstreet Company', 
              title: jobDetails.title || 'Jobstreet Job', 
              platform: 'Jobstreet', 
              jobUrl: url, 
              status: 'Already Applied' 
            });
            alreadyAppliedCount++;
            continue;
          }

          if (applyBtnStatus.isExternal) {
            await recordExternalSkip(jobDetails.company, jobDetails.title, url, applyBtnStatus.text, onLog, workerId);
            alreadyAppliedCount++;
            continue;
          }

          onLog(`[Worker ${workerId + 1}] 🖱️ Mengklik tombol "${applyBtnStatus.text || 'Lamar Cepat'}"...`);

          // Setup listener for new tab opening for this worker's tab specifically
          const newPagePromise = new Promise<any>(async (resolve, reject) => {
            const timeout = setTimeout(() => {
              resolve(null);
            }, 5000);

            try {
              const listener = async (target: any) => {
                if (target.type() === 'page' && target.opener() === workerPage.target()) {
                  clearTimeout(timeout);
                  browser.off('targetcreated', listener);
                  resolve(await target.page());
                }
              };
              browser.on('targetcreated', listener);
            } catch (e) {
              reject(e);
            }
          });

          // Click apply to open questionnaire
          await workerPage.evaluate(() => {
            const prioritySelectors = [
              '[data-automation="job-detail-apply"]',
              '[data-automation="apply-now"]',
              '[data-automation="job-detail-apply-button"]',
              '[data-testid="apply-button"]',
              'a[href*="/apply"]'
            ];
            let btn: HTMLElement | null = null;
            for (const sel of prioritySelectors) {
              btn = document.querySelector(sel) as HTMLElement;
              if (btn) break;
            }

            if (!btn) {
              const candidates = Array.from(document.querySelectorAll('a, button, [role="button"]')) as HTMLElement[];
              btn = candidates.find(el => /Lamar Cepat|Quick Apply|Lamar Sekarang|Apply Now/i.test((el.textContent || '').trim())) || null;
            }

            if (btn) {
              btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
              btn.click();
            }
          });

          // Determine which page contains the apply form (new tab or same tab).
          // External-registration targets are detected AFTER the click as well because
          // JobStreet sometimes uses JS navigation instead of an external href.
          let applyPage = workerPage;
          let clickedExternal = false;
          try {
            const newTab = await newPagePromise;
            if (newTab) {
              applyPage = newTab;
              await applyPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
              const openedUrl = applyPage.url();
              if (openedUrl && openedUrl !== 'about:blank' && !isJobstreetHost(openedUrl)) {
                clickedExternal = true;
                await recordExternalSkip(jobDetails.company, jobDetails.title, url, applyBtnStatus.text || 'Daftar', onLog, workerId);
                alreadyAppliedCount++;
              } else {
                onLog(`[Worker ${workerId + 1}] 🟢 Formulir lamaran terbuka di tab baru.`);
              }
            } else {
              await sleep(1800);
              const currentUrl = workerPage.url();
              if (currentUrl && !isJobstreetHost(currentUrl)) {
                clickedExternal = true;
                await recordExternalSkip(jobDetails.company, jobDetails.title, url, applyBtnStatus.text || 'Daftar', onLog, workerId);
                alreadyAppliedCount++;
              } else if (currentUrl.includes('/apply')) {
                onLog(`[Worker ${workerId + 1}] 🟢 Formulir lamaran terbuka di tab yang sama.`);
              }
            }
          } catch (e) {
            const currentUrl = await workerPage.url().catch(() => '');
            if (currentUrl && !isJobstreetHost(currentUrl)) {
              clickedExternal = true;
              await recordExternalSkip(jobDetails.company, jobDetails.title, url, applyBtnStatus.text || 'Daftar', onLog, workerId);
              alreadyAppliedCount++;
            }
          }

          if (clickedExternal) {
            if (applyPage !== workerPage && !applyPage.isClosed()) await applyPage.close().catch(() => {});
            continue;
          }

          // Handle the questionnaire flow
          let stepCount = 0;
          let reachedEnd = false;
          let lastStepName = '';
          let sameStepCount = 0;

          while (stepCount < 5 && !reachedEnd) {
            if (!global.isBotRunning) break;

            let unresolvedQuestionOnStep = false;

            // Detect and log current step name
            const currentStepName = await safeEvaluate(applyPage, () => {
              const activeStepEl = document.querySelector('[aria-current="step"]');
              return activeStepEl ? (activeStepEl.textContent || '').trim() : 'Unknown Step';
            });

            if (currentStepName === lastStepName) {
              sameStepCount++;
            } else {
              sameStepCount = 0;
              lastStepName = currentStepName;
            }

            if (sameStepCount >= 3) {
              throw new Error(`Stuck on step "${currentStepName}" for 3 consecutive clicks. Likely a validation error.`);
            }

            onLog(`[Worker ${workerId + 1}] 📍 Step: "${currentStepName}" (${stepCount + 1}/5)`);
            
            // Parse questions on this step
            const questionsOnStep = await safeEvaluate(applyPage, () => {
              const stepData: Array<{ 
                id?: string;
                name?: string;
                question: string; 
                type: 'dropdown' | 'checklist' | 'radiobutton'; 
                options: string[] 
              }> = [];
              const labelElements = Array.from(document.querySelectorAll('label'));

              // 1. Parse select dropdowns
              const selectElements = Array.from(document.querySelectorAll('select')) as HTMLSelectElement[];
              for (const selectEl of selectElements) {
                const selectId = selectEl.id;
                const labelEl = labelElements.find(l => l.getAttribute('for') === selectId) || selectEl.closest('div')?.querySelector('label');
                const questionText = labelEl ? (labelEl.textContent || '').trim() : 'Select option';
                const options = Array.from(selectEl.options)
                  .map(o => o.text.trim())
                  .filter(t => t.length > 0 && !/select|pilih|choose|--/i.test(t));
                stepData.push({ id: selectId, question: questionText, type: 'dropdown', options });
              }

              // 2. Parse checkbox groups
              const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
              const checkboxGroups: { [name: string]: HTMLInputElement[] } = {};
              
              for (const cb of checkboxes) {
                const name = cb.name || cb.getAttribute('data-testid') || 'unknown-checkbox';
                if (!checkboxGroups[name]) {
                  checkboxGroups[name] = [];
                }
                checkboxGroups[name].push(cb);
              }

              for (const name in checkboxGroups) {
                const group = checkboxGroups[name];
                if (group.length === 0) continue;

                const firstCb = group[0];
                let questionText = 'Select options';
                const parentSection = firstCb.closest('div[class*="a6x"], div[class*="a6t"], div[class*="a75"], fieldset');
                if (parentSection) {
                  const strongEl = parentSection.querySelector('strong');
                  if (strongEl) questionText = (strongEl.textContent || '').trim();
                }

                const options: string[] = [];
                for (const cb of group) {
                  const id = cb.id;
                  const labelEl = (id ? labelElements.find(l => l.getAttribute('for') === id) : null) || cb.closest('div')?.querySelector('label') as HTMLElement;
                  const optionText = labelEl ? (labelEl.textContent || '').trim() : '';
                  if (optionText) {
                    options.push(optionText);
                  }
                }
                stepData.push({ name, question: questionText, type: 'checklist', options });
              }

              // 3. Parse radio button groups
              const radios = Array.from(document.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
              const radioGroups: { [name: string]: HTMLInputElement[] } = {};
              
              for (const rd of radios) {
                const name = rd.name || 'unknown-radio';
                if (!radioGroups[name]) {
                  radioGroups[name] = [];
                }
                radioGroups[name].push(rd);
              }

              for (const name in radioGroups) {
                const group = radioGroups[name];
                if (group.length === 0) continue;

                const firstRd = group[0];
                let questionText = 'Select one option';
                const parentSection = firstRd.closest('div[class*="a6x"], div[class*="a6t"], div[class*="a75"], fieldset');
                if (parentSection) {
                  const strongEl = parentSection.querySelector('strong');
                  if (strongEl) questionText = (strongEl.textContent || '').trim();
                }

                const options: string[] = [];
                for (const rd of group) {
                  const id = rd.id;
                  const labelEl = (id ? labelElements.find(l => l.getAttribute('for') === id) : null) || rd.closest('div')?.querySelector('label') as HTMLElement;
                  const optionText = labelEl ? (labelEl.textContent || '').trim() : '';
                  if (optionText) {
                    options.push(optionText);
                  }
                }
                stepData.push({ name, question: questionText, type: 'radiobutton', options });
              }

              return stepData;
            });

            // Process and Answer each question dynamically
            for (const item of questionsOnStep) {
              if (item.options.length > 0) {
                onLog(`[Worker ${workerId + 1}] 📋 Found ${item.type.toUpperCase()}: "${item.question}" - Options: [${item.options.join(' | ')}]`);
                // Query Gemini / Regex answers
                const answers = await answerQuestion(item.question, item.options, item.type, config, true);
                onLog(`[Worker ${workerId + 1}] 🤖 AI Decision for "${item.question}": [${answers.join(' | ')}]`);
                if (answers.length === 0) {
                  if (item.type === 'checklist') {
                    unresolvedQuestionOnStep = true;
                    onLog(`[Worker ${workerId + 1}] ⚠️ Checklist "${item.question}" tidak memiliki bukti kandidat yang cukup. Dibiarkan tidak tercentang; bot tidak akan mengarang jawaban.`);
                    continue;
                  }
                  throw new Error(`UNANSWERABLE_QUESTION: ${item.question}`);
                }

                // Apply chosen answers to the active applyPage DOM
                await safeEvaluate(applyPage, (qItem: any, chosenAnswers: string[]) => {
                  const labelElements = Array.from(document.querySelectorAll('label'));

                  if (qItem.type === 'dropdown' && qItem.id) {
                    const selectEl = document.getElementById(qItem.id) as HTMLSelectElement;
                    if (selectEl && chosenAnswers.length > 0) {
                      const targetText = chosenAnswers[0];
                      let targetIndex = 0;
                      let found = false;
                      for (let i = 0; i < selectEl.options.length; i++) {
                        if (selectEl.options[i].text.trim() === targetText) {
                          targetIndex = i;
                          found = true;
                          break;
                        }
                      }
                      if (!found && selectEl.options.length > 1) {
                        const firstText = selectEl.options[0].text;
                        if (/select|pilih|choose|--/i.test(firstText)) {
                          targetIndex = 1;
                        }
                      }
                      selectEl.selectedIndex = targetIndex;
                      selectEl.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                  } else if (qItem.type === 'checklist' && qItem.name) {
                    const inputs = Array.from(document.querySelectorAll(`input[name="${qItem.name}"]`)) as HTMLInputElement[];
                    for (const input of inputs) {
                      const id = input.id;
                      const label = (id ? labelElements.find(l => l.getAttribute('for') === id) : null) || input.closest('label');
                      const labelText = (label?.textContent || '').trim();

                      const shouldBeChecked = chosenAnswers.some(ans => 
                        labelText.toLowerCase() === ans.toLowerCase() ||
                        labelText.toLowerCase().includes(ans.toLowerCase()) || 
                        ans.toLowerCase().includes(labelText.toLowerCase())
                      );

                      const isCurrentlyChecked = input.checked || input.getAttribute('aria-checked') === 'true';

                      // Click ONLY ONCE if target state differs from current state!
                      if (shouldBeChecked && !isCurrentlyChecked) {
                        if (label && typeof (label as HTMLElement).click === 'function') {
                          (label as HTMLElement).click();
                        } else {
                          input.click();
                        }
                        input.checked = true;
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                      } else if (!shouldBeChecked && isCurrentlyChecked) {
                        if (label && typeof (label as HTMLElement).click === 'function') {
                          (label as HTMLElement).click();
                        } else {
                          input.click();
                        }
                        input.checked = false;
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                      }
                    }
                  } else if (qItem.type === 'radiobutton' && qItem.name) {
                    const inputs = Array.from(document.querySelectorAll(`input[name="${qItem.name}"]`)) as HTMLInputElement[];
                    for (const input of inputs) {
                      const id = input.id;
                      const label = (id ? labelElements.find(l => l.getAttribute('for') === id) : null) || input.closest('label');
                      const labelText = (label?.textContent || '').trim();
                      const isMatch = chosenAnswers.some(ans => 
                        labelText.toLowerCase() === ans.toLowerCase() ||
                        labelText.toLowerCase().includes(ans.toLowerCase()) || 
                        ans.toLowerCase().includes(labelText.toLowerCase())
                      );

                      if (isMatch) {
                        if (label && typeof (label as HTMLElement).click === 'function') {
                          (label as HTMLElement).click();
                        } else {
                          input.click();
                        }
                        input.checked = true;
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                        break;
                      }
                    }
                  }
                }, item, answers);
              }
            }

            // JobStreet cover-letter flow: choose "Tulis Surat Lamaran" and fill the
            // newly revealed textarea with a job-specific Gemini letter. This runs
            // after radio buttons have been processed because the textarea may only
            // appear after that choice is made.
            try {
              await sleep(600);
              const coverLetterField = await safeEvaluate(applyPage, () => {
                const textareas = Array.from(document.querySelectorAll('textarea')) as HTMLTextAreaElement[];
                const inputs = Array.from(document.querySelectorAll('input[type="text"]')) as HTMLInputElement[];
                const editables = Array.from(document.querySelectorAll('[contenteditable="true"]')) as HTMLElement[];
                const fields: Array<HTMLTextAreaElement | HTMLInputElement | HTMLElement> = [...textareas, ...inputs, ...editables];
                const field = fields.find(el => {
                  const parent = el.closest('div, fieldset, section') as HTMLElement | null;
                  const context = [
                    el.getAttribute('aria-label') || '',
                    el.getAttribute('placeholder') || '',
                    (el as HTMLInputElement | HTMLTextAreaElement).name || el.getAttribute('name') || '',
                    parent?.innerText || ''
                  ].join(' ');
                  return /cover letter|surat lamaran|covering letter/i.test(context);
                });
                if (!field) return null;
                return {
                  id: field.id,
                  name: (field as HTMLInputElement | HTMLTextAreaElement).name || field.getAttribute('name') || '',
                  placeholder: field.getAttribute('placeholder') || '',
                  tag: field.tagName
                };
              });

              if (!coverLetterField) {
                const hasWriteChoice = await safeEvaluate(applyPage, () => /Tulis\s+surat\s+lamaran|Write\s+(?:a\s+)?cover\s+letter/i.test(document.body.innerText || ''));
                if (hasWriteChoice) {
                  throw new Error('COVER_LETTER_FIELD_NOT_FOUND');
                }
              } else {
                const letter = await generateAICoverLetter(
                  jobDetails.company,
                  jobDetails.title,
                  jobDetails.description,
                  config
                );
                if (!letter || letter.trim().length < 80) {
                  throw new Error('COVER_LETTER_GENERATION_FAILED');
                }

                await safeEvaluate(applyPage, (fieldInfo: any, value: string) => {
                  const editables = Array.from(document.querySelectorAll('[contenteditable="true"]')) as HTMLElement[];
                  const candidates = [...(Array.from(document.querySelectorAll('textarea, input[type="text"]')) as Array<HTMLTextAreaElement | HTMLInputElement>), ...editables];
                  const field = candidates.find(el =>
                    (fieldInfo.id && el.id === fieldInfo.id) ||
                    (fieldInfo.name && (el as HTMLInputElement).name === fieldInfo.name) ||
                    (fieldInfo.placeholder && el.getAttribute('placeholder') === fieldInfo.placeholder)
                  );
                  if (!field) return;
                  if (field instanceof HTMLElement && field.isContentEditable) {
                    field.textContent = value;
                  } else {
                    const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
                    descriptor?.set?.call(field, value);
                  }
                  field.dispatchEvent(new Event('input', { bubbles: true }));
                  field.dispatchEvent(new Event('change', { bubbles: true }));
                  field.dispatchEvent(new Event('blur', { bubbles: true }));
                }, coverLetterField, letter);

                onLog(`[Worker ${workerId + 1}] ✍️ Surat Lamaran AI dibuat khusus untuk "${jobDetails.title}" di "${jobDetails.company}".`);
              }
            } catch (coverErr: any) {
              onLog(`[Worker ${workerId + 1}] ⚠️ Gagal mengisi Surat Lamaran AI: ${coverErr?.message || coverErr}`);
              throw coverErr;
            }

            // Check button state on active apply step
            const stepBtnStatus = await safeEvaluate(applyPage, () => {
              // 1. Check for final submit button
              const submitBtn = (document.querySelector('[data-testid="review-submit-application"]') ||
                                Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]')).find(b => {
                                  const text = (b.textContent || b.getAttribute('value') || '').trim();
                                  return /^(Submit application|Submit Application|Kirim Lamaran|Submit)$/i.test(text);
                                })) as HTMLElement | null;

              if (submitBtn) {
                const disabled = submitBtn.hasAttribute('disabled') || submitBtn.getAttribute('aria-disabled') === 'true';
                return { isSubmit: true, isContinue: false, disabled, text: submitBtn.textContent?.trim() || 'Submit' };
              }

              // 2. Check for continue / next transition button
              const continueBtn = (document.querySelector('[data-testid="continue-button"]') ||
                                  Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]')).find(b => {
                                    const text = (b.textContent || b.getAttribute('value') || '').trim();
                                    return /^(Continue|Lanjutkan|Next|Selanjutnya|Review)$/i.test(text) || /Continue|Lanjutkan|Next/i.test(text);
                                  })) as HTMLElement | null;

              if (continueBtn) {
                const disabled = continueBtn.hasAttribute('disabled') || continueBtn.getAttribute('aria-disabled') === 'true';
                return { isSubmit: false, isContinue: true, disabled, text: continueBtn.textContent?.trim() || 'Continue' };
              }

              return { isSubmit: false, isContinue: false, disabled: false, text: '' };
            });

            if (stepBtnStatus.isSubmit) {
              if (config.debugTest) {
                onLog(`[Worker ${workerId + 1}] 🏁 [DEBUG MODE] Tombol "${stepBtnStatus.text}" terdeteksi.`);
                onLog(`[Worker ${workerId + 1}] 🛡️ Simulasi berhasil! Melewati pengiriman lamaran nyata ke Jobstreet.`);
                reachedEnd = true;
                break;
              } else {
                if (!stepBtnStatus.disabled) {
                  onLog(`[Worker ${workerId + 1}] 🚀 Mengirim lamaran resmi ke Jobstreet ("${stepBtnStatus.text}")...`);
                  await safeEvaluate(applyPage, () => {
                    const submitBtn = (document.querySelector('[data-testid="review-submit-application"]') ||
                                      Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]')).find(b => {
                                        const text = (b.textContent || b.getAttribute('value') || '').trim();
                                        return /^(Submit application|Submit Application|Kirim Lamaran|Submit)$/i.test(text);
                                      })) as HTMLElement | null;
                    if (submitBtn) submitBtn.click();
                  });
                  await sleep(4000);
                }
                reachedEnd = true;
                break;
              }
            }

            if (stepBtnStatus.isContinue && !stepBtnStatus.disabled) {
              await safeEvaluate(applyPage, () => {
                const continueBtn = (document.querySelector('[data-testid="continue-button"]') ||
                                    Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]')).find(b => {
                                      const text = (b.textContent || b.getAttribute('value') || '').trim();
                                      return /^(Continue|Lanjutkan|Next|Selanjutnya|Review)$/i.test(text) || /Continue|Lanjutkan|Next/i.test(text);
                                    })) as HTMLElement | null;
                if (continueBtn) continueBtn.click();
              });
              await sleep(3000);
              stepCount++;
            } else {
              if (unresolvedQuestionOnStep) {
                const requiredBlocked = await safeEvaluate(applyPage, () => {
                  const invalid = Array.from(document.querySelectorAll('[aria-invalid="true"], [role="alert"], [data-testid*="error"]')) as HTMLElement[];
                  const invalidText = invalid.map(el => (el.innerText || el.textContent || '').toLowerCase()).join(' ');
                  const requiredInputs = Array.from(document.querySelectorAll('input[required], select[required], textarea[required]')) as Array<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>;
                  const hasRequiredEmpty = requiredInputs.some(input => {
                    if (input instanceof HTMLSelectElement) return !input.value || /select|pilih|choose/i.test(input.selectedOptions[0]?.text || '');
                    if (input instanceof HTMLInputElement && input.type === 'checkbox') return !input.checked;
                    return !(input.value || '').trim();
                  });
                  return hasRequiredEmpty || /required|wajib|harus|required field|please select|silakan pilih/i.test(invalidText);
                }).catch(() => true);
                if (requiredBlocked) {
                  throw new Error(`UNANSWERABLE_REQUIRED_QUESTION: ${lastStepName}`);
                }
              }
              reachedEnd = true;
              onLog(`[Worker ${workerId + 1}] ✅ Selesai menjawab seluruh pertanyaan.`);
              break;
            }
          }

          // Record job application outcome
          if (config.debugTest) {
            await addAppliedJob({ 
              company: jobDetails.company || 'Jobstreet Company', 
              title: jobDetails.title || 'Jobstreet Job', 
              platform: 'Jobstreet', 
              jobUrl: url, 
              status: 'Dry-run Sim' 
            });
            onLog(`[Worker ${workerId + 1}] 📝 [Dry-run Sim] Data "${jobDetails.title}" dicatat ke riwayat Google Sheets.`);
          } else {
            onLog(`[Worker ${workerId + 1}] 🎉 Berhasil melamar pekerjaan: ${jobDetails.title}`);
            await addAppliedJob({ 
              company: jobDetails.company || 'Jobstreet Company', 
              title: jobDetails.title || 'Jobstreet Job', 
              platform: 'Jobstreet', 
              jobUrl: url, 
              status: 'Applied' 
            });
          }
          
          successCount++;
          if (sharedLimiter) sharedLimiter.onJobSuccess();

          const delay = Math.floor(Math.random() * 3000) + 3000;
          await sleep(delay);

        } catch (itemError: any) {
          onLog(`[Worker ${workerId + 1}] ❌ Error applying to job ${url}: ${itemError.message || itemError}`);
          errorCount++;
        } finally {
          if (applyPage !== workerPage && !applyPage.isClosed()) {
            await applyPage.close().catch(() => {});
          }
        }
      }
    } finally {
      if (!workerPage.isClosed()) {
        await workerPage.close().catch(() => {});
      }
    }
  });

    await Promise.all(workerPromises);
    currentPage++;
  }

  return { successCount, alreadyAppliedCount, errorCount };
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
