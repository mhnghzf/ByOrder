const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 3306,
  connectionLimit: 10,
  waitForConnections: true,
  queueLimit: 0
});

// تابع تست اتصال
async function testConnection() {
  try {
    const connection = await pool.getConnection();
    console.log('اتصال به پایگاه داده با موفقیت برقرار شد.');
    connection.release();
  } catch (err) {
    console.error('خطا در اتصال به پایگاه داده:', err.message);
    process.exit(1); // خروج در صورت خطا (یا مدیریت به روش دیگر)
  }
}

// اجرای تست اتصال هنگام بارگذاری ماژول
testConnection();

module.exports = pool;