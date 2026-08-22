import { useEffect, useRef, useState } from 'react';
import { ProductsApi, OrdersApi } from '../api';
import './CreateOrderModal.css';
import './ReplaceItemModal.css';

const formatMoney = (v) => `₹${(Number(v) || 0).toFixed(0)}`;

/**
 * Admin "swap this line item for a different product" popup — opened from
 * the Orders drawer when a line's product is out of stock (or just the
 * wrong pick). Search is pre-scoped to the original item's shop (or house
 * products only, if the item has no shop) so a swap never silently hands
 * fulfillment to a shop that was never notified about this order.
 */
export default function ReplaceItemModal({ order, item, onClose, onReplaced }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [pickingKey, setPickingKey] = useState(null);
  const [error, setError] = useState(null);
  const searchTimerRef = useRef(null);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!query.trim()) { setResults([]); return; }
    searchTimerRef.current = setTimeout(async () => {
      setSearching(true);
      setError(null);
      try {
        const res = await ProductsApi.list({
          search: query.trim(),
          limit: 8,
          is_combo: '',
          shopId: item.shop_id ?? 'none',
          available: true,
        });
        const products = res.data?.products || res.products || [];
        // Never offer swapping an item for itself.
        setResults(products.filter((p) => p.id !== item.product_id));
      } catch (err) {
        setResults([]);
        setError(err.message || 'Could not search products');
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => clearTimeout(searchTimerRef.current);
  }, [query, item.shop_id, item.product_id]);

  const pickReplacement = async (product, variant) => {
    const key = `${product.id}-${variant?.id || 'base'}`;
    setPickingKey(key);
    setError(null);
    try {
      const res = await OrdersApi.replaceItem(order.id, item.id, {
        expectedProductId: item.product_id,
        expectedVariantId: item.variant_id || null,
        expectedUnitPrice: item.unit_price,
        newProductId: product.id,
        newVariantId: variant?.id || null,
      });
      onReplaced?.(res.order, res.item);
      onClose?.();
    } catch (err) {
      setError(err.message || 'Could not change this item');
    } finally {
      setPickingKey(null);
    }
  };

  return (
    <div className="com-overlay rim-overlay" onClick={onClose}>
      <div className="com-panel rim-panel" onClick={(e) => e.stopPropagation()}>
        <div className="com-header">
          <div>
            <h2 className="com-title">Change Item</h2>
            <p className="com-subtitle">
              {item.shop_id
                ? `Pick another product from ${item.shop_name || 'this shop'} to replace it.`
                : 'Pick another available product to replace it.'}
            </p>
          </div>
          <button className="com-close" onClick={onClose} aria-label="Close">&times;</button>
        </div>

        <div className="com-body">
          <section className="com-section">
            <h3 className="com-section-title">Currently in order</h3>
            <div className="rim-current-row">
              <span className="rim-current-name">{item.quantity}x {item.product_name}</span>
              <strong>{formatMoney(item.line_total)}</strong>
            </div>
          </section>

          <section className="com-section">
            <h3 className="com-section-title">Replace with</h3>
            <div className="com-search-wrap">
              <input
                type="text"
                className="com-input"
                placeholder="Search product name..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
              />
              {searching && <div className="com-search-hint">Searching...</div>}
              {!searching && !error && query.trim() && results.length === 0 && (
                <div className="com-search-hint">
                  {item.shop_id ? 'No other in-stock products found for this shop.' : 'No other in-stock house products found.'}
                </div>
              )}
              {results.length > 0 && (
                <div className="com-results">
                  {results.map((p) => (
                    <div key={p.id} className="com-product-row">
                      <span className="com-product-name">{p.name}</span>
                      {Array.isArray(p.variants) && p.variants.length > 0 ? (
                        p.variants.filter((v) => v.available).map((v) => (
                          <button
                            key={v.id}
                            type="button"
                            className="btn-secondary com-add-btn"
                            disabled={pickingKey !== null}
                            onClick={() => pickReplacement(p, v)}
                          >
                            {pickingKey === `${p.id}-${v.id}` ? 'Changing…' : `${v.label} · ${formatMoney(v.price)}`}
                          </button>
                        ))
                      ) : (
                        <button
                          type="button"
                          className="btn-secondary com-add-btn"
                          disabled={pickingKey !== null}
                          onClick={() => pickReplacement(p)}
                        >
                          {pickingKey === `${p.id}-base` ? 'Changing…' : `${formatMoney(p.price)} · Use this`}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
            {error && <div className="com-error-text com-submit-error">{error}</div>}
          </section>
        </div>

        <div className="com-footer">
          <button className="btn-secondary" onClick={onClose} disabled={pickingKey !== null}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
