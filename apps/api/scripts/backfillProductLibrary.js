/**
 * Manual backfill: promote every existing area product that has no
 * library_product_id yet into the library (combos excluded — they are
 * bundles, not library items).
 *
 *   APP_ENV=development node scripts/backfillProductLibrary.js
 *   APP_ENV=production  node scripts/backfillProductLibrary.js
 *
 * migrate.js now runs this same backfill automatically on every boot (see
 * `backfillProductLibrary` there), so this script is no longer required for
 * a normal deploy. Kept for an on-demand manual run outside a deploy cycle.
 * Safe to re-run — already-linked products are skipped by the WHERE clause,
 * and promoteToLibrary itself rejects a product that already has a
 * library_product_id.
 */
require('dotenv').config();
process.env.APP_ENV = process.env.APP_ENV || 'development';

const { pool } = require('../src/db/mysql');
const { promoteToLibrary } = require('../src/utils/productLibrary');

const BATCH = 25;

async function main() {
  console.log(`[backfillProductLibrary] APP_ENV=${process.env.APP_ENV}`);
  const [[{ total }]] = await pool.query(
    'SELECT COUNT(*) AS total FROM products WHERE deleted = 0 AND is_combo = 0 AND library_product_id IS NULL'
  );
  console.log(`[backfillProductLibrary] ${total} product(s) need a library entry`);

  let done = 0;
  let failed = 0;
  let afterId = 0;

  for (;;) {
    const [rows] = await pool.query(
      `SELECT id FROM products
       WHERE deleted = 0 AND is_combo = 0 AND library_product_id IS NULL AND id > ?
       ORDER BY id ASC
       LIMIT ?`,
      [afterId, BATCH]
    );
    if (rows.length === 0) break;

    for (const row of rows) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const { libraryProductId } = await promoteToLibrary(connection, row.id);
        await connection.commit();
        done += 1;
        console.log(`[backfillProductLibrary] ok product id=${row.id} -> library id=${libraryProductId} (${done}/${total}, failed=${failed})`);
      } catch (err) {
        await connection.rollback();
        failed += 1;
        console.error(`[backfillProductLibrary] FAIL product id=${row.id}: ${err.message}`);
      } finally {
        connection.release();
      }
      afterId = row.id;
    }
  }

  console.log(`[backfillProductLibrary] complete. ok=${done} failed=${failed}`);
  if (typeof pool.end === 'function') await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[backfillProductLibrary] fatal', err);
  process.exit(1);
});
