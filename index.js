require('dotenv').config();
const { Telegraf, Scenes, session, Markup } = require('telegraf');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const bcrypt = require('bcrypt');
const pool = require('./db');
const { registerYouTube } = require('./youtube');
const { setupBinaries } = require('./utils');

// ثابت‌ها
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 مگابایت
const SALT_ROUNDS = 10; // برای bcrypt
const MAX_TEXT_LENGTH = 4000; // حداکثر طول متن
const MESSAGE_DELETE_DELAY = 600000; // 10 دقیقه برای حذف پیام‌ها
const HELP_TEXT = `
سلام 👋
به ربات مدیریت پوشه‌ها خوش آمدید!
دستورات:
/CrFolders   → ساخت پوشه جدید
/OpenFolder  → باز کردن پوشه
/ListFolders → لیست پوشه‌ها
/SearchFolders → جستجوی پوشه‌ها
/DownloadYouTube → دانلود ویدیو از یوتیوب
`;

// تنظیمات ربات
const bot = new Telegraf(process.env.BOT_TOKEN, {
  telegram: {
    // برای استفاده از پراکسی، این خط را فعال کنید
    // agent: new (require('https-proxy-agent'))('http://your_proxy:port')
  }
});
const { BaseScene, Stage } = Scenes;

// بررسی توکن ربات
if (!process.env.BOT_TOKEN) {
  console.error('خطا: توکن ربات در فایل .env تنظیم نشده است.');
  process.exit(1);
}

// تست اتصال به تلگرام
bot.telegram.getMe()
  .then(botInfo => console.log(`ربات متصل شد: @${botInfo.username}`))
  .catch(err => {
    console.error('خطا در اتصال به تلگرام:', err.message);
    process.exit(1);
  });

// تابع اسکیپ کاراکترهای خاص برای MarkdownV2
const escapeMarkdownV2 = (text) => text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');

// تابع اطمینان از وجود دایرکتوری کاربر
const ensureUserDir = (chatId) => {
  const dir = path.join(__dirname, 'Uploads', String(chatId));
  if (!require('fs').existsSync(dir)) {
    require('fs').mkdirSync(dir, { recursive: true });
  }
  return dir;
};

// تابع دانلود فایل از تلگرام
const downloadFile = async (fileId, destBase, fileType) => {
  try {
    const file = await bot.telegram.getFile(fileId);
    if (file.file_size > MAX_FILE_SIZE) {
      throw new Error('فایل بزرگ‌تر از 20 مگابایت است.');
    }
    const ext = getFileExtension(file, fileType);
    const destPath = path.join(destBase, path.basename(`${destBase}${ext}`)); // جلوگیری از Directory Traversal
    const fileLink = await bot.telegram.getFileLink(fileId);
    const writer = require('fs').createWriteStream(destPath);
    const response = await axios.get(fileLink.href, { responseType: 'stream' });
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
      writer.on('finish', () => resolve(destPath));
      writer.on('error', reject);
    });
  } catch (err) {
    throw new Error(`خطا در دانلود فایل: ${err.message}`);
  }
};

// تابع دریافت پسوند فایل
const getFileExtension = (file, fileType) => {
  if (file.mime_type) {
    switch (file.mime_type) {
      case 'image/jpeg': return '.jpg';
      case 'image/png': return '.png';
      case 'video/mp4': return '.mp4';
      case 'audio/mpeg': return '.mp3';
      case 'audio/ogg': return '.ogg';
      case 'image/gif': return '.gif';
      default: break;
    }
  }
  switch (fileType) {
    case 'animation': return '.mp4';
    case 'video': return '.mp4';
    case 'photo': return '.jpg';
    case 'audio': return '.mp3';
    case 'voice': return '.ogg';
    case 'sticker': return '.webp';
    default: return '.bin';
  }
};

// توابع اعتبارسنجی
const isValidFolderName = (name) => name.length <= 255 && /^[a-zA-Z0-9_\-\u0600-\u06FF\s]+$/.test(name);
const isValidPassword = (password) => password.length >= 4;
const isValidText = (text) => text.length <= MAX_TEXT_LENGTH;

// تابع ارسال و حذف پیام
const replyAndDelete = async (ctx, method, content, options = {}, delay = MESSAGE_DELETE_DELAY) => {
  try {
    const sentMessage = await ctx[method](content, options);
    setTimeout(async () => {
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, sentMessage.message_id);
      } catch (err) {
        console.error(`خطا در حذف پیام ${sentMessage.message_id}:`, err.message);
      }
    }, delay);
    return sentMessage;
  } catch (err) {
    console.error(`خطا در ارسال پیام: ${err.message}`);
    throw err;
  }
};

