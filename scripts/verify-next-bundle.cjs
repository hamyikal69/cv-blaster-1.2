const fs = require('fs');
const path = require('path');

const root = process.cwd();
const requiredPackages = [
  'puppeteer',
  'puppeteer-extra',
  'puppeteer-extra-plugin-stealth',
];

console.log('🔎 Verifying Puppeteer runtime dependencies...');
for (const pkg of requiredPackages) {
  try {
    const resolved = require.resolve(pkg, { paths: [root] });
    console.log(`✅ ${pkg}: ${resolved}`);
  } catch (error) {
    console.error(`❌ Missing runtime package: ${pkg}`);
    console.error(error.message);
    process.exit(1);
  }
}

const serverDir = path.join(root, '.next', 'server');
if (!fs.existsSync(serverDir)) {
  console.error('❌ .next/server tidak ditemukan. Jalankan npm run build terlebih dahulu.');
  process.exit(1);
}

const suspiciousPatterns = [
  /puppeteer-extra-[0-9a-f]{8,}\b/gi,
  /puppeteer-extra-plugin-stealth-[0-9a-f]{8,}\b/gi,
];
const suspicious = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!/\.(?:js|mjs|cjs)$/.test(entry.name)) continue;
    const text = fs.readFileSync(full, 'utf8');
    for (const pattern of suspiciousPatterns) {
      if (pattern.test(text)) suspicious.push(full);
      pattern.lastIndex = 0;
    }
  }
}

walk(serverDir);

if (suspicious.length > 0) {
  console.error('❌ Production bundle verification FAILED.');
  for (const file of [...new Set(suspicious)]) console.error(`- ${file}`);
  process.exit(1);
}

console.log('✅ Puppeteer packages are installed.');
console.log('✅ No hashed puppeteer-extra runtime references detected.');
console.log('✅ Production bundle verification PASSED.');
