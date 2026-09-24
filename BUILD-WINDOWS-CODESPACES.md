# CV Blaster — Build Windows `.exe` di GitHub Codespaces

Dokumen ini dibuat agar proses dari source ZIP sampai installer Windows bisa dilakukan tanpa menebak-nebak.

## Hasil akhir

Target utama:

`dist-electron/CV-Blaster-Setup-0.1.0-Windows-x64.exe`

Jenis installer: **NSIS**, 64-bit Windows. Installer memakai mode assisted (`oneClick=false`), sehingga pengguna dapat memilih folder instalasi dan aplikasi membuat shortcut Desktop + Start Menu.

## 1. Siapkan repository GitHub

1. Buat repository baru di GitHub, misalnya `cv-blaster`.
2. Extract ZIP project ini di komputer, lalu upload seluruh **isi folder project** ke repository. Jangan upload ZIP sebagai satu-satunya file project.
3. Pastikan `package.json` terlihat di root repository.

Struktur minimal:

```text
cv-blaster/
├─ .devcontainer/devcontainer.json
├─ .nvmrc
├─ electron/
├─ src/
├─ public/
├─ scripts/
├─ package.json
├─ package-lock.json
└─ electron-builder.json
```

## 2. Buka Codespace

GitHub → repository → **Code** → **Codespaces** → **Create codespace on main**.

Project sudah membawa `.devcontainer/devcontainer.json`, jadi Codespaces akan menggunakan Node 22 dan menjalankan `npm ci` setelah container dibuat.

Jika Codespace dibuat sebelum file `.devcontainer` masuk repository, lakukan **Rebuild Container** dari Command Palette.

## 3. Pastikan Node benar

Terminal:

```bash
node -v
npm -v
```

Node harus berada pada major version 22.

## 4. Install dependency

Jika `npm ci` belum otomatis selesai:

```bash
npm ci
```

Jangan menggunakan `npm install` untuk build final karena `npm ci` menjaga instalasi mengikuti lockfile.

## 5. Pastikan Wine tersedia

Codespaces berbasis Linux. Untuk membuat Windows installer dari Linux, electron-builder membutuhkan Wine untuk menjalankan tool Windows. Dokumentasi electron-builder merekomendasikan Docker image `electronuserland/builder:wine` untuk cross-platform build, atau Wine yang terpasang pada host Linux.

Cek:

```bash
wine --version
```

Jika belum ada:

```bash
sudo dpkg --add-architecture i386
sudo apt-get update
sudo apt-get install -y wine64 wine32
```

Lalu:

```bash
wine --version
```

Jika package `wine32` tidak tersedia pada image Codespaces yang dipakai, jangan mengubah source code. Gunakan Docker builder resmi electron-builder:

```bash
docker run --rm -ti \
  -v "$PWD":/project \
  -v "$HOME/.cache/electron":/root/.cache/electron \
  -v "$HOME/.cache/electron-builder":/root/.cache/electron-builder \
  electronuserland/builder:wine \
  /bin/bash -c "npm ci && npm run make:exe"
```

## 6. Jalankan satu perintah build

Setelah dependency dan Wine siap:

```bash
npm run make:exe
```

Script ini menjalankan:

1. Windows preflight.
2. `next build`.
3. `electron-builder --win nsis --x64`.

Jadi tidak perlu menjalankan tiga command build terpisah.

## 7. Cari hasil `.exe`

```bash
ls -lh dist-electron/
```

Target:

```text
CV-Blaster-Setup-0.1.0-Windows-x64.exe
```

Di VS Code Codespaces Explorer, buka folder `dist-electron`, klik kanan file `.exe`, lalu pilih **Download**.

## 8. Install di Windows

1. Pindahkan `.exe` ke Windows.
2. Double-click installer.
3. Pilih folder instalasi jika diperlukan.
4. Selesaikan instalasi.
5. Buka `CV Blaster` dari Desktop atau Start Menu.