// تابع نمایش محتوای پوشه
const showFolderContent = async (ctx, folder) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const [files] = await conn.execute('SELECT * FROM folder_files WHERE folder_id = ?', [folder.id]);
    let caption = `📁 *${escapeMarkdownV2(folder.folder_name)}*\n`;
    if (folder.description) caption += `📝 توضیحات: ${escapeMarkdownV2(folder.description)}\n`;
    if (folder.tags) caption += `🏷️ تگ‌ها: ${escapeMarkdownV2(folder.tags)}\n`;
    caption += `🕒 ایجاد شده در: ${escapeMarkdownV2(new Date(folder.created_at).toLocaleString('fa-IR'))}`;
    
    if (caption.length > 1000) caption = caption.slice(0, 1000) + '...';

    const buttons = Markup.inlineKeyboard([
      Markup.button.callback('نمایش جزئیات', `DETAILS_${folder.id}`),
      Markup.button.callback('اضافه کردن', `ADD_${folder.id}`),
      Markup.button.callback('اشتراک‌گذاری', `SHARE_${folder.id}`),
      Markup.button.callback('حذف', `DELETE_${folder.id}`)
    ]);

    if (folder.cover_file_path) {
      await replyAndDelete(ctx, 'replyWithPhoto', { source: require('fs').createReadStream(folder.cover_file_path) }, {
        caption,
        parse_mode: 'MarkdownV2',
        ...buttons
      });
    } else {
      await replyAndDelete(ctx, 'reply', caption, { parse_mode: 'MarkdownV2', ...buttons });
    }

    // ارسال مدیاگروپ به‌صورت دسته‌های 10تایی برای رعایت محدودیت تلگرام
    const mediaGroup = files.filter(f => ['photo', 'video'].includes(f.file_type))
      .map(f => ({ type: f.file_type, media: { source: require('fs').createReadStream(f.file_path) } }));
    for (let i = 0; i < mediaGroup.length; i += 10) {
      const chunk = mediaGroup.slice(i, i + 10);
      const sentMessages = await ctx.replyWithMediaGroup(chunk);
      sentMessages.forEach(msg => {
        setTimeout(async () => {
          try {
            await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id);
          } catch (err) {
            console.error(`خطا در حذف پیام ${msg.message_id}:`, err.message);
          }
        }, 30000);
      });
    }

    for (const file of files) {
      if (file.file_type === 'text') {
        let textContent = file.text_content || 'متن خالی';
        if (textContent.length > 1000) textContent = textContent.slice(0, 1000) + '...';
        await replyAndDelete(ctx, 'reply', `📜 متن: ${escapeMarkdownV2(textContent)}`, { parse_mode: 'MarkdownV2' });
      } else if (!['photo', 'video'].includes(file.file_type)) {
        const fileStream = require('fs').createReadStream(file.file_path);
        switch (file.file_type) {
          case 'animation': await replyAndDelete(ctx, 'replyWithAnimation', { source: fileStream }); break;
          case 'audio': await replyAndDelete(ctx, 'replyWithAudio', { source: fileStream }); break;
          case 'voice': await replyAndDelete(ctx, 'replyWithVoice', { source: fileStream }); break;
          case 'document': await replyAndDelete(ctx, 'replyWithDocument', { source: fileStream }); break;
          case 'sticker': await replyAndDelete(ctx, 'replyWithSticker', { source: fileStream }); break;
        }
      }
    }
    await replyAndDelete(ctx, 'reply', 'دستورات دیگر را امتحان کنید.', Markup.removeKeyboard());
  } catch (err) {
    await replyAndDelete(ctx, 'reply', `❌ خطا در باز کردن پوشه: ${err.message}`);
    console.error('خطا در showFolderContent:', err);
  } finally {
    if (conn) conn.release();
  }
};

