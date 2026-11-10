import { Link, useNavigate } from 'react-router-dom';
import { useCart } from '../hooks/useCart';
import { isTbd, isTrackedItem, qtyCapFor, lineKey } from '../context/CartContext.jsx';
import { money } from '../components/ProductCard';

// Cart — route "/shop/cart". Price-TBD lines stay in the cart, are
// excluded from the totals, and block checkout with a clear message
// (the shop's standing rule; the API enforces it server-side too).
export default function Cart() {
  const { items, removeFromCart, updateQty, calculateTotals } = useCart();
  const navigate = useNavigate();
  const totals = calculateTotals();

  return (
    <main className="shell">
      <Link className="back-link" to="/shop/products">
        ← Continue Shopping
      </Link>
      <div className="page-head">
        <h1 className="page-title">Shopping Cart</h1>
      </div>

      {items.length === 0 ? (
        <div>
          <p className="empty-msg">Your cart is empty</p>
          <Link className="btn btn-kai" to="/shop/products">
            Continue Shopping
          </Link>
        </div>
      ) : (
        <div className="cart-layout">
          <section className="cart-lines" aria-label="Order items">
            {items.map((item) => {
              const tbd = isTbd(item);
              // Inventory (2026-11-09): the stepper caps at the shelf
              // count for tracked items (updateQty enforces it too);
              // show a note when the line is sitting at that cap.
              // Clothing (2026-11-09): stock is per product across
              // sizes, so the cap compares the product's cart TOTAL.
              const productTotal = items
                .filter((i) => i.id === item.id)
                .reduce((sum, i) => sum + i.qty, 0);
              const capped =
                isTrackedItem(item) && productTotal >= qtyCapFor(item);
              const tile = Array.isArray(item.tile) ? item.tile : ['#374151', '#111827'];
              return (
                <div className="cart-line" key={lineKey(item)}>
                  <div
                    className="thumb-sm"
                    style={{ background: `linear-gradient(135deg, ${tile[0]}, ${tile[1]})` }}
                  >
                    <img src={item.image} alt="" />
                  </div>
                  <div>
                    <div className="cl-name">{item.name}</div>
                    <div className="cl-sub">{item.subtitle}</div>
                    {item.size && <div className="cl-sub">Size: {item.size}</div>}
                    <div className={`cl-price${tbd ? ' tbd' : ''}`}>
                      {tbd ? 'Price TBD' : money(item.price * item.qty)}
                    </div>
                  </div>
                  <div className="cl-right">
                    <div className="qty-control">
                      <button
                        type="button"
                        aria-label="Decrease quantity"
                        onClick={() => updateQty(item.id, item.qty - 1, item.size)}
                      >
                        −
                      </button>
                      <span className="qty-val">{item.qty}</span>
                      <button
                        type="button"
                        aria-label="Increase quantity"
                        onClick={() => updateQty(item.id, item.qty + 1, item.size)}
                      >
                        +
                      </button>
                    </div>
                    <button
                      className="remove-btn"
                      type="button"
                      onClick={() => removeFromCart(item.id, item.size)}
                    >
                      Remove
                    </button>
                    {capped && (
                      <div className="cl-sub">Only {item.stockQty} in stock — quantity capped</div>
                    )}
                  </div>
                </div>
              );
            })}
          </section>

          <aside className="summary-card">
            <h3>Order Summary</h3>
            <div className="sum-row">
              <span>Subtotal</span>
              <span>{money(totals.subtotal)}</span>
            </div>
            <div className="sum-row">
              <span>Taxes (10.2%)</span>
              <span>{money(totals.taxes)}</span>
            </div>
            <div className="sum-row total">
              <span>Total</span>
              <span>{money(totals.total)}</span>
            </div>
            <p className="sum-note">Shipping calculated at checkout by USPS.</p>
            {totals.hasTbd && (
              <>
                <p className="sum-note">
                  Price TBD items are not included in the totals above.
                </p>
                <div className="notice danger" role="alert">
                  <strong>Checkout is blocked:</strong>{' '}
                  {totals.tbdItems.map((i) => i.name).join(', ')}{' '}
                  {totals.tbdItems.length === 1 ? 'has no confirmed price yet' : 'have no confirmed prices yet'}
                  {' '}and can&apos;t be ordered until the price is set. Remove{' '}
                  {totals.tbdItems.length === 1 ? 'it' : 'them'} to check out with the
                  rest of your cart.
                </div>
              </>
            )}
            <button
              className="btn-green"
              type="button"
              disabled={totals.hasTbd}
              onClick={() => navigate('/shop/checkout')}
            >
              Proceed to Checkout
            </button>
          </aside>
        </div>
      )}
    </main>
  );
}
