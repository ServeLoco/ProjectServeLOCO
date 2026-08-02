// Product library materializer (TASK 19, §4.5). The ONLY code that turns a
// library item into area rows — add-from-library, bulk add-to-areas, and
// clone-area (TASK 24) all call materializeToArea. It is the only writer of
// products.library_product_id. Reuses productController's own
// syncProductVariants so the products.price <-> default-variant mirror
// invariant is enforced in exactly one place, never duplicated here.
const { syncProductVariants } = require('../controllers/productController');

class LibraryError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Materialize a library product into one area's catalog. Idempotent: calling
 * this again for an (libraryProductId, areaId) pair that already has a
 * linked, non-deleted product returns that product instead of creating a
 * duplicate (19.5) — the caller decides what to do with alreadyLinked.
 *
 * Identity fields (name, description, image_id, variant labels) are copied
 * from the library item, never joined (§2.5) — a later library edit reaches
 * this row via propagateLibraryEdit (TASK 20), not by this function being
 * called again.
 *
 * @param {import('mysql2/promise').PoolConnection} conn - caller's own
 *   connection/transaction; this function never begins or commits one.
 * @param {{
 *   libraryProductId: number, areaId: number, categoryId: number,
 *   price?: number, shopId?: number|null, shopPrice?: number|null,
 *   available?: boolean, displayOrder?: number,
 *   variantPrices?: Record<number, number>,
 * }} params
 * @returns {Promise<{ productId: number, alreadyLinked: boolean }>}
 */