// صحنه‌ها
const createFolderScene = new BaseScene('CREATE_FOLDER_SCENE');
createFolderScene.enter(ctx => {
  ctx.session.newFolder = { step: 'name', files: [] };
  return replyAndDelete(ctx, 'reply', '📁 نام پوشه را وارد کنید:', Markup.keyboard([['لغو']]).oneTime().resize());
});
createFolderScene.on('text', async ctx => {
  const nf = ctx.session.newFolder;
  const text = ctx.message.text.trim();
  if (text === 'لغو') {
    delete ctx.session.newFolder;
    await replyAndDelete(ctx, 'reply', '❌ عملیات لغو شد.', Markup.removeKeyboard());
    return ctx.scene.leave();
  }
  if (nf.step === 'name') {
    if (!isValidFolderName(text)) {
      return replyAndDelete(ctx, 'reply', '⚠️ نام پوشه فقط می‌تواند شامل حروف، اعداد، خط زیر (_) و فاصله باشد.');
    }
    let conn;
    try {
      conn = await pool.getConnection();
      const [rows] = await conn.execute('SELECT 1 FROM folders WHERE chat_id = ? AND folder_name = ?', [ctx.chat.id, text]);
      if (rows.length) return replyAndDelete(ctx, 'reply', '⚠️ این نام قبلاً استفاده شده است.');
      nf.folder_name = text;
      nf.step = 'files';
      return replyAndDelete(ctx, 'reply', '📤 فایل‌ها یا متن را ارسال کنید. پایان: "ارسال تکمیل شد."', Markup.keyboard([['ارسال تکمیل شد.'], ['لغو']]).oneTime().resize());
    } catch (err) {
      await replyAndDelete(ctx, 'reply', `❌ خطا: ${err.message}`);
      console.error('خطا در CREATE_FOLDER_SCENE (name):', err);
    } finally {
      if (conn) conn.release();
    }
  }
  if (nf.step === 'files') {
    if (text === 'ارسال تکمیل شد.') {
      if (nf.files.length === 0) return replyAndDelete(ctx, 'reply', '⚠️ هیچ فایل یا متنی ارسال نشده است.');
      nf.step = 'description';
      return replyAndDelete(ctx, 'reply', '✏️ توضیحات (اختیاری):', Markup.keyboard([['نه، ممنون'], ['لغو']]).oneTime().resize());
    }
    if (!isValidText(text)) {
      return replyAndDelete(ctx, 'reply', `⚠️ متن طولانی‌تر از ${MAX_TEXT_LENGTH} کاراکتر است.`);
    }
    nf.files.push({ fileType: 'text', textContent: text });
    return replyAndDelete(ctx, 'reply', '✅ متن دریافت شد.');
  }
  if (nf.step === 'description') {
    if (text !== 'نه، ممنون') nf.description = text.slice(0, 1000);
    nf.step = 'tags';
    return replyAndDelete(ctx, 'reply', '🏷️ تگ‌ها (اختیاری):', Markup.keyboard([['نه، ممنون'], ['لغو']]).oneTime().resize());
  }
  if (nf.step === 'tags') {
    if (text !== 'نه، ممنون') nf.tags = text.slice(0, 255);
    nf.step = 'password';
    return replyAndDelete(ctx, 'reply', '🔒 آیا می‌خواهید برای پوشه رمز عبور تنظیم کنید؟', Markup.keyboard([['بله'], ['خیر'], ['لغو']]).oneTime().resize());
  }
  if (nf.step === 'password') {
    if (text === 'خیر') {
      nf.password = null;
      nf.step = 'cover';
      return replyAndDelete(ctx, 'reply', '🖼️ عکس کاور (اختیاری):', Markup.keyboard([['نه، ممنون'], ['لغو']]).oneTime().resize());
    }
    if (text === 'بله') {
      nf.step = 'set_password';
      return replyAndDelete(ctx, 'reply', '🔑 رمز عبور را وارد کنید (حداقل 4 کاراکتر):', Markup.keyboard([['لغو']]).oneTime().resize());
    }
  }
  if (nf.step === 'set_password') {
    if (!isValidPassword(text)) return replyAndDelete(ctx, 'reply', '⚠️ رمز عبور باید حداقل 4 کاراکتر باشد.');
    nf.password = await bcrypt.hash(text, SALT_ROUNDS);
    nf.step = 'cover';
    return replyAndDelete(ctx, 'reply', '🖼️ عکس کاور (اختیاری):', Markup.keyboard([['نه، ممنون'], ['لغو']]).oneTime().resize());
  }
  if (nf.step === 'cover' && text === 'نه، ممنون') {
    await saveFolder(ctx);
    await replyAndDelete(ctx, 'reply', '✅ پوشه ذخیره شد.', Markup.removeKeyboard());
    return ctx.scene.leave();
  }
});
createFolderScene.on(['document', 'photo', 'video', 'animation', 'audio', 'voice', 'sticker'], async ctx => {
  const nf = ctx.session.newFolder;
  if (nf.step === 'files') {
    let fid, fileType;
    if (ctx.message.document) { fid = ctx.message.document.file_id; fileType = 'document'; }
    else if (ctx.message.photo) { fid = ctx.message.photo[ctx.message.photo.length - 1].file_id; fileType = 'photo'; }
    else if (ctx.message.video) { fid = ctx.message.video.file_id; fileType = 'video'; }
    else if (ctx.message.animation) { fid = ctx.message.animation.file_id; fileType = 'animation'; }
    else if (ctx.message.audio) { fid = ctx.message.audio.file_id; fileType = 'audio'; }
    else if (ctx.message.voice) { fid = ctx.message.voice.file_id; fileType = 'voice'; }
    else if (ctx.message.sticker) {
      if (ctx.message.sticker.is_animated) return replyAndDelete(ctx, 'reply', '⚠️ استیکر متحرک پشتیبانی نمی‌شود.');
      fid = ctx.message.sticker.file_id; fileType = 'sticker';
    }
    try {
      const file = await bot.telegram.getFile(fid);
      if (file.file_size > MAX_FILE_SIZE) return replyAndDelete(ctx, 'reply', '⚠️ فایل بزرگ‌تر از 20 مگابایت است.');
      nf.files.push({ fid, fileType });
      await replyAndDelete(ctx, 'reply', '✅ فایل دریافت شد.');
    } catch (err) {
      await replyAndDelete(ctx, 'reply', `❌ خطا در دریافت فایل: ${err.message}`);
      console.error('خطا در CREATE_FOLDER_SCENE (files):', err);
    }
  } else if (nf.step === 'cover' && ctx.message.photo) {
    try {
      const fid = ctx.message.photo[ctx.message.photo.length - 1].file_id;
      const file = await bot.telegram.getFile(fid);
      if (file.file_size > MAX_FILE_SIZE) return replyAndDelete(ctx, 'reply', '⚠️ عکس کاور بزرگ‌تر از 20 مگابایت است.');
      nf.image_file_id = fid;
      await saveFolder(ctx);
      await replyAndDelete(ctx, 'reply', '✅ پوشه ذخیره شد.', Markup.removeKeyboard());
      return ctx.scene.leave();
    } catch (err) {
      await replyAndDelete(ctx, 'reply', `❌ خطا در ذخیره کاور: ${err.message}`);
      console.error('خطا در CREATE_FOLDER_SCENE (cover):', err);
    }
  }
});

