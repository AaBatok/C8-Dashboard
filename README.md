# ⚡ C8 Dashboard — Cantor8 Wallet Report

Web dashboard untuk cek **Reward** dan **Balance** semua akun Cantor8 secara real-time.  
Data di-stream langsung ke browser saat proses berjalan — mendukung **200+ akun** tanpa masalah.

![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-5.x-000000?logo=express)
![License](https://img.shields.io/badge/License-MIT-blue)

---

## ✨ Fitur

- 📊 **Cek Reward** — reward accrued, volume, txns, rank
- 💰 **Cek Balance** — CC, USDCx, cETH
- 🔄 **Real-time Streaming** — data muncul satu per satu via SSE (Server-Sent Events)
- 📈 **Progress Bar** — lihat proses fetching secara live
- 🔍 **Search & Sort** — cari akun dan sort per kolom
- 📥 **Export CSV** — download hasil ke file CSV
- 🎨 **Premium Dark UI** — glassmorphism, animasi, responsive
- 📂 **Simple Config** — cukup 1 phrase per baris di `accounts.txt`

---

## 📋 Prasyarat

- [Node.js](https://nodejs.org/) versi **18** atau lebih baru
- VPS / server dengan akses internet

Cek versi Node.js:
```bash
node -v
```

> Jika belum terinstall, lihat bagian [Install Node.js](#install-nodejs) di bawah.

---

## 🚀 Instalasi & Menjalankan

### 1. Clone Repository

```bash
git clone https://github.com/AaBatok/C8-Dashboard
cd C8-Dashboard
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Buat File Akun

Buat file `accounts.txt` di folder yang sama. Isi dengan **mnemonic phrase**, satu phrase per baris:

```bash
nano accounts.txt
```

```
word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12
word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12
word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12
```

> - Satu phrase per baris
> - Nama akun otomatis: A1, A2, A3, ...
> - Baris kosong dan baris diawali `#` akan di-skip
> - Mendukung 200+ akun

**Contoh dengan komentar:**
```
# Batch 1
warfare zero park envelope fragile ...
leopard shove pulse explain dawn ...

# Batch 2
practice enroll oxygen ritual snap ...
toe squirrel figure ancient host ...
```

### 4. Jalankan

```bash
node report.js
```

Output yang muncul:
```
⚡ C8 Dashboard
   URL:      http://0.0.0.0:3000
   Accounts: 200 loaded from accounts.txt
```

### 5. Buka di Browser

```
http://IP_VPS_KAMU:3000
```

---

## ⚙️ Konfigurasi Lanjutan

### Ganti Port

Buat file `.env` dan tambahkan:

```env
WEB_PORT=8080
```

Atau jalankan langsung:

```bash
WEB_PORT=8080 node report.js
```

### Format .env (Alternatif)

Jika tidak ingin menggunakan `accounts.txt`, bisa menggunakan format `.env`:

```env
ACCOUNT_1_NAME=A1
ACCOUNT_1_MNEMONIC=word1 word2 word3 ...

ACCOUNT_2_NAME=A2
ACCOUNT_2_MNEMONIC=word1 word2 word3 ...
```

> **Prioritas:** `accounts.txt` → `.env`  
> Jika `accounts.txt` ada, `.env` untuk akun tidak dibaca.

---

## 🔧 Menjalankan di Background

### Opsi 1: PM2 (Direkomendasikan)

```bash
# Install PM2
npm install -g pm2

# Jalankan
pm2 start report.js --name c8-dashboard

# Auto-start saat VPS reboot
pm2 startup
pm2 save

# Perintah berguna lainnya
pm2 logs c8-dashboard    # Lihat log
pm2 restart c8-dashboard # Restart
pm2 stop c8-dashboard    # Stop
pm2 delete c8-dashboard  # Hapus
```

### Opsi 2: Screen

```bash
# Buat session baru
screen -S c8

# Jalankan
node report.js

# Detach: tekan Ctrl+A lalu D

# Re-attach
screen -r c8
```

### Opsi 3: Systemd Service

```bash
sudo nano /etc/systemd/system/c8-dashboard.service
```

```ini
[Unit]
Description=C8 Dashboard
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/c8notif
ExecStart=/usr/bin/node report.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable c8-dashboard
sudo systemctl start c8-dashboard

# Cek status
sudo systemctl status c8-dashboard

# Lihat log
journalctl -u c8-dashboard -f
```

---

## 📖 Cara Pakai

1. Buka `http://IP_VPS:3000` di browser
2. Klik **📊 Cek Reward** atau **💰 Cek Balance**
3. Tunggu proses — data muncul real-time di tabel, progress bar berjalan
4. Setelah selesai, bisa:
   - 🔍 **Search** — ketik nama akun untuk filter
   - ⬍ **Sort** — klik header kolom untuk urutkan
   - 📥 **Export** — klik tombol Export CSV untuk download

---

## 🗂️ Struktur File

```
c8notif/
├── report.js          # Server utama (Express + SSE + API)
├── config.json        # Konfigurasi API endpoint & derivation
├── accounts.txt       # Daftar mnemonic (1 per baris) ← BUAT INI
├── package.json       # Dependencies
├── .env               # (Opsional) Port & format akun alternatif
└── public/
    └── index.html     # Dashboard web UI
```

---

## ❓ Troubleshooting

| Masalah | Solusi |
|---------|--------|
| `ERR_MODULE_NOT_FOUND` | Jalankan `npm install` dulu |
| Port sudah dipakai | Ganti port: `WEB_PORT=8080 node report.js` |
| Tidak bisa akses dari browser | Pastikan firewall VPS membuka port (misal: `ufw allow 3000`) |
| 0 accounts loaded | Pastikan `accounts.txt` ada di folder yang sama dengan `report.js` |
| Fetch lambat / timeout | Normal untuk 200 akun (~2-5 menit). Data akan muncul satu per satu |

---

## 🔒 Keamanan

> ⚠️ **PENTING:** File `accounts.txt` berisi mnemonic phrase. Jangan pernah commit ke GitHub!

Pastikan tambahkan di `.gitignore`:

```
accounts.txt
.env
node_modules/
```

---

## <a id="install-nodejs"></a> 📦 Install Node.js (Jika Belum Ada)

### Ubuntu / Debian
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### CentOS / RHEL
```bash
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs
```

### Verifikasi
```bash
node -v   # v20.x.x
npm -v    # 10.x.x
```

---

## 📄 License

MIT License — Bebas digunakan dan dimodifikasi.
