const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const axios = require('axios');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const GOOGLE_DRIVE_LINKS = {
  ffmpeg: 'https://drive.google.com/uc?export=download&id=1VRMZKo6fY6FM4uKCQHjU_K6kpC2iMEhj',
  ytdlp: 'https://drive.google.com/uc?export=download&id=1FXgvJR1q-D7rygyWnCNoXqlq_gSr-Ds5'
};

const BIN_DIR = path.join(__dirname, 'bin');

async function ensureBinDir() {
  if (!fs.existsSync(BIN_DIR)) {
    await fsPromises.mkdir(BIN_DIR, { recursive: true });
  }
}

async function downloadFromGoogleDrive(url, destPath) {
  try {
    const response = await axios.get(url, { responseType: 'stream' });
    const writer = fs.createWriteStream(destPath);
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  } catch (err) {
    throw new Error(`خطا در دانلود فایل: ${err.message}`);
  }
}

async function makeExecutable(filePath) {
  try {
    if (process.platform !== 'win32') {
      await execPromise(`chmod +x ${filePath}`);
      console.log(`پرمیشن ${filePath} تنظیم شد.`);
    }
  } catch (err) {
    throw new Error(`خطا در تنظیم پرمیشن: ${err.message}`);
  }
}

async function setupBinaries() {
  try {
    await ensureBinDir();
    const ffmpegPath = path.join(BIN_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    const ytdlpPath = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
    if (!fs.existsSync(ffmpegPath)) {
      console.log('دانلود ffmpeg...');
      await downloadFromGoogleDrive(GOOGLE_DRIVE_LINKS.ffmpeg, ffmpegPath);
      await makeExecutable(ffmpegPath);
      console.log('ffmpeg دانلود شد.');
    }
    if (!fs.existsSync(ytdlpPath)) {
      console.log('دانلود yt-dlp...');
      await downloadFromGoogleDrive(GOOGLE_DRIVE_LINKS.ytdlp, ytdlpPath);
      await makeExecutable(ytdlpPath);
      console.log('yt-dlp دانلود شد.');
    }
    return { ffmpegPath, ytdlpPath };
  } catch (err) {
    console.error('خطا در راه‌اندازی فایل‌های باینری:', err.message);
    throw err;
  }
}

module.exports = { setupBinaries, ensureBinDir, downloadFromGoogleDrive, makeExecutable };