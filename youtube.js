const { Markup } = require('telegraf');
const { exec } = require('child_process');
const util = require('util');
const path = require('path');
const fs = require('fs').promises;
const axios = require('axios');
const FormData = require('form-data');
const { Scenes } = require('telegraf');
const { BaseScene } = Scenes;

const execPromise = util.promisify(exec);

// ثابت‌ها
const MAX_FILE_SIZE_MB = 50; // حداکثر حجم فایل برای تلگرام (مگابایت)
const UPLOAD_TIMEOUT_MS = 60000; // تایم‌اوت آپلود به tmpfiles.org
const PROGRESS_UPDATE_INTERVAL_MS = 3000; // فاصله به‌روزرسانی نوار پیشرفت
const UPLOAD_SIMULATION_DURATION_MS = 30000; // مدت زمان شبیه‌سازی آپلود
const VALID_QUALITIES = ['360p', '480p', '720p', '1080p'];
const YOUTUBE_URL_REGEX = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+/;
const TEMP_FILE_CLEANUP_DELAY_MS = 5000; // تأخیر برای اطمینان از کامل شدن نوشتن فایل

// تابع کمکی برای تأخیر
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// تابع اطمینان از وجود دایرکتوری کاربر
const ensureUserDir = async (chatId) => {
  const dir = path.join(__dirname, 'Uploads', String(chatId));
  try {
    await fs.mkdir(dir, { recursive: true });
    console.log(`[YouTube] Created directory: ${dir}`);
    return dir;
  } catch (err) {
    console.error(`[YouTube] Error creating directory ${dir}: ${err.message}`);
    throw new Error(`خطا در ایجاد دایرکتوری: ${err.message}`);
  }
};

// تابع آپلود فایل به tmpfiles.org
const uploadToTmpFiles = async (filePath) => {
  try {
    const form = new FormData();
    form.append('file', require('fs').createReadStream(filePath));
    const response = await axios.post('https://tmpfiles.org/api/v1/upload', form, {
      headers: form.getHeaders(),
      timeout: UPLOAD_TIMEOUT_MS,
    });
    if (response.data?.data?.url) {
      return response.data.data.url;
    }
    throw new Error('لینک دانلود از tmpfiles.org دریافت نشد.');
  } catch (err) {
    console.error(`[YouTube] Error uploading to tmpfiles.org: ${err.message}`);
    throw new Error(`خطا در آپلود به tmpfiles.org: ${err.message}`);
  }
};

// تابع حذف فایل‌های موقت
const cleanupTempFiles = async (userDir, fileBaseName) => {
  try {
    const files = await fs.readdir(userDir);
    const tempFiles = files.filter(
      (file) => file.startsWith(fileBaseName) && (file.includes('.part') || file.includes('.f'))
    );
    for (const file of tempFiles) {
      await fs.unlink(path.join(userDir, file));
      console.log(`[YouTube] Deleted temporary file: ${file}`);
    }
  } catch (err) {
    console.error(`[YouTube] Error cleaning up temp files: ${err.message}`);
  }
};

// صحنه دانلود یوتیوب
const downloadYouTubeScene = new BaseScene('DOWNLOAD_YOUTUBE_SCENE');

downloadYouTubeScene.enter(async (ctx) => {
  console.log(`[YouTube] User ${ctx.chat.id} entered DOWNLOAD_YOUTUBE_SCENE`);
  ctx.session.downloadYouTube = { step: 'url' };
  try {
    await ctx.reply(
      '🔗 لینک ویدیو یوتیوب را وارد کنید:',
      Markup.keyboard([['لغو']]).oneTime().resize()
    );
  } catch (err) {
    console.error(`[YouTube] Error sending enter message: ${err.message}`);
    await ctx.reply('❌ خطا در شروع فرایند دانلود.');
  }
});

