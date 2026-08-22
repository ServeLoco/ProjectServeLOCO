const app = require('./app');
const config = require('./config/env');
const db = require('./db');
const { pool } = require('./db/mysql');
const { closeRealtime, initRealtime } = require('./realtime/socket');
const orderAutoAccept = require('./realtime/orderAutoAccept');
const { startRiderOfferSweeper, stopRiderOfferSweeper } = require('./realtime/riderOfferSweeper');
const { startShopAlertSweeper, stopShopAlertSweeper } = require('./realtime/shopAlertSweeper');
const { startShopScheduleSweeper, stopShopScheduleSweeper } = require('./realtime/shopScheduleSweeper');
const { startRollupScheduler, stopRollupScheduler } = require('./services/analytics/rollup');

const PORT = config.PORT;
let server;

// Purge users whose deletion grace period (30 days) has elapsed. Runs once
// on startup and every 24 hours after that. Because orders.customer_id is
// ON DELETE RESTRICT, a user who ever placed an order can't be hard-deleted
// (the old batched DELETE ... IN (?) failed the WHOLE batch on the first such
// user, forever). We now process users one at a time: order-less users are
// hard-deleted; users with order history are anonymized in place so the order
// history survives. blocked users are purgeable too, so the WHERE no longer
// filters on blocked.
const purgeExpiredDeletions = async () => {
  try {
    const [rows] = await pool.query(
      `SELECT id FROM users
        WHERE deletion_requested_at IS NOT NULL
          AND deletion_requested_at < (NOW() - INTERVAL 30 DAY)`
    );
    if (rows.length === 0) return;
    let hardDeleted = 0;
    let anonymized = 0;
    for (const { id } of rows) {
      try {
        // Reset requests have no FK cascade — clear them first so no orphan
        // audit row survives the user record.
        await pool.query('DELETE FROM password_reset_requests WHERE user_id = ?', [id]);
        // orders.customer_id is ON DELETE RESTRICT: only hard-delete when the
        // user never ordered. Otherwise anonymize so order history survives.
        const [countRows] = await pool.query(
          'SELECT COUNT(*) AS cnt FROM orders WHERE customer_id = ?',
          [id]
        );
        if (countRows[0].cnt === 0) {
          await pool.query('DELETE FROM users WHERE id = ?', [id]);
          hardDeleted += 1;
        } else {
          // phone is UNIQUE NOT NULL — CONCAT('deleted-', id) keeps it unique.
          await pool.query(
            `UPDATE users SET
              name = 'Deleted User',
              phone = CONCAT('deleted-', id),
              password_hash = NULL,
              firebase_uid = NULL,
              whatsapp_number = NULL,
              address = NULL,
              short_address = NULL,
              push_token = NULL,
              blocked = 1,
              deletion_requested_at = NULL
            WHERE id = ?`,
            [id]
          );
          anonymized += 1;
        }
      } catch (e) {
        // One user failing must not stop the rest of the batch.
        console.error(`[purge-expired-deletions] failed for user ${id}:`, e.message);
      }
    }
    console.log(`[purge-expired-deletions] hard-deleted ${hardDeleted}, anonymized ${anonymized} user(s) past 30-day grace`);
  } catch (e) {
    console.error('[purge-expired-deletions] failed:', e.message);
  }
};

const startServer = async () => {
  try {
    await db.initDB();

    server = app.listen(PORT, '0.0.0.0', () => {
      // Log the configured JWT lifetime so a short value (e.g. '1d' leaking
      // in from tests) is obvious in the server logs instead of surfacing
      // as users mysteriously getting logged out after a day.
      const jwtExpires = require('./config/env').JWT_EXPIRES_IN;
      console.log(`Server is running on port ${PORT} (JWT_EXPIRES_IN=${jwtExpires})`);
    });
    initRealtime(server);
    // Daily analytics rollup — backfills yesterday on startup, then runs at 00:05.
    startRollupScheduler();
    // Auto-accept any orders that were Pending before this restart.
    orderAutoAccept.rehydratePendingOrders().catch(() => {});
    // Expire due rider offers and continue assignment chains after restarts.
    startRiderOfferSweeper();
    // Retry weak-network shop alerts + auto-reject a shop that never responds.
    startShopAlertSweeper();
    // Auto-open/close shops per their open_time/close_time schedule.
    startShopScheduleSweeper();
    // Run the deletion sweep once at startup, then once a day.
    purgeExpiredDeletions().catch(() => {});
    const purgeTimer = setInterval(() => purgeExpiredDeletions().catch(() => {}), 24 * 60 * 60 * 1000);
    purgeTimer.unref();
    global.__purgeTimer = purgeTimer;
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

// Only auto-start when run directly (`node src/server.js`). Under Jest
// (require.main !== module) the file is imported solely to test
// purgeExpiredDeletions, so we must not boot a real HTTP server here.
if (require.main === module) startServer();

// Graceful shutdown helpers
const shutdown = async () => {
  console.log('SIGTERM/SIGINT signal received: closing HTTP server and database connections');
  orderAutoAccept.clearAll();
  stopRiderOfferSweeper();
  stopShopAlertSweeper();
  stopShopScheduleSweeper();
  stopRollupScheduler();
  if (global.__purgeTimer) clearInterval(global.__purgeTimer);
  await closeRealtime();

  if (server) {
    server.close(async () => {
      console.log('HTTP server closed');
      await db.closeDB();
      process.exit(0);
    });
  } else {
    await closeRealtime();
    await db.closeDB();
    process.exit(0);
  }
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Exported for unit testing (purgeExpiredDeletions). `server` is assigned
// asynchronously inside startServer(), so it is not meaningfully exported;
// nothing imports this module at runtime — the process is started directly.
module.exports = { purgeExpiredDeletions };
