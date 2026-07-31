import { useEffect, useRef, useState } from 'react';
import { CustomersApi, ProductsApi, OrdersApi } from '../api';
import DeliveryPinPicker from './DeliveryPinPicker';
import './CreateOrderModal.css';

const formatMoney = (v) => `₹${(Number(v) || 0).toFixed(0)}`;

/**
 * Admin "place order on behalf of a customer" popup — phone lookup against
 * the existing users table, then the same item/address/payment/fast-delivery
 * options the customer app checkout offers, with a live server-calculated
 * bill (same money code as the customer app, see adminCalculateOrder).
 */
export default function CreateOrderModal({ onClose, onCreated }) {
  // ── Customer ──────────────────────────────────────────────────────────
  const [customerQuery, setCustomerQuery] = useState('');
  const [customerResults, setCustomerResults] = useState([]);
  const [customerSearching, setCustomerSearching] = useState(false);
  const [customer, setCustomer] = useState(null);

  // ── Items ─────────────────────────────────────────────────────────────
  const [productQuery, setProductQuery] = useState('');
  const [productResults, setProductResults] = useState([]);
  const [productSearching, setProductSearching] = useState(false);
  const [cartItems, setCartItems] = useState([]); // { productId, name, unitPrice, quantity, variantId, variantLabel }

  // ── Delivery / payment ───────────────────────────────────────────────
  const [address, setAddress] = useState('');
  // Optional pin — same latitude/longitude the customer app's checkout
  // sends, so an admin-placed order gets the same zone-based delivery
  // pricing and out-of-range/COD checks instead of always pricing off no
  // location at all (calculateForCustomer/createForCustomer both accept it,
  // see adminCalculateOrder/adminCreateOrder — they delegate straight to the
  // customer cart/order controllers).
  const [deliveryCoords, setDeliveryCoords] = useState(null);
  const [paymentMethod, setPaymentMethod] = useState('Cash');
  const [deliveryType, setDeliveryType] = useState('standard');
  const [couponCode, setCouponCode] = useState('');
  const [note, setNote] = useState('');

  // ── Bill preview ─────────────────────────────────────────────────────
  const [bill, setBill] = useState(null);
  const [calculating, setCalculating] = useState(false);
  const [calcError, setCalcError] = useState(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  const calcTimerRef = useRef(null);
  const customerTimerRef = useRef(null);
  const productTimerRef = useRef(null);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  // Customer search (debounced)
  useEffect(() => {
    if (customerTimerRef.current) clearTimeout(customerTimerRef.current);
    if (!customerQuery.trim()) { setCustomerResults([]); return; }
    customerTimerRef.current = setTimeout(async () => {
      setCustomerSearching(true);
      try {
        const res = await CustomersApi.list({ search: customerQuery.trim(), limit: 8 });
        setCustomerResults(res.data || res.customers || []);
      } catch (_) {
        setCustomerResults([]);
      } finally {
        setCustomerSearching(false);
      }
    }, 350);
    return () => clearTimeout(customerTimerRef.current);
  }, [customerQuery]);

  // Product search (debounced)
  useEffect(() => {
    if (productTimerRef.current) clearTimeout(productTimerRef.current);
    if (!productQuery.trim()) { setProductResults([]); return; }
    productTimerRef.current = setTimeout(async () => {
      setProductSearching(true);
      try {
        const res = await ProductsApi.list({ search: productQuery.trim(), limit: 8, is_combo: '' });
        setProductResults(res.data?.products || res.products || []);
      } catch (_) {
        setProductResults([]);
      } finally {
        setProductSearching(false);
      }
    }, 350);
    return () => clearTimeout(productTimerRef.current);
  }, [productQuery]);

  // Live bill calculation whenever cart/delivery/coupon changes
  useEffect(() => {
    if (calcTimerRef.current) clearTimeout(calcTimerRef.current);
    if (!customer || cartItems.length === 0) { setBill(null); return; }
    calcTimerRef.current = setTimeout(async () => {
      setCalculating(true);
      setCalcError(null);
      try {
        const res = await OrdersApi.calculateForCustomer({
          customer_id: customer.id,
          delivery_type: deliveryType,
          coupon_code: couponCode.trim() || undefined,
          latitude: deliveryCoords?.latitude,
          longitude: deliveryCoords?.longitude,
          items: cartItems.map((it) => ({
            productId: it.productId,
            variantId: it.variantId || undefined,
            quantity: it.quantity,
            type: it.type || 'product',
          })),
        });
        setBill(res.data || res);
      } catch (err) {
        setCalcError(err.message || 'Could not calculate bill');
        setBill(null);
      } finally {
        setCalculating(false);
      }
    }, 400);
    return () => clearTimeout(calcTimerRef.current);
  }, [customer, cartItems, deliveryType, couponCode, deliveryCoords]);

  // If the zone stops allowing COD (e.g. address/items changed), fall back
  // to UPI instead of leaving Cash selected but disabled.
  useEffect(() => {
    if (bill?.codAllowed === false && paymentMethod === 'Cash') {
      setPaymentMethod('UPI');
    }
  }, [bill, paymentMethod]);

  const pickCustomer = (c) => {
    setCustomer(c);
    setAddress(c.address || '');
    setDeliveryCoords(null);
    setCustomerQuery('');
    setCustomerResults([]);
  };

  const addProduct = (p, variant) => {
    setCartItems((prev) => {
      const variantId = variant?.id || null;
      const existing = prev.find((it) => it.productId === p.id && it.variantId === variantId);
      if (existing) {
        return prev.map((it) => (it === existing ? { ...it, quantity: it.quantity + 1 } : it));
      }
      return [...prev, {
        productId: p.id,
        type: p.is_combo ? 'combo' : 'product',
        name: p.name + (variant ? ` (${variant.label})` : ''),
        unitPrice: variant ? Number(variant.price) : Number(p.price),
        quantity: 1,
        variantId,
        variantLabel: variant?.label || null,
      }];
    });
    setProductQuery('');
    setProductResults([]);
  };

  const updateQty = (idx, delta) => {
    setCartItems((prev) => prev
      .map((it, i) => (i === idx ? { ...it, quantity: it.quantity + delta } : it))
      .filter((it) => it.quantity > 0));
  };

  const removeItem = (idx) => {
    setCartItems((prev) => prev.filter((_, i) => i !== idx));
  };

  const localSubtotal = cartItems.reduce((sum, it) => sum + it.unitPrice * it.quantity, 0);

  // A no-delivery exclusion zone reports outOfRange: false but still blocks
  // the order, so both flags need checking (mirrors CheckoutScreen.js).
  const deliveryBlocked = Boolean(bill?.outOfRange) || Boolean(bill?.excluded);
  const codUnavailable = bill?.codAllowed === false;

  const canSubmit = customer && cartItems.length > 0 && address.trim() && !submitting && !calculating
    && !deliveryBlocked && !(paymentMethod === 'Cash' && codUnavailable);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await OrdersApi.createForCustomer({
        customer_id: customer.id,
        address: address.trim(),
        payment_method: paymentMethod,
        delivery_type: deliveryType,
        coupon_code: couponCode.trim() || undefined,
        note: note.trim() || undefined,
        latitude: deliveryCoords?.latitude,
        longitude: deliveryCoords?.longitude,
        items: cartItems.map((it) => ({
          productId: it.productId,
          variantId: it.variantId || undefined,
          quantity: it.quantity,
          type: it.type || 'product',
        })),
      });
      onCreated?.(res.order || res.data || res);
    } catch (err) {
      setSubmitError(err.message || 'Could not place order');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="com-overlay" onClick={onClose}>
      <div className="com-panel" onClick={(e) => e.stopPropagation()}>
        <div className="com-header">
          <div>
            <h2 className="com-title">Create Order</h2>
            <p className="com-subtitle">Place an order on behalf of an existing customer.</p>
          </div>
          <button className="com-close" onClick={onClose} aria-label="Close">&times;</button>
        </div>

        <div className="com-body">
          {/* Customer */}
          <section className="com-section">
            <h3 className="com-section-title">1. Customer</h3>
            {customer ? (
              <div className="com-customer-card">
                <div>
                  <strong>{customer.name || 'Unnamed'}</strong>
                  <div className="com-customer-meta">{customer.phone}{customer.blocked ? ' • Blocked' : ''}</div>
                </div>
                <button className="btn-secondary" onClick={() => setCustomer(null)}>Change</button>
              </div>
            ) : (
              <div className="com-search-wrap">
                <input
                  type="text"
                  className="com-input"
                  placeholder="Search customer by phone number or name..."
                  value={customerQuery}
                  onChange={(e) => setCustomerQuery(e.target.value)}
                  autoFocus
                />
                {customerSearching && <div className="com-search-hint">Searching...</div>}
                {customerResults.length > 0 && (
                  <div className="com-results">
                    {customerResults.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className="com-result-row"
                        disabled={c.blocked}
                        onClick={() => pickCustomer(c)}
                      >
                        <span>{c.name || 'Unnamed'}</span>
                        <span className="com-result-phone">{c.phone}{c.blocked ? ' (blocked)' : ''}</span>
                      </button>
                    ))}
                  </div>
                )}
                {!customerSearching && customerQuery.trim() && customerResults.length === 0 && (
                  <div className="com-search-hint">No registered customer found with that number/name.</div>
                )}
              </div>
            )}
          </section>

          {/* Items */}
          <section className="com-section">
            <h3 className="com-section-title">2. Items</h3>
            <div className="com-search-wrap">
              <input
                type="text"
                className="com-input"
                placeholder="Search product name..."
                value={productQuery}
                onChange={(e) => setProductQuery(e.target.value)}
              />
              {productSearching && <div className="com-search-hint">Searching...</div>}
              {productResults.length > 0 && (
                <div className="com-results">
                  {productResults.map((p) => (
                    <div key={p.id} className="com-product-row">
                      <span className="com-product-name">{p.name}</span>
                      {Array.isArray(p.variants) && p.variants.length > 0 ? (
                        p.variants.filter(v => v.available).map((v) => (
                          <button
                            key={v.id}
                            type="button"
                            className="btn-secondary com-add-btn"
                            onClick={() => addProduct(p, v)}
                          >
                            {v.label} · {formatMoney(v.price)}
                          </button>
                        ))
                      ) : (
                        <button type="button" className="btn-secondary com-add-btn" onClick={() => addProduct(p)}>
                          {formatMoney(p.price)} · Add
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {cartItems.length > 0 ? (
              <div className="com-cart">
                {cartItems.map((it, idx) => (
                  <div key={`${it.productId}-${it.variantId || 'base'}`} className="com-cart-row">
                    <span className="com-cart-name">{it.name}</span>
                    <span className="com-cart-price">{formatMoney(it.unitPrice)}</span>
                    <div className="com-qty-stepper">
                      <button type="button" onClick={() => updateQty(idx, -1)}>-</button>
                      <span>{it.quantity}</span>
                      <button type="button" onClick={() => updateQty(idx, 1)}>+</button>
                    </div>
                    <span className="com-cart-line-total">{formatMoney(it.unitPrice * it.quantity)}</span>
                    <button type="button" className="com-remove-btn" onClick={() => removeItem(idx)}>&times;</button>
                  </div>
                ))}
                <div className="com-cart-subtotal">
                  <span>Item Total</span>
                  <strong>{formatMoney(localSubtotal)}</strong>
                </div>
              </div>
            ) : (
              <p className="com-empty-hint">No items added yet. Search above to add products.</p>
            )}
          </section>

          {/* Delivery / payment */}
          <section className="com-section">
            <h3 className="com-section-title">3. Delivery & Payment</h3>
            <label className="com-label">Delivery Address</label>
            <textarea
              className="com-textarea"
              rows={2}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Delivery address"
              disabled={!customer}
            />

            {customer && (
              <DeliveryPinPicker value={deliveryCoords} onChange={setDeliveryCoords} />
            )}

            {bill?.fastDeliveryEnabled && (
              <label className="com-checkbox-row">
                <input
                  type="checkbox"
                  checked={deliveryType === 'fast'}
                  onChange={(e) => setDeliveryType(e.target.checked ? 'fast' : 'standard')}
                />
                <span>Add Fast Delivery (+{formatMoney(bill.fastDeliveryCharge)})</span>
              </label>
            )}

            <div className="com-radio-group">
              <label className={`com-radio-pill ${paymentMethod === 'Cash' ? 'active' : ''} ${codUnavailable ? 'disabled' : ''}`}>
                <input
                  type="radio"
                  checked={paymentMethod === 'Cash'}
                  disabled={codUnavailable}
                  onChange={() => setPaymentMethod('Cash')}
                />
                Cash on Delivery
              </label>
              <label className={`com-radio-pill ${paymentMethod === 'UPI' ? 'active' : ''}`}>
                <input type="radio" checked={paymentMethod === 'UPI'} onChange={() => setPaymentMethod('UPI')} />
                UPI
              </label>
            </div>
            {codUnavailable && (
              <div className="com-error-text">Cash on Delivery is not available at this location. Use UPI.</div>
            )}

            <label className="com-label">Coupon code (optional)</label>
            <input
              type="text"
              className="com-input"
              value={couponCode}
              onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
              placeholder="e.g. FLAT50"
            />

            <label className="com-label">Note (optional)</label>
            <input
              type="text"
              className="com-input"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Delivery instructions..."
            />
          </section>

          {/* Bill */}
          <section className="com-section">
            <h3 className="com-section-title">Bill Summary</h3>
            {calcError && <div className="com-error-text">{calcError}</div>}
            {!customer || cartItems.length === 0 ? (
              <p className="com-empty-hint">Pick a customer and add items to see the total.</p>
            ) : calculating && !bill ? (
              <p className="com-empty-hint">Calculating...</p>
            ) : bill ? (
              <div className="com-bill">
                <div className="com-bill-row"><span>Subtotal</span><span>{formatMoney(bill.subtotal)}</span></div>
                <div className="com-bill-row"><span>Delivery Charge</span><span>{formatMoney(bill.deliveryCharge)}</span></div>
                {bill.fastDeliveryFee > 0 && (
                  <div className="com-bill-row"><span>Fast Delivery Add-on</span><span>{formatMoney(bill.fastDeliveryFee)}</span></div>
                )}
                {bill.nightCharge > 0 && (
                  <div className="com-bill-row"><span>Night Charge</span><span>{formatMoney(bill.nightCharge)}</span></div>
                )}
                {bill.rainCharge > 0 && (
                  <div className="com-bill-row"><span>Rain Charge</span><span>{formatMoney(bill.rainCharge)}</span></div>
                )}
                {bill.discount > 0 && (
                  <div className="com-bill-row com-bill-discount"><span>Discount</span><span>-{formatMoney(bill.discount)}</span></div>
                )}
                {bill.couponError && <div className="com-error-text">{bill.couponError}</div>}
                {deliveryBlocked && (
                  <div className="com-error-text">
                    {bill.exclusionMessage || bill.deliveryMessage || 'Delivery is not available at this location. Choose a closer address.'}
                  </div>
                )}
                <div className="com-bill-row com-bill-total"><span>Grand Total</span><span>{formatMoney(bill.grandTotal)}</span></div>
              </div>
            ) : null}
          </section>

          {submitError && <div className="com-error-text com-submit-error">{submitError}</div>}
        </div>

        <div className="com-footer">
          <button className="btn-secondary" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="btn-primary" onClick={handleSubmit} disabled={!canSubmit}>
            {submitting ? 'Placing Order...' : bill ? `Place Order • ${formatMoney(bill.grandTotal)}` : 'Place Order'}
          </button>
        </div>
      </div>
    </div>
  );
}