downloadYouTubeScene.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  console.log(`[YouTube] User ${ctx.chat.id} sent: ${text}`);

  if (text === 'لغو') {
    delete ctx.session.downloadYouTube;
    await ctx.reply('❌ عملیات لغو شد.', Markup.removeKeyboard());
    return ctx.scene.leave();
  }

  const dy = ctx.session.downloadYouTube;

  if (dy?.step === 'url') {
    if (!YOUTUBE_URL_REGEX.test(text)) {
      console.log(`[YouTube] Invalid YouTube URL: ${text}`);
      await ctx.reply('❌ لطفاً یک لینک معتبر یوتیوب وارد کنید (مثل https://youtu.be/...)');
      return;
    }
    dy.step = 'choose_quality';
    dy.url = text;
    await ctx.reply(
      '📽️ کیفیت ویدیو را انتخاب کنید:',
      Markup.keyboard([['360p', '480p'], ['720p', '1080p'], ['لغو']]).oneTime().resize()
    );
  } else if (dy?.step === 'choose_quality') {
    if (!VALID_QUALITIES.includes(text)) {
      await ctx.reply('❌ لطفاً یکی از کیفیت‌های 360p، 480p، 720p یا 1080p را انتخاب کنید.');
      return;
    }

    const quality = text;
    const { url } = dy;
    let conn;

    try {
      console.log(`[YouTube] Downloading video from ${url} with quality ${quality}`);
      conn = await pool.getConnection();
      const userDir = await ensureUserDir(ctx.chat.id);
      const fileBaseName = `YouTube_${Date.now()}`;
      const filePathMp4 = path.join(userDir, `${fileBaseName}.mp4`);
      const filePathWebm = path.join(userDir, `${fileBaseName}.webm`);

      const { ffmpegPath, ytdlpPath } = ctx.session.binaries || {};
      if (!ffmpegPath || !ytdlpPath) {
        throw new Error('فایل‌های اجرایی ffmpeg یا yt-dlp در دسترس نیستند.');
      }

      // نقشه کیفیت برای yt-dlp
      const qualityMap = {
        '360p': 'bestvideo[height<=360]+bestaudio/best[height<=360]',
        '480p': 'bestvideo[height<=480]+bestaudio/best[height<=480]',
        '720p': 'bestvideo[height<=720]+bestaudio/best[height<=720]',
        '1080p': 'bestvideo[height<=1080]+bestaudio/best[height<=1080]',
      };
      const format = qualityMap[quality];

      // اجرای yt-dlp
      const command = `"${ytdlpPath}" -f "${format}" -o "${filePathMp4}" --ffmpeg-location "${ffmpegPath}" --no-part "${url}"`;
      console.log(`[YouTube] Executing command: ${command}`);

      const { stdout, stderr } = await execPromise(command);
      console.log(`[YouTube] yt-dlp stdout: ${stdout}`);
      if (stderr) console.warn(`[YouTube] yt-dlp stderr: ${stderr}`);

      // تأخیر برای اطمینان از کامل شدن نوشتن فایل
      await delay(TEMP_FILE_CLEANUP_DELAY_MS);

      // بررسی وجود فایل
      let finalFilePath = filePathMp4;
      if (await fs.access(filePathMp4).then(() => true).catch(() => false)) {
        console.log(`[YouTube] Found output file: ${filePathMp4}`);
      } else if (await fs.access(filePathWebm).then(() => true).catch(() => false)) {
        console.log(`[YouTube] Found output file: ${filePathWebm}`);
        finalFilePath = filePathWebm;
      } else {
        const filesInDir = (await fs.readdir(userDir)).filter(
          (file) => file.startsWith(fileBaseName) && (file.endsWith('.mp4') || file.endsWith('.webm'))
        );
        if (filesInDir.length > 0) {
          finalFilePath = path.join(userDir, filesInDir[0]);
          console.log(`[YouTube] Using matching file: ${finalFilePath}`);
        } else {
          throw new Error('فایل ویدیو دانلود نشد: هیچ فایلی یافت نشد.');
        }
      }

      // حذف فایل‌های موقت
      await cleanupTempFiles(userDir, fileBaseName);

      // ذخیره در دیتابیس
      const [folderResult] = await conn.execute(
        'INSERT INTO folders (chat_id, folder_name) VALUES (?, ?)',
        [ctx.chat.id, `YouTube_${Date.now()}`]
      );
      const folderId = folderResult.insertId;

      await conn.execute(
        'INSERT INTO folder_files (folder_id, file_path, file_type) VALUES (?, ?, ?)',
        [folderId, finalFilePath, 'video']
      );

      dy.step = 'choose_action';
      dy.finalFilePath = finalFilePath;
      dy.folderId = folderId;

      await ctx.reply(
        '✅ ویدیو دانلود و ذخیره شد!\nمی‌خواهید در تلگرام ارسال شود یا در پوشه بماند؟',
        Markup.keyboard([['📤 ارسال به تلگرام', '📁 ذخیره در پوشه'], ['لغو']]).oneTime().resize()
      );
      console.log(`[YouTube] Asked user ${ctx.chat.id} to choose action for file: ${finalFilePath}`);
    } catch (err) {
      console.error(`[YouTube] Error in DOWNLOAD_YOUTUBE_SCENE: ${err.message}`);
      await ctx.reply(`❌ خطا در دانلود: ${err.message}`);
      delete ctx.session.downloadYouTube;
      return ctx.scene.leave();
    } finally {
      if (conn && dy.step !== 'choose_action') conn.release();
    }
  } else if (dy?.step === 'choose_action') {
    const action = text;
    const { finalFilePath, folderId } = dy;
    let conn;

    try {
      conn = await pool.getConnection();

      if (action === '📤 ارسال به تلگرام') {
        const stats = await fs.stat(finalFilePath);
        const fileSizeMB = stats.size / (1024 * 1024);

        if (fileSizeMB > MAX_FILE_SIZE_MB) {
          const downloadLink = await uploadToTmpFiles(finalFilePath);
          await ctx.reply(
            `❌ فایل (${fileSizeMB.toFixed(2)} مگابایت) برای تلگرام خیلی بزرگ است.\n` +
              `لینک دانلود (2 ساعت اعتبار): ${downloadLink}`,
            Markup.removeKeyboard()
          );
          console.log(`[YouTube] Generated download link for user ${ctx.chat.id}: ${downloadLink}`);
        } else {
          const statusMessage = await ctx.reply('⏳ در حال ارسال ویدیو... 0%');
          const messageId = statusMessage.message_id;

          // شبیه‌سازی نوار پیشرفت
          let progress = 0;
          const interval = setInterval(async () => {
            progress += 10;
            if (progress <= 100) {
              try {
                await ctx.telegram.editMessageText(
                  ctx.chat.id,
                  messageId,
                  undefined,
                  `⏳ در حال ارسال ویدیو... ${progress}%`
                );
              } catch (err) {
                console.warn(`[YouTube] Error updating progress: ${err.message}`);
              }
            }
          }, PROGRESS_UPDATE_INTERVAL_MS);

          try {
            await ctx.replyWithVideo(
              { source: require('fs').createReadStream(finalFilePath) },
              { caption: '🎥 ویدیوی شما!' }
            );
            clearInterval(interval);
            await ctx.telegram.editMessageText(
              ctx.chat.id,
              messageId,
              undefined,
              '✅ ویدیو با موفقیت ارسال شد!',
              Markup.removeKeyboard()
            );
            console.log(`[YouTube] Sent video to user ${ctx.chat.id}: ${finalFilePath}`);
          } catch (err) {
            clearInterval(interval);
            throw new Error(`خطا در آپلود ویدیو: ${err.message}`);
          }
        }
      } else if (action === '📁 ذخیره در پوشه') {
        await ctx.reply('📁 ویدیو در پوشه ذخیره شد.', Markup.removeKeyboard());
        console.log(`[YouTube] Kept video in folder for user ${ctx.chat.id}: ${finalFilePath}`);
      } else {
        await ctx.reply('❌ لطفاً یکی از گزینه‌ها را انتخاب کنید.');
        return;
      }

      delete ctx.session.downloadYouTube;
      return ctx.scene.leave();
    } catch (err) {
      console.error(`[YouTube] Error in choose_action: ${err.message}`);
      await ctx.reply(`❌ خطا: ${err.message}`, Markup.removeKeyboard());
      return ctx.scene.leave();
    } finally {
      if (conn) conn.release();
    }
  } else {
    console.log(`[YouTube] Invalid step for user ${ctx.chat.id}`);
    await ctx.reply('❌ لطفاً لینک یوتیوب را وارد کنید.');
  }
});

// تابع ثبت صحنه و دستورات
const registerYouTube = async (bot, stage, pool) => {
  try {
    stage.register(downloadYouTubeScene);

    bot.command('DownloadYouTube', async (ctx) => {
      console.log(`[YouTube] User ${ctx.chat.id} triggered /DownloadYouTube`);
      return ctx.scene.enter('DOWNLOAD_YOUTUBE_SCENE');
    });
  } catch (err) {
    console.error('[YouTube] Error registering YouTube feature:', err.message);
    throw new Error(`خطا در ثبت قابلیت یوتیوب: ${err.message}`);
  }
};

module.exports = { registerYouTube };