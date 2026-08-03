/**
 * TASK 20 — propagateLibraryEdit / syncLibraryVariants
 * (src/utils/productLibrary.js). §3.7: one batched UPDATE per concern, off
 * the request path for the cache-bust fan-out. §6.7: explicit column list,
 * always — never a spread of the request body onto area-owned columns.
 */
jest.mock('../src/db/mysql', () => ({
  pool: { query: jest.fn(), getConnection: jest.fn() },
}));

const { pool } = require('../src/db/mysql');
const {
  propagateLibraryEdit, syncLibraryVariants,
  propagateCategoryLibraryEdit, propagateStoreModeLibraryEdit,
} = require('../src/utils/productLibrary');

const fakeConn = { query: (...args) => pool.query(...args) };

describe('propagateLibraryEdit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('20.1/20.2 — identity UPDATE uses an explicit column list and never touches area-owned columns', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 20, name: 'Maggi', description: 'Noodles', image_id: '55', suggested_price: 12 }]]) // library row
      .mockResolvedValueOnce([{ affectedRows: 3 }]) // identity UPDATE
      .mockResolvedValueOnce([{ affectedRows: 3 }]) // label UPDATE
      .mockResolvedValueOnce([{ affectedRows: 0 }]) // removal soft-delete
      .mockResolvedValueOnce([[]]) // libVariants (none, for this test)
      .mockResolvedValueOnce([[]]) // areaProducts
      .mockResolvedValueOnce([[{ area_id: 1 }, { area_id: 2 }]]); // affected areas

    const result = await propagateLibraryEdit(fakeConn, 20);

    const identitySql = pool.query.mock.calls[1][0];
    expect(identitySql).toContain('UPDATE products SET name = ?, description = ?, image_id = ?, unit = ?');
    expect(identitySql).toContain('WHERE library_product_id = ?');
    // Never touches price, availability, category_id, shop_id, display_order.
    expect(identitySql).not.toMatch(/\bprice\b/);
    expect(identitySql).not.toMatch(/\bavailable\b/);
    expect(identitySql).not.toMatch(/\bcategory_id\b/);
    expect(identitySql).not.toMatch(/\bdisplay_order\b/);
    expect(pool.query.mock.calls[1][1]).toEqual(['Maggi', 'Noodles', '55', null, 20]);

    expect(result.areaIds).toEqual([1, 2]);
  });

  it('20.3 — variant labels propagate via one JOIN-based UPDATE', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 20, name: 'X', description: null, image_id: null, suggested_price: null }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 4 }]) // label UPDATE — 4 rows across N areas in ONE statement
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockResolvedValueOnce([[]]) // libVariants
      .mockResolvedValueOnce([[]]) // areaProducts
      .mockResolvedValueOnce([[]]); // affected areas

    await propagateLibraryEdit(fakeConn, 20);

    const labelSql = pool.query.mock.calls[2][0];
    expect(labelSql).toContain('UPDATE product_variants pv');
    expect(labelSql).toContain('JOIN library_variants lv ON lv.id = pv.library_variant_id');
    expect(labelSql).toContain('SET pv.label = lv.label');
    expect(pool.query.mock.calls[2][1]).toEqual([20]);
  });

  it('20.6 — a product_variant whose library_variant was removed gets soft-deleted, never hard-deleted', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 20, name: 'X', description: null, image_id: null, suggested_price: null }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockResolvedValueOnce([{ affectedRows: 2 }]) // removal soft-delete affected 2 rows
      .mockResolvedValueOnce([[]]) // libVariants
      .mockResolvedValueOnce([[]]) // areaProducts
      .mockResolvedValueOnce([[]]); // affected areas

    await propagateLibraryEdit(fakeConn, 20);

    const removalSql = pool.query.mock.calls[3][0];
    expect(removalSql).toContain('SET pv.deleted = 1');
    expect(removalSql).not.toMatch(/DELETE FROM product_variants/);
    expect(removalSql).toContain('library_variant_id NOT IN');
  });

  it('20.5 — a library variant with no matching row yet in an area gets inserted at suggested_price, available = 0, never is_default', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 20, name: 'X', description: null, image_id: null, suggested_price: 18 }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockResolvedValueOnce([[{ id: 900, label: 'New Size', display_order: 2 }]]) // libVariants
      .mockResolvedValueOnce([[{ id: 501 }, { id: 601 }]]) // area products (2 areas)
      .mockResolvedValueOnce([[]]) // existing links — neither area has this variant yet
      .mockResolvedValueOnce([{ affectedRows: 2 }]) // the batch INSERT
      .mockResolvedValueOnce([[{ area_id: 1 }, { area_id: 2 }]]);

    await propagateLibraryEdit(fakeConn, 20);

    const insertCall = pool.query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO product_variants'));
    expect(insertCall).toBeDefined();
    const rows = insertCall[1][0];
    expect(rows).toHaveLength(2);
    // [product_id, label, price, available, is_default, display_order, library_variant_id]
    for (const row of rows) {
      expect(row[1]).toBe('New Size');
      expect(row[2]).toBe(18); // suggested_price
      expect(row[3]).toBe(0); // available = 0
      expect(row[4]).toBe(0); // never is_default
      expect(row[6]).toBe(900); // library_variant_id
    }
  });

  it('20.5 — skips areas that already have every current library variant', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 20, name: 'X', description: null, image_id: null, suggested_price: 18 }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockResolvedValueOnce([[{ id: 900, label: 'Existing', display_order: 0 }]])
      .mockResolvedValueOnce([[{ id: 501 }]])
      .mockResolvedValueOnce([[{ product_id: 501, library_variant_id: 900 }]]) // already linked
      .mockResolvedValueOnce([[{ area_id: 1 }]]);

    await propagateLibraryEdit(fakeConn, 20);

    const insertCall = pool.query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO product_variants'));
    expect(insertCall).toBeUndefined();
  });

  it('throws NOT_FOUND for a missing library product', async () => {
    pool.query.mockResolvedValueOnce([[]]);
    await expect(propagateLibraryEdit(fakeConn, 999)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('syncLibraryVariants', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('upserts by id and hard-deletes library variants missing from the payload', async () => {
    pool.query
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE existing variant 900
      .mockResolvedValueOnce([{ insertId: 901 }]) // INSERT new variant
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // DELETE missing

    await syncLibraryVariants(fakeConn, 20, [
      { id: 900, label: 'Small', displayOrder: 0, isDefault: true },
      { label: 'Large', displayOrder: 1 },
    ]);

    expect(pool.query.mock.calls[0][0]).toContain('UPDATE library_variants SET');
    expect(pool.query.mock.calls[1][0]).toContain('INSERT INTO library_variants');
    expect(pool.query.mock.calls[2][0]).toContain('DELETE FROM library_variants');
    expect(pool.query.mock.calls[2][1]).toEqual([20, [900, 901]]);
  });

  it('is a no-op when variants is not an array', async () => {
    await syncLibraryVariants(fakeConn, 20, undefined);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

// TASK 21, §2.7/§4.5 — same shape as propagateLibraryEdit, not a second
// mechanism: one UPDATE per area (not a single batched statement — bug fix,
// multi-area audit finding #10) with an explicit column list, area list from
// a single SELECT DISTINCT, active/display_order/is_default never touched.
describe('propagateCategoryLibraryEdit (TASK 21.7)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renames a library category and reaches every area without touching display_order', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 5, name: 'Dairy & Eggs', slug: 'dairy-eggs', type: 'packed', image_id: '10' }]])
      .mockResolvedValueOnce([[{ area_id: 1 }, { area_id: 2 }]]) // affected areas
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // identity UPDATE, area 1
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // identity UPDATE, area 2

    const result = await propagateCategoryLibraryEdit(fakeConn, 5);

    const identitySql = pool.query.mock.calls[2][0];
    expect(identitySql).toBe('UPDATE categories SET name = ?, slug = ?, type = ?, image_id = ? WHERE library_category_id = ? AND area_id = ?');
    expect(pool.query.mock.calls[2][1]).toEqual(['Dairy & Eggs', 'dairy-eggs', 'packed', '10', 5, 1]);
    expect(pool.query.mock.calls[3][1]).toEqual(['Dairy & Eggs', 'dairy-eggs', 'packed', '10', 5, 2]);
    expect(identitySql).not.toMatch(/\bactive\b/);
    expect(identitySql).not.toMatch(/\bdisplay_order\b/);
    expect(result.areaIds).toEqual([1, 2]);
    expect(result.skippedAreaIds).toEqual([]);
  });

  // Bug fix (multi-area audit finding #10): a duplicate-slug collision in
  // ONE area used to throw for the whole batched UPDATE, rolling back every
  // other area's otherwise-successful identity update too.
  it('skips (not fails) an area whose new slug collides with an existing local category, and still updates the rest', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 5, name: 'Dairy & Eggs', slug: 'dairy-eggs', type: 'packed', image_id: '10' }]])
      .mockResolvedValueOnce([[{ area_id: 1 }, { area_id: 2 }]]) // affected areas
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' })) // area 1 collides
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // area 2 succeeds

    const result = await propagateCategoryLibraryEdit(fakeConn, 5);

    expect(result.areaIds).toEqual([1, 2]);
    expect(result.skippedAreaIds).toEqual([1]);
  });

  it('throws NOT_FOUND for a missing library category', async () => {
    pool.query.mockResolvedValueOnce([[]]);
    await expect(propagateCategoryLibraryEdit(fakeConn, 999)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('propagateStoreModeLibraryEdit (TASK 21)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('propagates identity without touching active/display_order/is_default', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 3, slug: 'fast_food', label: 'Fast Food v2', icon_image_id: 77 }]])
      .mockResolvedValueOnce([{ affectedRows: 2 }])
      .mockResolvedValueOnce([[{ area_id: 1 }, { area_id: 2 }]]);

    const result = await propagateStoreModeLibraryEdit(fakeConn, 3);

    const identitySql = pool.query.mock.calls[1][0];
    expect(identitySql).toBe('UPDATE store_modes SET slug = ?, label = ?, icon_image_id = ? WHERE library_store_mode_id = ?');
    expect(pool.query.mock.calls[1][1]).toEqual(['fast_food', 'Fast Food v2', 77, 3]);
    expect(identitySql).not.toMatch(/\bactive\b/);
    expect(identitySql).not.toMatch(/\bdisplay_order\b/);
    expect(identitySql).not.toMatch(/\bis_default\b/);
    expect(result.areaIds).toEqual([1, 2]);
  });

  it('throws NOT_FOUND for a missing library store mode', async () => {
    pool.query.mockResolvedValueOnce([[]]);
    await expect(propagateStoreModeLibraryEdit(fakeConn, 999)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
