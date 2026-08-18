const mysql = require('mysql2/promise');
const config = require('../config/env');
const { getMysqlSslOptions } = require('./mysqlSsl');

// Pool size is env-tunable. Default 30 handles burst of concurrent requests
// without forcing them to queue. Timeouts prevent zombie connections.
const poolSize = Number.parseInt(config.MYSQL_POOL_SIZE, 10) > 0
  ? Number.parseInt(config.MYSQL_POOL_SIZE, 10)
  : 30;

const pool = mysql.createPool({
  host: config.MYSQL_HOST,
  port: config.MYSQL_PORT,
  user: config.MYSQL_USER,
  password: config.MYSQL_PASSWORD,
  database: config.MYSQL_DATABASE,
  ssl: getMysqlSslOptions(),
  // Business runs on IST only. Without this, mysql2 defaults to the host
  // OS's local TZ ('local') for DATETIME read/write — same code stores and
  // reads a different wall-clock depending on the machine it runs on (dev
  // box vs prod container), which is exactly what caused created_at values
  // to be ambiguous. Pin it so "local" always means IST, everywhere.
  //
  // This MUST match the MySQL server's session time_zone, which renders
  // TIMESTAMP columns on read. Verified against the dev server: session
  // time_zone = SYSTEM = IST, so NOW()/CURRENT_TIMESTAMP write IST
  // wall-clock and '+05:30' parses them to the correct absolute instant
  // ('Z' would read every timestamp 5.5h late). If a deployment ever runs
  // MySQL on UTC, this value and the DATE(created_at) comparisons in
  // adminController's getAdminOrders must move together — see the note
  // there.
  timezone: config.RIDER_TODAY_TZ || '+05:30',
  waitForConnections: true,
  connectionLimit: poolSize,
  queueLimit: 0,
  connectTimeout: 10_000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 30_000,
});

const checkConnection = async () => {
  try {
    const connection = await pool.getConnection();
    connection.release();
    return true;
  } catch (error) {
    console.error('MySQL Connection Error:', error.message);
    return false;
  }
};

module.exports = {
  pool,
  checkConnection
};