async function saveFolder(ctx) {
  const nf = ctx.session.newFolder;
  let conn;
  try {
    conn = await pool.getConnection();
    const [result] = await conn.execute(
      'INSERT INTO folders (chat_id, folder_name, description, tags, password, cover_file_path) VALUES (?, ?, ?, ?, ?, ?)',
      [ctx.chat.id, nf.folder_name, nf.description || null, nf.tags || null, nf.password || null, null]
    );
    const folderId = result.insertId;
    const userDir = ensureUserDir(ctx.chat.id);
    for (const file of nf.files) {
      if (file.fileType === 'text') {
        await conn.execute(
          'INSERT INTO folder_files (folder_id, file_path, file_type, text_content) VALUES (?, ?, ?, ?)',
          [folderId, '', 'text', file.textContent]
        );
      } else {
        const [fileResult] = await conn.execute(
          'INSERT INTO folder_files (folder_id, file_path, file_type) VALUES (?, ?, ?)',
          [folderId, 'pending', file.fileType]
        );
        const fileId = fileResult.insertId;
        const destBase = path.join(userDir, `${folderId}_${fileId}`);
        const filePath = await downloadFile(file.fid, destBase, file.fileType);
        await conn.execute('UPDATE folder_files SET file_path = ? WHERE id = ?', [filePath, fileId]);
      }
    }
    if (nf.image_file_id) {
      const destBase = path.join(userDir, `${folderId}_cover`);
      const coverPath = await downloadFile(nf.image_file_id, destBase, 'photo');
      await conn.execute('UPDATE folders SET cover_file_path = ? WHERE id = ?', [coverPath, folderId]);
    }
  } catch (err) {
    await replyAndDelete(ctx, 'reply', `❌ خطا در ذخیره‌سازی: ${err.message}`);
    console.error('خطا در saveFolder:', err);
  } finally {
    if (conn) conn.release();
    delete ctx.session.newFolder;
  }
}

const openFolderScene = new BaseScene('OPEN_FOLDER_SCENE');
openFolderScene.enter(ctx => replyAndDelete(ctx, 'reply', '📁 نام پوشه را وارد کنید:', Markup.keyboard([['لغو']]).oneTime().resize()));
openFolderScene.on('text', async ctx => {
  const text = ctx.message.text.trim();
  if (text === 'لغو') {
    await replyAndDelete(ctx, 'reply', '❌ عملیات لغو شد.', Markup.removeKeyboard());
    return ctx.scene.leave();
  }
  let conn;
  try {
    conn = await pool.getConnection();
    const [rows] = await conn.execute('SELECT * FROM folders WHERE chat_id = ? AND folder_name = ?', [ctx.chat.id, text]);
    if (!rows.length) return replyAndDelete(ctx, 'reply', '⚠️ پوشه یافت نشد.');
    const folder = rows[0];
    if (folder.password) {
      ctx.session.folderToOpen = folder;
      return ctx.scene.enter('DETAIL_PASSWORD_SCENE');
    }
    await showFolderContent(ctx, folder);
    return ctx.scene.leave();
  } catch (err) {
    await replyAndDelete(ctx, 'reply', `❌ خطا: ${err.message}`);
    console.error('خطا در OPEN_FOLDER_SCENE:', err);
  } finally {
    if (conn) conn.release();
  }
});

