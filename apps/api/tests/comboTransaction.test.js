const { createCombo } = require('../src/controllers/comboController');
const { pool } = require('../src/db/mysql');

jest.mock('../src/db/mysql', () => ({
  pool: {
    query: jest.fn(),
    getConnection: jest.fn()
  }
}));

describe('Combo Transactional Update', () => {
  let mockConnection;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConnection = {
      beginTransaction: jest.fn(),
      query: jest.fn(),
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn()
    };
    pool.getConnection.mockResolvedValue(mockConnection);
  });

  it('should rollback if item insertion fails', async () => {
    // Mock validateComboItems (runs twice: once in createCombo, once in saveComboItems)
    pool.query.mockResolvedValue([[{ id: 1, name: 'Burger', deleted: 0, available: 1, is_combo: 0, category_type: 'fast_food' }]]); 

    // Mock combo insertion (success)
    mockConnection.query.mockResolvedValueOnce([{ insertId: 10 }]);
    
    // Mock combo items delete (success)
    mockConnection.query.mockResolvedValueOnce([]);
    
    // Mock combo items insert (throws)
    mockConnection.query.mockRejectedValueOnce(new Error('Insert failed'));

    const req = {
      areaId: 1,
      validatedData: {
        name: 'My Combo',
        combo_items: [{ product_id: 1, quantity: 1 }],
        store_type: 'fast_food'
      }
    };
    
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };

    await expect(createCombo(req, res)).rejects.toThrow('Insert failed');
    
    expect(mockConnection.beginTransaction).toHaveBeenCalled();
    expect(mockConnection.rollback).toHaveBeenCalled();
    expect(mockConnection.commit).not.toHaveBeenCalled();
    expect(mockConnection.release).toHaveBeenCalled();
  });
});
