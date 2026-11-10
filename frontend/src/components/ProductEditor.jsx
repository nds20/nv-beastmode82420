import { useState } from 'react';
import { saveAdminProduct } from '../services/adminApi';

// Admin product editor — the Add/Edit form on the dedicated
// Products page (/shop/admin/products), which the admin dashboard
// links to from its Products tab. The form sits open in Add mode at
// the top of that page; a catalog row's Edit button swaps it into
// Edit mode.
//
// The backend contract lives in functions/api/_lib/validate.js
// (normalizeProduct); this form collects exactly those fields and
// hands the raw form state to saveAdminProduct (services/adminApi.js),
// which owns the wire format — including the two-step JSON-then-photo
// save that switching a product to "Unlimited" stock requires.
// Read docs/PRODUCT_EDITOR.md before changing field semantics.
//
// Owner's headline control (2026-11-09): the Shipping checkbox.
// CHECKED = the item ships and the buyer pays the USPS rate at
// checkout (freeShipping false). UNCHECKED = No shipping (the
// freeShipping flag: the item is left out of the shipping math
// entirely, and an all-no-shipping cart checks out at $0 shipping).
//
// Props:
//   product       null -> "Add product"; a product -> "Edit product"
//   onClose()     leave the form without saving (the parent page
//                 resets it to a fresh Add form)
//   onSaved()     full save landed — parent resets + refreshes
//   onPartialSave(product)  fields saved but the photo failed; the
//                 parent refreshes its list while this form stays
//                 open (now editing the saved product)
//   onAuthError() a 401 came back — parent bounces to sign-in

// Mirrors CATEGORIES in functions/api/_lib/validate.js (the API
// rejects anything else) with the storefront's label rule
// (pages/Products.jsx): capitalize, except nic-vapes.
const CATEGORIES = ['flower', 'vapes', 'gummies', 'pouches', 'nic-vapes'];
const categoryLabel = (c) =>
  c === 'nic-vapes' ? 'Nicotine Vapes' : c.charAt(0).toUpperCase() + c.slice(1);

// Mirrors DEFAULT_TILE in functions/api/_lib/validate.js.
const DEFAULT_TILE = ['#374151', '#111827'];

const asText = (v) => (v === null || v === undefined ? '' : String(v));

function initialForm(product) {
  if (!product) {
    return {
      id: null,
      name: '',
      subtitle: '',
      category: CATEGORIES[0],
      type: '',
      price: '',
      thc: '',
      strength: '',
      unit: '',
      effectsText: '',
      tile: [...DEFAULT_TILE],
      image: null,
      freeShipping: false,
      weightOz: '',
      lengthIn: '',
      widthIn: '',
      heightIn: '',
      stockMode: 'untracked',
      stockQty: '',
      lowStockThreshold: '',
    };
  }
  return {
    id: product.id,
    name: asText(product.name),
    subtitle: asText(product.subtitle),
    category: product.category || CATEGORIES[0],
    type: asText(product.type),
    price: asText(product.price),
    thc: asText(product.thc),
    strength: asText(product.strength),
    unit: asText(product.unit),
    effectsText: Array.isArray(product.effects) ? product.effects.join(', ') : '',
    tile:
      Array.isArray(product.tile) && product.tile.length === 2
        ? [...product.tile]
        : [...DEFAULT_TILE],
    image: product.image || null,
    freeShipping: Boolean(product.freeShipping),
    weightOz: asText(product.weightOz),
    lengthIn: asText(product.lengthIn),
    widthIn: asText(product.widthIn),
    heightIn: asText(product.heightIn),
    stockMode: product.stockQty === null || product.stockQty === undefined ? 'untracked' : 'tracked',
    stockQty: asText(product.stockQty),
    lowStockThreshold: asText(product.lowStockThreshold),
  };
}

