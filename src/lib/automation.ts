import path from 'path';
import { AppConfig, getConfig } from './config';
import { runGlintsBot } from './bots/glints';
import { runJobstreetBot } from './bots/jobstreet';
import { runLinkedinBot } from './bots/linkedin';
import { runIndeedBot } from './bots/indeed';

declare global {
  var isBotRunning: boolean;
}

export async function startBot(
  onLog: (msg: string) => void,
  mode: string = 'headless',
  customConfig?: AppConfig
) {
  if (global.isBotRunning) {
    onLog('⚠️ Bot is already running!');
    return;
  }

  global.isBotRunning = true;
  onLog(`🚀 Starting CV Blaster Engine in ${mode.toUpperCase()} mode...`);

  let browser: any = null;
  try {
    const config = getConfig(customConfig);

    // Set GEMINI_API_KEY if provided (Optional)
    const geminiApiKey = (config.geminiApiKey || process.env.GEMINI_API_KEY || '').trim();
    if (geminiApiKey) {
      process.env.GEMINI_API_KEY = geminiApiKey;
      onLog('🧠 Gemini AI aktif untuk menjawab pertanyaan kuesioner baru.');
    } else {
      process.env.GEMINI_API_KEY = '';
      onLog('ℹ️ Gemini API Key tidak diisi (Mode Offline/Tanpa AI). Pertanyaan di luar database akan dijawab dengan aturan default/pilihan pertama.');
    }

    if (!config.searchKeywords && !config.indeedNoJobTitleFilter) {
      throw new Error('Search keywords are not configured. Please fill them in first.');
    }

    // Test Google Sheets connection
    onLog('📊 Menguji koneksi ke Google Sheets...');
    const { testSheetsConnection } = require('./googleSheets');
    const sheetsTest = await testSheetsConnection(config);
    if (sheetsTest.success) {
      onLog(`✅ Google Sheets terhubung: ${sheetsTest.message}`);
    } else {
      onLog(`⚠️ Peringatan: Gagal terhubung ke Google Sheets (${sheetsTest.error})`);
      onLog(`   ℹ️ Lamaran tetap akan diproses, namun riwayat sheets tidak tersimpan jika koneksi terputus.`);
    }

    // Launch browser with Google Chrome priority and Chromium fallback
    const { launchBrowserWithFallback } = require('./browserHelper');
    const launchResult = await launchBrowserWithFallback(mode as any, onLog);
    browser = launchResult.browser;

    let totalSuccess = 0;
    let totalAlreadyApplied = 0;
    let totalErrors = 0;

    // Defense-in-depth: config values are already clamped to <=50 by config.ts, but these
    // fallbacks previously used un-clamped magic numbers (155/80/75/50) that would silently
    // blow past the 50 cap if a stale/hand-edited config.json ever reached this code without
    // going through normalizeConfigValues(). Every fallback below is now hard-clamped to 50.
    const clamp50 = (n: unknown, fallback: number) => {
      const v = Number(n);
      return Math.max(1, Math.min(50, Number.isFinite(v) && v > 0 ? v : fallback));
    };
    const isSharedMode = config.limitMode !== 'per_platform';
    const sharedLimitTarget = clamp50(config.limitPerDay, 50);

    if (isSharedMode) {
      onLog(`🎯 Mode Kuota: Kuota Gabungan Aktif (Target Total: ${sharedLimitTarget} lamaran untuk semua platform).`);
    } else {
      onLog(`🎯 Mode Kuota: Kuota Per-Platform Aktif (Glints: ${clamp50(config.limitGlints, 20)}, JobStreet: ${clamp50(config.limitJobstreet, 20)}, LinkedIn: ${clamp50(config.limitLinkedin, 20)}).`);
    }

    const glintsLimiter = {
      getTargetLimit: () => isSharedMode ? sharedLimitTarget : clamp50(config.limitGlints ?? config.limitPerDay, 20),
      isLimitReached: (currentGlintsSuccess: number) => {
        if (isSharedMode) {
          return totalSuccess >= sharedLimitTarget;
        }
        return currentGlintsSuccess >= clamp50(config.limitGlints ?? config.limitPerDay, 20);
      },
      onJobSuccess: () => {
        totalSuccess++;
      }
    };

    const jobstreetLimiter = {
      getTargetLimit: () => isSharedMode ? sharedLimitTarget : clamp50(config.limitJobstreet ?? config.limitPerDay, 20),
      isLimitReached: (currentJobstreetSuccess: number) => {
        if (isSharedMode) {
          return totalSuccess >= sharedLimitTarget;
        }
        return currentJobstreetSuccess >= clamp50(config.limitJobstreet ?? config.limitPerDay, 20);
      },
      onJobSuccess: () => {
        totalSuccess++;
      }
    };

    const linkedinLimiter = {
      getTargetLimit: () => isSharedMode ? sharedLimitTarget : clamp50(config.limitLinkedin ?? config.limitPerDay, 20),
      isLimitReached: (currentLinkedinSuccess: number) => {
        if (isSharedMode) {
          return totalSuccess >= sharedLimitTarget;
        }
        return currentLinkedinSuccess >= clamp50(config.limitLinkedin ?? config.limitPerDay, 20);
      },
      onJobSuccess: () => {
        totalSuccess++;
      }
    };

    const indeedLimiter = {
      getTargetLimit: () => isSharedMode ? sharedLimitTarget : clamp50(config.limitIndeed ?? config.limitPerDay, 20),
      isLimitReached: (currentIndeedSuccess: number) => {
        if (isSharedMode) {
          return totalSuccess >= sharedLimitTarget;
        }
        return currentIndeedSuccess >= clamp50(config.limitIndeed ?? config.limitPerDay, 20);
      },
      onJobSuccess: () => {
        totalSuccess++;
      }
    };

    const initialPages = await browser.pages();
    let initialPageUsed = false;

    const getOrNewPage = async () => {
      if (!initialPageUsed && initialPages.length > 0 && initialPages[0]) {
        initialPageUsed = true;
        return initialPages[0];
      }
      return await browser.newPage();
    };

    const tasks: Promise<void>[] = [];

    // ----------------------------------------------------
    // TAB 1: GLINTS AUTOMATION
    // ----------------------------------------------------
    if (config.enableGlints) {
      tasks.push((async () => {
        const pageGlints = await getOrNewPage();
        await pageGlints.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        const glintsLog = (msg: string) => onLog(`[Glints] ${msg}`);

        glintsLog('🔍 Memulai proses bot Glints di Tab khusus...');
        try {
          const metrics = await runGlintsBot(pageGlints, config, glintsLog, glintsLimiter);
          totalAlreadyApplied += metrics.alreadyAppliedCount;
          totalErrors += metrics.errorCount;
        } catch (err: any) {
          glintsLog(`❌ Error: ${err.message || err}`);
          totalErrors++;
        } finally {
          try { await pageGlints.close(); } catch {}
        }
      })());
    } else {
      onLog('⏩ Glints dinonaktifkan di pengaturan.');
    }

    // ----------------------------------------------------
    // TAB 2: JOBSTREET AUTOMATION
    // ----------------------------------------------------
    if (config.enableJobstreet) {
      tasks.push((async () => {
        const pageJobstreet = await getOrNewPage();
        await pageJobstreet.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        const jobstreetLog = (msg: string) => onLog(`[Jobstreet] ${msg}`);

        jobstreetLog('🔍 Memulai proses bot Jobstreet di Tab khusus...');
        try {
          const metrics = await runJobstreetBot(pageJobstreet, config, jobstreetLog, jobstreetLimiter);
          totalAlreadyApplied += metrics.alreadyAppliedCount;
          totalErrors += metrics.errorCount;
        } catch (err: any) {
          jobstreetLog(`❌ Error: ${err.message || err}`);
          totalErrors++;
        } finally {
          try { await pageJobstreet.close(); } catch {}
        }
      })());
    } else {
      onLog('⏩ Jobstreet dinonaktifkan di pengaturan.');
    }

    // ----------------------------------------------------
    // TAB 3: LINKEDIN AUTOMATION
    // ----------------------------------------------------
    if (config.enableLinkedin) {
      tasks.push((async () => {
        const pageLinkedin = await getOrNewPage();
        await pageLinkedin.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        const linkedinLog = (msg: string) => onLog(`[LinkedIn] ${msg}`);

        linkedinLog('🔍 Memulai proses bot LinkedIn di Tab khusus...');
        try {
          const metrics = await runLinkedinBot(pageLinkedin, config, linkedinLog, linkedinLimiter);
          totalAlreadyApplied += metrics.alreadyAppliedCount;
          totalErrors += metrics.errorCount;
        } catch (err: any) {
          linkedinLog(`❌ Error: ${err.message || err}`);
          totalErrors++;
        } finally {
          try { await pageLinkedin.close(); } catch {}
        }
      })());
    } else {
      onLog('⏩ LinkedIn dinonaktifkan di pengaturan.');
    }

    // ----------------------------------------------------
    // TAB 4: INDEED AUTOMATION
    // ----------------------------------------------------
    if (config.enableIndeed) {
      tasks.push((async () => {
        const pageIndeed = await getOrNewPage();
        await pageIndeed.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        const indeedLog = (msg: string) => onLog(`[Indeed] ${msg}`);

        indeedLog('🔍 Memulai proses bot Indeed di Tab khusus...');
        try {
          const metrics = await runIndeedBot(pageIndeed, config, indeedLog, indeedLimiter);
          totalAlreadyApplied += metrics.alreadyAppliedCount;
          totalErrors += metrics.errorCount;
        } catch (err: any) {
          indeedLog(`❌ Error: ${err.message || err}`);
          totalErrors++;
        } finally {
          try { await pageIndeed.close(); } catch {}
        }
      })());
    } else {
      onLog('⏩ Indeed dinonaktifkan di pengaturan.');
    }

    // Tunggu semua tab platform selesai bekerja
    if (tasks.length > 0) {
      onLog(`🚀 Menjalankan ${tasks.length} tab platform secara bersamaan...`);
      await Promise.allSettled(tasks);
    } else {
      onLog('⚠️ Tidak ada platform yang diaktifkan (Glints, Jobstreet, LinkedIn & Indeed semuanya nonaktif).');
    }

    onLog('--------------------------------------------------');
    onLog('📊 RINGKASAN SESI (SESSION SUMMARY):');
    onLog(`✅ Total Berhasil Dilamar / Disimulasikan: ${totalSuccess} pekerjaan`);
    onLog(`⏩ Total Dilewati (Sudah Dilamar): ${totalAlreadyApplied} pekerjaan`);
    onLog(`❌ Total Error: ${totalErrors} pekerjaan`);
    onLog('--------------------------------------------------');
    onLog('🏁 Sesi CV Blaster Selesai!');
  } catch (error: any) {
    onLog(`🚨 Fatal Bot Error: ${error.message || error}`);
  } finally {
    if (browser) {
      if (mode === 'headful') {
        onLog('⏳ Menunggu 5 detik sebelum menutup browser headful...');
        await new Promise(r => setTimeout(r, 5000));
      }
      await browser.close();
    }
    global.isBotRunning = false;
  }
}