## 9. Pengaturan pertama aplikasi

Isi **Profil Pelamar** terlebih dahulu.

Bagian tanggal lahir sekarang terdiri dari:

- Tanggal
- Bulan
- Tahun

Ketiganya disimpan internal sebagai `YYYY-MM-DD`.

Jangan mengandalkan Gemini untuk menebak DOB. Engine mengambil nilai profil tersebut secara deterministik saat JobStreet meminta hari, bulan, atau tahun.

## 10. Gemini API key

Masukkan API key melalui konfigurasi aplikasi/secret yang memang digunakan project. Jangan commit API key ke GitHub dan jangan menaruhnya langsung di source code.

## 11. Test pertama — jangan langsung banyak lamaran

Set:

```text
JobStreet       ON
Glints          OFF
LinkedIn        OFF
Indeed          OFF
Concurrency     1
Limit           1
Debug/Test      ON
```

Target test pertama adalah memeriksa:

- login JobStreet
- eligibility gate
- DOB day/month/year
- resume selection
- cover-letter selection
- cover-letter generation
- questionnaire strict mode
- tidak submit jika ada pertanyaan yang tidak dapat diverifikasi

## 12. Log yang diharapkan

Contoh:

```text
💼 Job: "Data Analyst" at "Example Company"
🧭 Eligibility: ELIGIBLE (confidence 88%)
🖱️ Mengklik tombol "Lamaran Cepat"...
Found RADIOBUTTON: "Select one option"
Options: [Unggah surat lamaran | Tulis surat lamaran | Jangan sertakan surat lamaran]
AI Decision: [Tulis surat lamaran]
✍️ Surat Lamaran AI dibuat khusus untuk "Data Analyst" di "Example Company".
```

Untuk DOB:

```text
Found DROPDOWN: "Select option"
AI Decision: [20]
Found DROPDOWN: "Select option"
AI Decision: [Jan]
Found DROPDOWN: "Select option"
AI Decision: [2002]
```

Nilai tanggal contoh di atas hanya ilustrasi format log; gunakan tanggal lahir yang Anda masukkan sendiri di Profil Pelamar.

## 13. Jika ada pertanyaan yang tidak dapat diverifikasi

Dalam JobStreet strict mode, bot **tidak boleh memilih jawaban asal**.

Log akan menunjukkan pertanyaan yang tidak dapat dijawab dan lamaran tersebut tidak diteruskan ke submit.

Ini sengaja: lebih baik satu lowongan dilewati daripada mengirim jawaban yang dibuat-buat.

## 14. Jika installer ditolak Windows SmartScreen

Build ini tidak menggunakan sertifikat code-signing komersial. Windows dapat menampilkan peringatan SmartScreen untuk executable yang belum ditandatangani.

Itu berbeda dengan installer yang rusak. Untuk distribusi publik/produksi, gunakan sertifikat code-signing Windows.

## 15. Jika build gagal

Simpan log:

```bash
DEBUG=electron-builder npm run make:exe 2>&1 | tee build-windows.log
```

Kemudian kirim **bagian error terakhir** saja. Jangan kirim API key, Google credentials JSON, cookie browser, atau token.

## 16. Verifikasi sebelum distribusi

Setelah `.exe` dibuat, lakukan test di Windows:

1. Install.
2. Buka aplikasi.
3. Isi Profil Pelamar.
4. Simpan konfigurasi.
5. Pastikan konfigurasi tetap ada setelah aplikasi ditutup dan dibuka lagi.
6. Login JobStreet melalui browser setup.
7. Jalankan satu lowongan.
8. Pastikan eligibility gate muncul.
9. Pastikan cover letter dibuat sesuai job.
10. Pastikan bot berhenti jika pertanyaan wajib tidak dapat diverifikasi.

## 17. Build berikutnya

Setelah source sudah berada di repository:

```bash
npm ci
npm run make:exe
```

Tidak perlu membuat project Electron baru dari nol.
