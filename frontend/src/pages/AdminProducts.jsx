import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import {
  clearAdminToken,
  deleteAdminProduct,
  fetchAdminProducts,
  getAdminToken,
} from '../services/adminApi';
import { priceLabel } from '../components/ProductCard';
import ProductEditor from '../components/ProductEditor';

// Admin products page — route "/shop/admin/products", reached from
// the Products tab on the admin dashboard (the direct URL works too;
// nothing public links here, same as the rest of the admin).
//
// This page is where the catalog is managed — the dashboard's
// Products section is now only a summary. The product editor
// (components/ProductEditor.jsx) sits open in "Add product" mode at
// the top; the full catalog list below carries Edit / Delete per
// row. Edit swaps the form into edit mode and scrolls it into view;
// saving, closing, or deleting the product being edited returns the
// form to a fresh Add. The backend contract — POST /api/products,
// PUT + DELETE /api/products/:id, admin only — is documented in
// docs/PRODUCT_EDITOR.md.
//
// A 401 from any call means the token expired or was revoked:
// adminApi clears it, and this page sends the admin back to sign in.

// Mirrors DEFAULT_LOW_STOCK_THRESHOLD in functions/api/_lib/validate.js.
const ADMIN_LOW_STOCK_DEFAULT = 3;

export default function AdminProducts() {
  const navigate = useNavigate();
  const hasToken = Boolean(getAdminToken());

  const [products, setProducts] = useState(null);
  const [productsError, setProductsError] = useState('');
  // null = the form is in "Add product" mode; a product = editing it.
  const [editing, setEditing] = useState(null);
  // Bumped to remount the editor with a fresh blank Add form.
  const [formKey, setFormKey] = useState(0);
  const [deleteBusyId, setDeleteBusyId] = useState(null);
  const formAnchorRef = useRef(null);

  const bounceToLogin = useCallback(() => {
    clearAdminToken();
    navigate('/shop/admin/login', { replace: true });
  }, [navigate]);

  const handleError = useCallback(
    (err, setLocalError) => {
      if (err && err.status === 401) {
        bounceToLogin();
        return;
      }
      setLocalError(err.message);
    },
    [bounceToLogin]
  );

  /** Re-read the catalog after an editor save or a delete. */
  const reloadProducts = useCallback(async () => {
    try {
      const data = await fetchAdminProducts();
      setProducts(Array.isArray(data) ? data : []);
    } catch (err) {
      handleError(err, setProductsError);
    }
  }, [handleError]);

  useEffect(() => {
    if (!hasToken) return undefined;
    let cancelled = false;
    fetchAdminProducts()
      .then((data) => {
        if (!cancelled) setProducts(Array.isArray(data) ? data : []);
      })
      .catch((err) => {
        if (!cancelled) handleError(err, setProductsError);
      });
    return () => {
      cancelled = true;
    };
  }, [hasToken, handleError]);

  if (!hasToken) return <Navigate to="/shop/admin/login" replace />;

  /** Back to a fresh "Add product" form. */
  const resetForm = () => {
    setEditing(null);
    setFormKey((k) => k + 1);
  };

  const startEdit = (p) => {
    setEditing(p);
    // The editor remounts (new key) above the list; bring it into view.
    requestAnimationFrame(() => {
      if (formAnchorRef.current) {
        formAnchorRef.current.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        });
      }
    });
  };

  const removeProductRow = async (p) => {
    if (
      !window.confirm(
        `Delete "${p.name}"? It will be removed from the catalog. ` +
          '(Its photo file, if any, stays in storage.)'
      )
    ) {
      return;
    }
    setDeleteBusyId(p.id);
    setProductsError('');
    try {
      await deleteAdminProduct(p.id);
      if (editing && editing.id === p.id) resetForm();
      await reloadProducts();
    } catch (err) {
      handleError(err, setProductsError);
    } finally {
      setDeleteBusyId(null);
    }
  };

  return (
    <main className="shell">
      <Link className="back-link" to="/shop/admin">
        ← Back to Admin Dashboard
      </Link>

      <div className="page-head admin-head">
        <div>
          <p className="kicker">Beastmode 82420</p>
          <h1 className="page-title">Products</h1>
        </div>
      </div>

      <nav className="admin-tabs" aria-label="Admin">
        <Link className="admin-tab" to="/shop/admin">
          Dashboard
        </Link>
        <span className="admin-tab is-active" aria-current="page">
          Products
        </span>
      </nav>

      <p className="section-sub">
        Add a product with the form — name, price, photo, stock and the
        Shipping checkbox — and it is live on the shelf. Use Edit on a
        row below to change a product, and Delete to take one off the
        shelf.
      </p>

      <div ref={formAnchorRef} className="editor-anchor">
        <ProductEditor
          key={editing ? `edit-${editing.id}` : `new-${formKey}`}
          product={editing}
          onClose={resetForm}
          onSaved={() => {
            resetForm();
            reloadProducts();
          }}
          onPartialSave={() => reloadProducts()}
          onAuthError={bounceToLogin}
        />
      </div>

      <h2 className="section-title" style={{ marginTop: 44 }}>
        Catalog
      </h2>
      {productsError && (
        <p className="form-error" role="alert">
          {productsError}
        </p>
      )}
      {products === null && !productsError && (
        <p className="card-sub">Loading products…</p>
      )}
      {products !== null && products.length === 0 && (
        <p className="empty-msg">
          The catalog is empty right now — there are no products on the
          shelf. That is the real state of the shop, not a loading error.
          Use the form above to put the first one on it.
        </p>
      )}
      {products !== null && products.length > 0 && (
        <div className="orders-list">
          {products.map((p) => {
            // Inventory (2026-11-09): stock state at a glance, same
            // rendering as the dashboard's Products summary. Counts
            // are managed in the editor above (or the stock PATCH
            // endpoint — see docs/INVENTORY.md).
            const threshold =
              p.lowStockThreshold != null ? p.lowStockThreshold : ADMIN_LOW_STOCK_DEFAULT;
            const stockLabel =
              p.stockQty == null
                ? 'Untracked'
                : p.stockQty === 0
                  ? 'Sold out'
                  : `${p.stockQty} in stock${p.stockQty <= threshold ? ' · Low' : ''}`;
            return (
              <div className="order-row" key={p.id}>
                <div>
                  <div className="ord-id">{p.name}</div>
                  <div className="ord-meta">
                    {p.subtitle} · {p.category}
                    {p.brand ? ` · ${p.brand}` : ''}
                  </div>
                  <div className="ord-meta">
                    Stock: {stockLabel}
                    {p.freeShipping ? ' · Free shipping' : ''}
                  </div>
                </div>
                <div>
                  <div className="ord-id">{priceLabel(p)}</div>
                </div>
                <div className="admin-order-actions">
                  <button
                    className="btn-ghost"
                    type="button"
                    onClick={() => startEdit(p)}
                  >
                    Edit
                  </button>
                  <button
                    className="btn-ghost danger"
                    type="button"
                    disabled={deleteBusyId === p.id}
                    onClick={() => removeProductRow(p)}
                  >
                    {deleteBusyId === p.id ? 'Deleting…' : 'Delete'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
