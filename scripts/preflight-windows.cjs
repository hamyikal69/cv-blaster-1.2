const fs = require('fs');
const path = require('path');
const required = ['package.json', 'package-lock.json', 'electron/main.js', 'electron-builder.json', 'src/app/page.tsx', 'src/lib/config.ts'];
const missing = required.filter(f => !fs.existsSync(path.join(process.cwd(), f)));
if (missing.length) {
  console.error('❌ Preflight gagal. File wajib tidak ditemukan:', missing.join(', '));
  process.exit(1);
}
if (process.platform !== 'linux' && process.platform !== 'win32') {
  console.error(`❌ Platform build tidak didukung: ${process.platform}`);
  process.exit(1);
}
console.log(`✅ Preflight OK: ${process.platform}/${process.arch}`);
console.log('ℹ️ Target: Windows x64 NSIS installer');