export default function ProductEditor({
  product,
  onClose,
  onSaved,
  onPartialSave,
  onAuthError,
}) {
  const [form, setForm] = useState(() => initialForm(product));
  const [photoFile, setPhotoFile] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const editing = form.id !== null && form.id !== undefined;

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  const setFlag = (field, value) => () => setForm((f) => ({ ...f, [field]: value }));

  // The product's category could predate the list (it can't today —
  // the API validates — but never silently swap a value on render).
  const categoryOptions = CATEGORIES.includes(form.category)
    ? CATEGORIES
    : [form.category, ...CATEGORIES];

  const save = async (e) => {
    e.preventDefault();
    setError('');
    // The one client-side guard: "Track stock" with an empty quantity
    // would serialize to null — i.e. silently become Unlimited. Make
    // the admin choose instead.
    if (form.stockMode === 'tracked' && String(form.stockQty).trim() === '') {
      setError('Enter a stock quantity, or choose "Unlimited (don\'t track stock)".');
      return;
    }
    setSaving(true);
    try {
      const saved = await saveAdminProduct(form, photoFile);
      onSaved(saved);
    } catch (err) {
      if (err && err.status === 401) {
        if (onAuthError) onAuthError();
        return;
      }
      if (err && err.savedProduct) {
        // Fields landed; only the photo step failed. Adopt the saved
        // product so the next Save edits it instead of duplicating,
        // and keep the chosen file so that Save retries the photo.
        setForm(initialForm(err.savedProduct));
        if (onPartialSave) onPartialSave(err.savedProduct);
        setError(
          `${err.message} The product details were saved — fix the photo ` +
            'problem and press Save again to attach the photo.'
        );
      } else {
        setError((err && err.message) || 'Could not save the product.');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="product-editor" onSubmit={save}>
      <div className="editor-head">
        <h3>{editing ? 'Edit product' : 'Add product'}</h3>
        <button className="btn-ghost" type="button" onClick={onClose} disabled={saving}>
          Close
        </button>
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <div className="field">
        <label htmlFor="pe-name">Name *</label>
        <input
          id="pe-name"
          type="text"
          value={form.name}
          onChange={set('name')}
          required
        />
      </div>

      <div className="field">
        <label htmlFor="pe-subtitle">Subtitle</label>
        <input
          id="pe-subtitle"
          type="text"
          value={form.subtitle}
          onChange={set('subtitle')}
        />
        <p className="hint">The line under the name on the product card.</p>
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="pe-category">Category *</label>
          <select id="pe-category" value={form.category} onChange={set('category')}>
            {categoryOptions.map((c) => (
              <option key={c} value={c}>
                {categoryLabel(c)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="pe-type">Type *</label>
          <input
            id="pe-type"
            type="text"
            value={form.type}
            onChange={set('type')}
            required
          />
          <p className="hint">e.g. Merch, Apparel, Test Item</p>
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="pe-price">Price (dollars)</label>
          <input
            id="pe-price"
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            value={form.price}
            onChange={set('price')}
          />
          <p className="hint">
            Leave blank for Price TBD — the product shows but can&apos;t be bought.
          </p>
        </div>
        <div className="field">
          <label htmlFor="pe-unit">Unit</label>
          <input
            id="pe-unit"
            type="text"
            value={form.unit}
            onChange={set('unit')}
          />
          <p className="hint">e.g. “Nothing — test item”, “per shirt”.</p>
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="pe-strength">Strength label</label>
          <input
            id="pe-strength"
            type="text"
            value={form.strength}
            onChange={set('strength')}
          />
          <p className="hint">Optional display label shown with the product.</p>
        </div>
        <div className="field">
          <label htmlFor="pe-thc">THC %</label>
          <input
            id="pe-thc"
            type="number"
            min="0"
            max="100"
            step="any"
            inputMode="decimal"
            value={form.thc}
            onChange={set('thc')}
          />
          <p className="hint">
            Optional. With no strength label, the shop shows “&lt;THC&gt;% THC”.
          </p>
        </div>
      </div>

      <div className="field">
        <label htmlFor="pe-effects">Effects</label>
        <input
          id="pe-effects"
          type="text"
          value={form.effectsText}
          onChange={set('effectsText')}
        />
        <p className="hint">Comma-separated, e.g. Calm, Focus, Sleepy.</p>
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="pe-tile-0">Tile color 1</label>
          <input
            id="pe-tile-0"
            type="color"
            value={form.tile[0]}
            onChange={(e) =>
              setForm((f) => ({ ...f, tile: [e.target.value, f.tile[1]] }))
            }
          />
        </div>
        <div className="field">
          <label htmlFor="pe-tile-1">Tile color 2</label>
          <input
            id="pe-tile-1"
            type="color"
            value={form.tile[1]}
            onChange={(e) =>
              setForm((f) => ({ ...f, tile: [f.tile[0], e.target.value] }))
            }
          />
        </div>
      </div>
      <p className="hint" style={{ marginTop: -8 }}>
        The card&apos;s background gradient when there is no photo.
      </p>

      <div className="field">
        <label htmlFor="pe-photo">Photo</label>
        {form.image && (
          <img className="editor-thumb" src={form.image} alt="" />
        )}
        <input
          id="pe-photo"
          type="file"
          accept="image/*"
          onChange={(e) =>
            setPhotoFile(e.target.files && e.target.files[0] ? e.target.files[0] : null)
          }
        />
        <p className="hint">
          Optional. JPG, PNG, WebP, GIF or SVG, up to 10 MB.
          {editing ? ' Choosing a file replaces the current photo when you save.' : ''}
        </p>
      </div>

      <div className="field">
        <span className="editor-group-label">Shipping</span>
        <label className="check-line">
          <input
            type="checkbox"
            checked={!form.freeShipping}
            onChange={(e) =>
              setForm((f) => ({ ...f, freeShipping: !e.target.checked }))
            }
          />
          <span>
            <strong>Shipping</strong> — this item ships; the buyer pays USPS
            rates at checkout
          </span>
        </label>
        <p className="hint">
          Checked: the item ships, and its weight and dimensions below feed
          the USPS quote the buyer pays. Unchecked: no shipping — free
          shipping on this item (use it for test items, digital items, or
          anything that ships free). If everything in a cart is no-shipping,
          checkout charges $0 shipping.
        </p>
      </div>

      <div className={form.freeShipping ? 'dims-off' : undefined}>
        <div className="field-row">
          <div className="field">
            <label htmlFor="pe-weight">Weight (oz)</label>
            <input
              id="pe-weight"
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              value={form.weightOz}
              onChange={set('weightOz')}
            />
          </div>
          <div className="field">
            <label htmlFor="pe-length">Length (in)</label>
            <input
              id="pe-length"
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              value={form.lengthIn}
              onChange={set('lengthIn')}
            />
          </div>
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor="pe-width">Width (in)</label>
            <input
              id="pe-width"
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              value={form.widthIn}
              onChange={set('widthIn')}
            />
          </div>
          <div className="field">
            <label htmlFor="pe-height">Height (in)</label>
            <input
              id="pe-height"
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              value={form.heightIn}
              onChange={set('heightIn')}
            />
          </div>
        </div>
        {form.freeShipping && (
          <p className="hint">
            Weight and dimensions only count when Shipping is checked — the
            values are kept, just ignored, while it is unchecked.
          </p>
        )}
      </div>

      <div className="field">
        <span className="editor-group-label">Inventory</span>
        <label className="radio-line">
          <input
            type="radio"
            name="pe-stock"
            checked={form.stockMode === 'untracked'}
            onChange={setFlag('stockMode', 'untracked')}
          />
          <span>
            <strong>Unlimited</strong> (don&apos;t track stock)
          </span>
        </label>
        <label className="radio-line">
          <input
            type="radio"
            name="pe-stock"
            checked={form.stockMode === 'tracked'}
            onChange={setFlag('stockMode', 'tracked')}
          />
          <span>
            <strong>Track stock</strong> — count it down as it sells
          </span>
        </label>
      </div>

      {form.stockMode === 'tracked' && (
        <div className="field-row">
          <div className="field">
            <label htmlFor="pe-stockqty">Stock quantity</label>
            <input
              id="pe-stockqty"
              type="number"
              min="0"
              step="1"
              inputMode="numeric"
              value={form.stockQty}
              onChange={set('stockQty')}
            />
          </div>
          <div className="field">
            <label htmlFor="pe-lowstock">Low-stock warning at</label>
            <input
              id="pe-lowstock"
              type="number"
              min="0"
              step="1"
              inputMode="numeric"
              placeholder="3"
              value={form.lowStockThreshold}
              onChange={set('lowStockThreshold')}
            />
            <p className="hint">Blank uses the shop default of 3.</p>
          </div>
        </div>
      )}

      <div className="editor-actions">
        <button className="btn" type="submit" disabled={saving}>
          {saving ? 'Saving…' : editing ? 'Save changes' : 'Add product'}
        </button>
        <button className="btn-ghost" type="button" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}