const materializeToArea = async (conn, {
  libraryProductId, areaId, categoryId, price, shopId = null, shopPrice = null,
  available = true, displayOrder = 0, variantPrices = {},
}) => {
  const [existing] = await conn.query(
    'SELECT id FROM products WHERE library_product_id = ? AND area_id = ? AND deleted = 0 LIMIT 1',
    [libraryProductId, areaId]
  );
  if (existing.length > 0) {
    return { productId: existing[0].id, alreadyLinked: true };
  }

  const [libRows] = await conn.query('SELECT * FROM product_library WHERE id = ?', [libraryProductId]);
  const lib = libRows[0];
  if (!lib) throw new LibraryError('NOT_FOUND', 'Library product not found');
  if (lib.archived) throw new LibraryError('ARCHIVED', 'Library product is archived — reactivate it before adding to an area');

  const [catRows] = await conn.query(
    'SELECT id FROM categories WHERE id = ? AND deleted = 0 AND area_id = ?',
    [categoryId, areaId]
  );
  if (catRows.length === 0) throw new LibraryError('VALIDATION_ERROR', 'Unknown category_id for this area');

  if (shopId != null) {
    const [shopRows] = await conn.query('SELECT id FROM shops WHERE id = ? AND area_id = ?', [shopId, areaId]);
    if (shopRows.length === 0) throw new LibraryError('VALIDATION_ERROR', 'Unknown shop_id for this area');
  }

  const [libVariants] = await conn.query(
    'SELECT id, label, display_order, is_default FROM library_variants WHERE library_product_id = ? ORDER BY display_order ASC, id ASC',
    [libraryProductId]
  );

  const finalPrice = price != null ? Number(price) : (lib.suggested_price != null ? Number(lib.suggested_price) : 0);

  const [result] = await conn.query(
    `INSERT INTO products (area_id, name, price, shop_price, category_id, unit, description, image_id,
      available, is_combo, featured, display_order, shop_id, variant_prompt, library_product_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      areaId, lib.name, finalPrice, shopPrice, categoryId,
      // No `unit` text to copy yet — product_library only carries unit_id,
      // a forward-declared pointer to the units table TASK 23 builds. Left
      // NULL here, same as any product created without one today.
      null,
      lib.description, lib.image_id,
      available ? 1 : 0, false, false, displayOrder, shopId, lib.variant_prompt, libraryProductId,
    ]
  );
  const productId = result.insertId;

  if (libVariants.length > 0) {
    const variants = libVariants.map((lv) => ({
      label: lv.label,
      price: variantPrices[lv.id] != null ? Number(variantPrices[lv.id]) : finalPrice,
      original_price: null,
      available: true,
      is_default: Boolean(lv.is_default),
      display_order: lv.display_order,
      library_variant_id: lv.id,
    }));
    await syncProductVariants(conn, productId, variants, lib.variant_prompt);
  }

  return { productId, alreadyLinked: false };
};

/**
 * Upsert-by-id + hard-delete-missing for library_variants (TASK 20). Unlike
 * product_variants, a library_variants row is never referenced by a live
 * cart or order snapshot — only product_variants rows are, via
 * library_variant_id — so a real removal here is a genuine hard delete. What
 * happens to the now-orphaned per-area product_variants rows that used to
 * point at a removed id is propagateLibraryEdit's job (20.6), not this one's.
 * @param {import('mysql2/promise').PoolConnection} conn
 * @param {number} libraryProductId
 * @param {Array<{id?:number, label:string, displayOrder?:number, isDefault?:boolean}>} variants
 */
const syncLibraryVariants = async (conn, libraryProductId, variants) => {
  if (!Array.isArray(variants)) return;

  const payloadIds = new Set();
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    const displayOrder = v.displayOrder ?? v.display_order ?? i;
    const isDefault = v.isDefault || v.is_default ? 1 : 0;
    if (v.id) {
      payloadIds.add(Number(v.id));
      await conn.query(
        'UPDATE library_variants SET label = ?, display_order = ?, is_default = ? WHERE id = ? AND library_product_id = ?',
        [v.label, displayOrder, isDefault, v.id, libraryProductId]
      );
    } else {
      const [result] = await conn.query(
        'INSERT INTO library_variants (library_product_id, label, display_order, is_default) VALUES (?, ?, ?, ?)',
        [libraryProductId, v.label, displayOrder, isDefault]
      );
      payloadIds.add(Number(result.insertId));
    }
  }

  if (payloadIds.size > 0) {
    await conn.query(
      'DELETE FROM library_variants WHERE library_product_id = ? AND id NOT IN (?)',
      [libraryProductId, [...payloadIds]]
    );
  } else {
    await conn.query('DELETE FROM library_variants WHERE library_product_id = ?', [libraryProductId]);
  }
};

/**
 * Fan a library item's identity out to every area that carries it (TASK 20,
 * §3.7/§6.7). ONE batched UPDATE per concern — never N queries for N areas.
 * Never touches area-owned commerce columns (price, availability, category,
 * shop, display_order) on an EXISTING variant/product — §6.7's whole point.
 *
 * Call this AFTER any change to the library row/its variants is committed on
 * the same connection; it re-reads the library fresh rather than taking the
 * new values as arguments, so it can never propagate a half-applied edit.
 *
 * @param {import('mysql2/promise').PoolConnection} conn
 * @param {number} libraryProductId
 * @returns {Promise<{ areaIds: number[] }>} areas to bustAreaCaches AFTER
 *   the response is sent (20.4) — this function only computes the list, the
 *   caller does the fire-and-forget fan-out.
 */
const propagateLibraryEdit = async (conn, libraryProductId) => {
  const [libRows] = await conn.query('SELECT * FROM product_library WHERE id = ?', [libraryProductId]);
  const lib = libRows[0];
  if (!lib) throw new LibraryError('NOT_FOUND', 'Library product not found');

  // 1. Identity — one statement, explicit column list always (§6.7: never a
  // spread of the request body — one stray column would overwrite every
  // area's pricing in a single UPDATE).
  await conn.query(
    'UPDATE products SET name = ?, description = ?, image_id = ?, unit = ? WHERE library_product_id = ?',
    [lib.name, lib.description, lib.image_id, null, libraryProductId]
  );

  // 2. Variant labels — one JOIN-based UPDATE covers every area's variants
  // still linked to a live library_variants row.
  await conn.query(
    `UPDATE product_variants pv
     JOIN library_variants lv ON lv.id = pv.library_variant_id
     SET pv.label = lv.label
     WHERE lv.library_product_id = ? AND pv.deleted = 0`,
    [libraryProductId]
  );

  // 3. Removals (20.6) — a product_variant still linked to a library_variant_id
  // that library_variants no longer has (syncLibraryVariants hard-deleted it)
  // gets SOFT-deleted, never hard-deleted: live carts/order snapshots hold
  // product_variants.id and must keep resolving.
  await conn.query(
    `UPDATE product_variants pv
     JOIN products p ON p.id = pv.product_id
     SET pv.deleted = 1
     WHERE p.library_product_id = ? AND pv.deleted = 0 AND pv.library_variant_id IS NOT NULL
       AND pv.library_variant_id NOT IN (
         SELECT id FROM (SELECT id FROM library_variants WHERE library_product_id = ?) AS lv2
       )`,
    [libraryProductId, libraryProductId]
  );

  // 4. Adds (20.5) — a library_variants row with no matching product_variants
  // row yet in some area (added to the library after that area materialized
  // this item) gets a new row at suggested_price, available = 0 — a new size
  // never goes on sale at a price nobody chose. Deliberately never is_default:
  // that would silently retarget the products.price mirror in every area at
  // once; is_default only ever applies at initial materialization.
  const [libVariants] = await conn.query(
    'SELECT id, label, display_order FROM library_variants WHERE library_product_id = ?',
    [libraryProductId]
  );
  const [areaProducts] = await conn.query(
    'SELECT id FROM products WHERE library_product_id = ? AND deleted = 0',
    [libraryProductId]
  );
  if (libVariants.length > 0 && areaProducts.length > 0) {
    const productIds = areaProducts.map((p) => p.id);
    const [existingLinks] = await conn.query(
      `SELECT product_id, library_variant_id FROM product_variants
       WHERE product_id IN (?) AND library_variant_id IS NOT NULL AND deleted = 0`,
      [productIds]
    );
    const existingSet = new Set(existingLinks.map((r) => `${r.product_id}:${r.library_variant_id}`));
    const insertRows = [];
    const suggestedPrice = lib.suggested_price != null ? Number(lib.suggested_price) : 0;
    for (const product of areaProducts) {
      for (const lv of libVariants) {
        if (!existingSet.has(`${product.id}:${lv.id}`)) {
          insertRows.push([product.id, lv.label, suggestedPrice, 0, 0, lv.display_order, lv.id]);
        }
      }
    }
    if (insertRows.length > 0) {
      await conn.query(
        'INSERT INTO product_variants (product_id, label, price, available, is_default, display_order, library_variant_id) VALUES ?',
        [insertRows]
      );
    }
  }

  // 20.4: affected areas from a single SELECT DISTINCT — the caller busts
  // each one AFTER responding to the admin, not inside this function.
  const [areaRows] = await conn.query(
    'SELECT DISTINCT area_id FROM products WHERE library_product_id = ? AND deleted = 0',
    [libraryProductId]
  );
  return { areaIds: areaRows.map((r) => r.area_id) };
};

module.exports = { materializeToArea, syncLibraryVariants, propagateLibraryEdit, LibraryError };