const listFoldersScene = new BaseScene('LIST_FOLDERS_SCENE');
listFoldersScene.enter(async ctx => {
  let conn;
  try {
    conn = await pool.getConnection();
    const [rows] = await conn.execute('SELECT folder_name FROM folders WHERE chat_id = ?', [ctx.chat.id]);
    if (!rows.length) return replyAndDelete(ctx, 'reply', '⚠️ هیچ پوشه‌ای یافت نشد.', Markup.removeKeyboard());
    const folderList = rows.map(r => r.folder_name).join('\n');
    await replyAndDelete(ctx, 'reply', `📋 لیست پوشه‌ها:\n${folderList}`, Markup.removeKeyboard());
  } catch (err) {
    await replyAndDelete(ctx, 'reply', `❌ خطا: ${err.message}`);
    console.error('خطا در LIST_FOLDERS_SCENE:', err);
  } finally {
    if (conn) conn.release();
    return ctx.scene.leave();
  }
});

const addFilesScene = new BaseScene('ADD_FILES_SCENE');
addFilesScene.enter(ctx => {
  ctx.session.addFiles = { step: 'folder', files: [] };
  return replyAndDelete(ctx, 'reply', '📁 نام پوشه را وارد کنید:', Markup.keyboard([['لغو']]).oneTime().resize());
});
addFilesScene.on('text', async ctx => {
  const af = ctx.session.addFiles;
  const text = ctx.message.text.trim();
  if (text === 'لغو') {
    delete ctx.session.addFiles;
    await replyAndDelete(ctx, 'reply', '❌ عملیات لغو شد.', Markup.removeKeyboard());
    return ctx.scene.leave();
  }
  if (af.step === 'folder') {
    let conn;
    try {
      conn = await pool.getConnection();
      const [rows] = await conn.execute('SELECT id FROM folders WHERE chat_id = ? AND folder_name = ?', [ctx.chat.id, text]);
      if (!rows.length) return replyAndDelete(ctx, 'reply', '⚠️ پوشه یافت نشد.');
      af.folder_id = rows[0].id;
      af.step = 'files';
      return replyAndDelete(ctx, 'reply', '📤 فایل‌ها یا متن را ارسال کنید. پایان: "ارسال تکمیل شد."', Markup.keyboard([['ارسال تکمیل شد.'], ['لغو']]).oneTime().resize());
    } catch (err) {
      await replyAndDelete(ctx, 'reply', `❌ خطا: ${err.message}`);
      console.error('خطا در ADD_FILES_SCENE (folder):', err);
    } finally {
      if (conn) conn.release();
    }
  }
  if (af.step === 'files') {
    if (text === 'ارسال تکمیل شد.') {
      if (af.files.length === 0) return replyAndDelete(ctx, 'reply', '⚠️ هیچ فایل یا متنی ارسال نشده است.');
      let conn;
      try {
        conn = await pool.getConnection();
        const userDir = ensureUserDir(ctx.chat.id);
        for (const file of af.files) {
          if (file.fileType === 'text') {
            await conn.execute(
              'INSERT INTO folder_files (folder_id, file_path, file_type, text_content) VALUES (?, ?, ?, ?)',
              [af.folder_id, '', 'text', file.textContent]
            );
          } else {
            const [fileResult] = await conn.execute(
              'INSERT INTO folder_files (folder_id, file_path, file_type) VALUES (?, ?, ?)',
              [af.folder_id, 'pending', file.fileType]
            );
            const fileId = fileResult.insertId;
            const destBase = path.join(userDir, `${af.folder_id}_${fileId}`);
            const filePath = await downloadFile(file.fid, destBase, file.fileType);
            await conn.execute('UPDATE folder_files SET file_path = ? WHERE id = ?', [filePath, fileId]);
          }
        }
        await replyAndDelete(ctx, 'reply', '✅ فایل‌ها و متن‌ها اضافه شدند.', Markup.removeKeyboard());
      } catch (err) {
        await replyAndDelete(ctx, 'reply', `❌ خطا در ذخیره‌سازی: ${err.message}`);
        console.error('خطا در ADD_FILES_SCENE (save):', err);
      } finally {
        if (conn) conn.release();
        delete ctx.session.addFiles;
        return ctx.scene.leave();
      }
    }
    if (!isValidText(text)) {
      return replyAndDelete(ctx, 'reply', `⚠️ متن طولانی‌تر از ${MAX_TEXT_LENGTH} کاراکتر است.`);
    }
    af.files.push({ fileType: 'text', textContent: text });
    return replyAndDelete(ctx, 'reply', '✅ متن دریافت شد.');
  }
});
addFilesScene.on(['document', 'photo', 'video', 'animation', 'audio', 'voice', 'sticker'], async ctx => {
  const af = ctx.session.addFiles;
  if (af.step === 'files') {
    let fid, fileType;
    if (ctx.message.document) { fid = ctx.message.document.file_id; fileType = 'document'; }
    else if (ctx.message.photo) { fid = ctx.message.photo[ctx.message.photo.length - 1].file_id; fileType = 'photo'; }
    else if (ctx.message.video) { fid = ctx.message.video.file_id; fileType = 'video'; }
    else if (ctx.message.animation) { fid = ctx.message.animation.file_id; fileType = 'animation'; }
    else if (ctx.message.audio) { fid = ctx.message.audio.file_id; fileType = 'audio'; }
    else if (ctx.message.voice) { fid = ctx.message.voice.file_id; fileType = 'voice'; }
    else if (ctx.message.sticker) {
      if (ctx.message.sticker.is_animated) return replyAndDelete(ctx, 'reply', '⚠️ استیکر متحرک پشتیبانی نمی‌شود.');
      fid = ctx.message.sticker.file_id; fileType = 'sticker';
    }
    try {
      const file = await bot.telegram.getFile(fid);
      if (file.file_size > MAX_FILE_SIZE) return replyAndDelete(ctx, 'reply', '⚠️ فایل بزرگ‌تر از 20 مگابایت است.');
      af.files.push({ fid, fileType });
      await replyAndDelete(ctx, 'reply', '✅ فایل دریافت شد.');
    } catch (err) {
      await replyAndDelete(ctx, 'reply', `❌ خطا در دریافت فایل: ${err.message}`);
      console.error('خطا در ADD_FILES_SCENE (files):', err);
    }
  }
});

