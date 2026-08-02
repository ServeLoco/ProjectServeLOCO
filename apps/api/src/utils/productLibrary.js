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

module.exports = { materializeToArea, LibraryError };
