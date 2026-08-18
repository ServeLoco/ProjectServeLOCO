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
  // Without this, mysql2 defaults to the host OS's local TZ ('local') to
  // parse DATETIME/TIMESTAMP strings coming back from MySQL — the same
  // stored value reads as a different JS Date instant depending on the
  // machine it runs on (dev box vs prod container), which is exactly what
  // made created_at ambiguous. MySQL itself writes CURRENT_TIMESTAMP as
  // UTC wall-clock here (see buildPeriodDateFilter/riders.js/
  // shopOwnerController.js's CONVERT_TZ('+00:00', ...) callers, which all
  // assume this) — pin the driver to that same convention so it always
  // parses correctly regardless of the host's local TZ. Business-facing
  // conversion to IST happens in SQL via CONVERT_TZ, not here.
  timezone: 'Z',
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