const searchFoldersScene = new BaseScene('SEARCH_FOLDERS_SCENE');
searchFoldersScene.enter(ctx => replyAndDelete(ctx, 'reply', '🔍 عبارت جستجو را وارد کنید:', Markup.keyboard([['لغو']]).oneTime().resize()));
searchFoldersScene.on('text', async ctx => {
  const text = ctx.message.text.trim();
  if (text === 'لغو') {
    await replyAndDelete(ctx, 'reply', '❌ عملیات لغو شد.', Markup.removeKeyboard());
    return ctx.scene.leave();
  }
  let conn;
  try {
    conn = await pool.getConnection();
    const [rows] = await conn.execute(
      'SELECT DISTINCT f.folder_name FROM folders f LEFT JOIN folder_files ff ON f.id = ff.folder_id WHERE f.chat_id = ? AND (f.folder_name LIKE ? OR f.description LIKE ? OR f.tags LIKE ? OR ff.text_content LIKE ?)',
      [ctx.chat.id, `%${text}%`, `%${text}%`, `%${text}%`, `%${text}%`]
    );
    if (!rows.length) return replyAndDelete(ctx, 'reply', '⚠️ هیچ پوشه‌ای یافت نشد.', Markup.removeKeyboard());
    const folderList = rows.map(r => r.folder_name).join('\n');
    await replyAndDelete(ctx, 'reply', `📋 نتایج جستجو:\n${folderList}`, Markup.removeKeyboard());
  } catch (err) {
    await replyAndDelete(ctx, 'reply', `❌ خطا: ${err.message}`);
    console.error('خطا در SEARCH_FOLDERS_SCENE:', err);
  } finally {
    if (conn) conn.release();
    return ctx.scene.leave();
  }
});

const detailPasswordScene = new BaseScene('DETAIL_PASSWORD_SCENE');
detailPasswordScene.enter(ctx => replyAndDelete(ctx, 'reply', '🔑 رمز عبور پوشه را وارد کنید:', Markup.keyboard([['لغو']]).oneTime().resize()));
detailPasswordScene.on('text', async ctx => {
  const text = ctx.message.text.trim();
  if (text === 'لغو') {
    delete ctx.session.folderToOpen;
    await replyAndDelete(ctx, 'reply', '❌ عملیات لغو شد.', Markup.removeKeyboard());
    return ctx.scene.leave();
  }
  const folder = ctx.session.folderToOpen;
  if (!folder) {
    await replyAndDelete(ctx, 'reply', '⚠️ خطا: پوشه مشخص نشده است.', Markup.removeKeyboard());
    return ctx.scene.leave();
  }
  try {
    const match = await bcrypt.compare(text, folder.password);
    if (!match) return replyAndDelete(ctx, 'reply', '⚠️ رمز عبور اشتباه است.');
    await showFolderContent(ctx, folder);
    delete ctx.session.folderToOpen;
    return ctx.scene.leave();
  } catch (err) {
    await replyAndDelete(ctx, 'reply', `❌ خطا: ${err.message}`);
    console.error('خطا در DETAIL_PASSWORD_SCENE:', err);
    return ctx.scene.leave();
  }
});

const deletePasswordScene = new BaseScene('DELETE_PASSWORD_SCENE');
deletePasswordScene.enter(ctx => replyAndDelete(ctx, 'reply', '🔑 رمز عبور پوشه را وارد کنید:', Markup.keyboard([['لغو']]).oneTime().resize()));
deletePasswordScene.on('text', async ctx => {
  const text = ctx.message.text.trim();
  if (text === 'لغو') {
    delete ctx.session.folderToDelete;
    await replyAndDelete(ctx, 'reply', '❌ عملیات لغو شد.', Markup.removeKeyboard());
    return ctx.scene.leave();
  }
  const folder = ctx.session.folderToDelete;
  if (!folder) {
    await replyAndDelete(ctx, 'reply', '⚠️ خطا: پوشه مشخص نشده است.', Markup.removeKeyboard());
    return ctx.scene.leave();
  }
  let conn;
  try {
    conn = await pool.getConnection();
    const match = await bcrypt.compare(text, folder.password);
    if (!match) return replyAndDelete(ctx, 'reply', '⚠️ رمز عبور اشتباه است.');
    await conn.execute('DELETE FROM folder_files WHERE folder_id = ?', [folder.id]);
    await conn.execute('DELETE FROM folders WHERE id = ?', [folder.id]);
    const userDir = ensureUserDir(ctx.chat.id);
    const folderFiles = await fs.readdir(userDir);
    for (const file of folderFiles) {
      if (file.startsWith(`${folder.id}_`)) {
        await fs.unlink(path.join(userDir, file));
      }
    }
    await replyAndDelete(ctx, 'reply', '✅ پوشه حذف شد.', Markup.removeKeyboard());
    delete ctx.session.folderToDelete;
    return ctx.scene.leave();
  } catch (err) {
    await replyAndDelete(ctx, 'reply', `❌ خطا در حذف: ${err.message}`);
    console.error('خطا در DELETE_PASSWORD_SCENE:', err);
    return ctx.scene.leave();
  } finally {
    if (conn) conn.release();
  }
});

// راه‌اندازی صحنه‌ها
const stage = new Stage([
  createFolderScene,
  openFolderScene,
  listFoldersScene,
  addFilesScene,
  searchFoldersScene,
  detailPasswordScene,
  deletePasswordScene
]);
bot.use(session());
bot.use(stage.middleware());

// ثبت قابلیت یوتیوب
registerYouTube(bot, stage, pool);

// دستورات ربات
bot.command('CrFolders', ctx => ctx.scene.enter('CREATE_FOLDER_SCENE'));
bot.command('OpenFolder', ctx => ctx.scene.enter('OPEN_FOLDER_SCENE'));
bot.command('ListFolders', ctx => ctx.scene.enter('LIST_FOLDERS_SCENE'));
bot.command('SearchFolders', ctx => ctx.scene.enter('SEARCH_FOLDERS_SCENE'));
bot.start(ctx => replyAndDelete(ctx, 'reply', HELP_TEXT, Markup.removeKeyboard()));

// مدیریت اکشن‌ها
bot.action(/DETAILS_(\d+)/, async ctx => {
  const folderId = ctx.match[1];
  let conn;
  try {
    conn = await pool.getConnection();
    const [rows] = await conn.execute('SELECT * FROM folders WHERE id = ? AND chat_id = ?', [folderId, ctx.chat.id]);
    if (!rows.length) return replyAndDelete(ctx, 'reply', '⚠️ پوشه یافت نشد.');
    await showFolderContent(ctx, rows[0]);
  } catch (err) {
    await replyAndDelete(ctx, 'reply', `❌ خطا: ${err.message}`);
    console.error('خطا در DETAILS action:', err);
  } finally {
    if (conn) conn.release();
  }
});

bot.action(/ADD_(\d+)/, async ctx => {
  const folderId = ctx.match[1];
  let conn;
  try {
    conn = await pool.getConnection();
    const [rows] = await conn.execute('SELECT id FROM folders WHERE id = ? AND chat_id = ?', [folderId, ctx.chat.id]);
    if (!rows.length) return replyAndDelete(ctx, 'reply', '⚠️ پوشه یافت نشد.');
    ctx.session.addFiles = { step: 'files', folder_id: folderId, files: [] };
    return ctx.scene.enter('ADD_FILES_SCENE');
  } catch (err) {
    await replyAndDelete(ctx, 'reply', `❌ خطا: ${err.message}`);
    console.error('خطا در ADD action:', err);
  } finally {
    if (conn) conn.release();
  }
});

bot.action(/SHARE_(\d+)/, async ctx => {
  let conn;
  try {
    conn = await pool.getConnection();
    const [rows] = await conn.execute('SELECT folder_name FROM folders WHERE id = ? AND chat_id = ?', [ctx.match[1], ctx.chat.id]);
    if (!rows.length) return replyAndDelete(ctx, 'reply', '⚠️ پوشه یافت نشد.');
    const shareText = `📁 پوشه: ${rows[0].folder_name}\nربات: @${(await bot.telegram.getMe()).username}`;
    await replyAndDelete(ctx, 'reply', shareText, Markup.inlineKeyboard([Markup.button.switchToCurrentChat('اشتراک‌گذاری', shareText)]));
  } catch (err) {
    await replyAndDelete(ctx, 'reply', `❌ خطا: ${err.message}`);
    console.error('خطا در SHARE action:', err);
  } finally {
    if (conn) conn.release();
  }
});

bot.action(/DELETE_(\d+)/, async ctx => {
  let conn;
  try {
    conn = await pool.getConnection();
    const [rows] = await conn.execute('SELECT * FROM folders WHERE id = ? AND chat_id = ?', [ctx.match[1], ctx.chat.id]);
    if (!rows.length) return replyAndDelete(ctx, 'reply', '⚠️ پوشه یافت نشد.');
    const folder = rows[0];
    if (folder.password) {
      ctx.session.folderToDelete = folder;
      return ctx.scene.enter('DELETE_PASSWORD_SCENE');
    }
    await conn.execute('DELETE FROM folder_files WHERE folder_id = ?', [folder.id]);
    await conn.execute('DELETE FROM folders WHERE id = ?', [folder.id]);
    const userDir = ensureUserDir(ctx.chat.id);
    const folderFiles = await fs.readdir(userDir);
    for (const file of folderFiles) {
      if (file.startsWith(`${folder.id}_`)) {
        await fs.unlink(path.join(userDir, file));
      }
    }
    await replyAndDelete(ctx, 'reply', '✅ پوشه حذف شد.');
  } catch (err) {
    await replyAndDelete(ctx, 'reply', `❌ خطا در حذف: ${err.message}`);
    console.error('خطا در DELETE action:', err);
  } finally {
    if (conn) conn.release();
  }
});

// مدیریت خطاهای کلی
bot.catch((err, ctx) => {
  console.error(`خطا: ${err.message}`);
  replyAndDelete(ctx, 'reply', `❌ خطای غیرمنتظره: ${err.message}`);
});

// بستن Pool هنگام توقف برنامه
process.on('SIGINT', async () => {
  await pool.end();
  bot.stop('SIGINT');
  console.log('اتصالات پایگاه داده بسته شد.');
});
process.on('SIGTERM', async () => {
  await pool.end();
  bot.stop('SIGTERM');
  console.log('اتصالات پایگاه داده بسته شد.');
});

// راه‌اندازی دیتابیس
const initDatabase = async () => {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS folders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        chat_id BIGINT NOT NULL,
        folder_name VARCHAR(255) NOT NULL,
        description TEXT,
        tags VARCHAR(255),
        password VARCHAR(255),
        cover_file_path VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(chat_id, folder_name),
        INDEX idx_chat_id (chat_id)
      )
    `);
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS folder_files (
        id INT AUTO_INCREMENT PRIMARY KEY,
        folder_id INT NOT NULL,
        file_path VARCHAR(255) NOT NULL,
        file_type VARCHAR(50) NOT NULL,
        text_content TEXT,
        FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE,
        INDEX idx_folder_id (folder_id)
      )
    `);
    console.log('پایگاه داده آماده شد.');
  } catch (err) {
    console.error('خطا در راه‌اندازی دیتابیس:', err.message);
    process.exit(1);
  } finally {
    if (conn) conn.release();
  }
};

// تابع اولیه‌سازی
const initialize = async () => {
  try {
    await setupBinaries();
    await initDatabase();
    await bot.launch();
    console.log('ربات شروع شد.');
  } catch (err) {
    console.error('خطا در راه‌اندازی ربات:', err.message);
    process.exit(1);
  }
};

initialize();