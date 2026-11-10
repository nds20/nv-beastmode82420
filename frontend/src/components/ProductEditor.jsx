import { useState } from 'react';
import { saveAdminProduct } from '../services/adminApi';
import { CATEGORY_LABELS, categoryLabel, GENDERS } from '../lib/departments';
import { MAX_PHOTO_BYTES, photoFailureMessage } from '../lib/photoPrep';

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
// Clothing model (2026-11-09, docs/CLOTHING.md): the form is
// clothing-shaped — category carries the kind (type is an optional
// style note), plus Brand, Sizes and Scent for fragrances & body
// care. The retired smoke-shop fields (THC, strength, effects,
// unit) are gone from the form AND from the payload, so editing a
// product never wipes their stored values.
//
// Gender + per-size stock (2026-11-10, owner direction: pick a
// size, pick a gender, enter a quantity for each size — all on ONE
// product):
//   * Gender is a plain select (— None — / Men's / Women's /
//     Unisex / Kids). It is shown ALWAYS, not just for clothing
//     categories: it is one optional field, and showing/hiding it
//     by category would only add surprise. It never interacts with
//     stock mode.
//   * Sizes are ROWS of [size label][quantity][remove] with quick-
//     add chips — NOT the old comma-separated text input. When at
//     least one row is filled in, the product is in PER-SIZE mode:
//     the rows ARE the stock (each size counts down and sells out
//     on its own), the payload sends sizeInventory, and the
//     Unlimited / Track-stock controls below are replaced by a
//     note. With NO rows, the product stays in the legacy mode the
//     radios describe (payload omits sizeInventory entirely).
//   * Editing a LEGACY sized product (sizes but no per-size map):
//     its sizes show as a read-only note ("Current sizes: …") and
//     the rows start EMPTY — switching to per-size stock is the
//     explicit act of filling rows in, never a side effect of an
//     unrelated edit. Removing every row from a per-size product
//     and saving clears it back to legacy mode (the payload sends
//     an explicit empty sizeInventory — see adminApi.js).
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

// The category list + labels come from the ONE shared source
// (lib/departments.js), which mirrors CATEGORIES in
// functions/api/_lib/validate.js — the API rejects anything else.
const CATEGORIES = Object.keys(CATEGORY_LABELS);

// Mirrors DEFAULT_TILE in functions/api/_lib/validate.js.
const DEFAULT_TILE = ['#374151', '#111827'];

const asText = (v) => (v === null || v === undefined ? '' : String(v));

// Quick-add size chips for the size-rows editor (2026-11-10): one
// tap appends a row for that size (skipped when a row for it
// already exists — a duplicate row is a save error, so the chip
// never creates one). "No size" leads (2026-11-10): the sizeless
// row for fragrances, colognes and deodorant — one row, one
// quantity, no clothing sizes.
const QUICK_SIZES = ['No size', 'XS', 'S', 'M', 'L', 'XL', '2XL'];

/** The form's size rows that carry anything at all (size or qty). */
function filledSizeRows(form) {
  return (Array.isArray(form.sizeRows) ? form.sizeRows : [])
    .map((r) => ({ size: String(r.size || '').trim(), qty: String(r.qty ?? '').trim() }))
    .filter((r) => r.size !== '' || r.qty !== '');
}

function initialForm(product) {
  if (!product) {
    return {
      id: null,
      name: '',
      subtitle: '',
      category: CATEGORIES[0],
      type: '',
      price: '',
      brand: '',
      gender: '',
      sizeRows: [],
      hadSizeInventory: false,
      legacySizes: [],
      scent: '',
      // Best Offer (2026-11-10): new listings default to Used with
      // offers on — the shop's disclosure default ("used unless
      // specified as NEW") and the server's computed default agree.
      condition: 'used',
      acceptsOffers: true,
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
    brand: asText(product.brand),
    gender: product.gender || '',
    // Per-size prefill (2026-11-10): a per-size product's rows come
    // from its sizeInventory map. A LEGACY sized product's sizes go
    // to the read-only note instead — the rows start empty so the
    // product keeps its legacy mode until rows are deliberately
    // filled in (see the header comment).
    sizeRows: Array.isArray(product.sizeInventory)
      ? product.sizeInventory.map((e) => ({ size: e.size, qty: String(e.qty) }))
      : [],
    hadSizeInventory:
      Array.isArray(product.sizeInventory) && product.sizeInventory.length > 0,
    legacySizes:
      !Array.isArray(product.sizeInventory) && Array.isArray(product.sizes)
        ? product.sizes
        : [],
    scent: asText(product.scent),
    // Best Offer: an unspecified condition reads as Used (the
    // disclosure default); the offers switch starts from the
    // product's COMPUTED acceptsOffers, so what the admin sees is
    // what buyers get.
    condition: product.condition === 'new' ? 'new' : 'used',
    acceptsOffers: Boolean(product.acceptsOffers),
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

  // Size rows (2026-11-10): the per-size stock editor's state.
  const setSizeRow = (index, field) => (e) =>
    setForm((f) => ({
      ...f,
      sizeRows: f.sizeRows.map((r, i) => (i === index ? { ...r, [field]: e.target.value } : r)),
    }));
  const addSizeRow = (sizeLabel = '') =>
    setForm((f) => {
      if (
        sizeLabel &&
        f.sizeRows.some(
          (r) => String(r.size).trim().toLowerCase() === sizeLabel.toLowerCase()
        )
      ) {
        return f; // chip for a size that already has a row: no duplicate
      }
      return { ...f, sizeRows: [...f.sizeRows, { size: sizeLabel, qty: '' }] };
    });
  const removeSizeRow = (index) =>
    setForm((f) => ({ ...f, sizeRows: f.sizeRows.filter((_, i) => i !== index) }));
  const sizeRowsActive = filledSizeRows(form).length > 0;

  // The product's category could predate the list (it can't today —
  // the API validates — but never silently swap a value on render).
  const categoryOptions = CATEGORIES.includes(form.category)
    ? CATEGORIES
    : [form.category, ...CATEGORIES];

  const save = async (e) => {
    e.preventDefault();
    setError('');
    // Size-row guards (2026-11-10): a half-filled row would either
    // lose a size silently or strand a count with no size — make
    // the admin finish or remove the row instead. A size with an
    // empty quantity gets the explicit message (0 is a legitimate
    // quantity — a sold-out size — but blank is a mistake).
    const rows = filledSizeRows(form);
    for (const row of rows) {
      if (!row.size) {
        setError('Give every size row a size name — or remove the row.');
        return;
      }
      if (row.qty === '') {
        setError('Give every size a quantity — 0 is fine for sold out.');
        return;
      }
      if (!/^\d+$/.test(row.qty)) {
        setError(`The quantity for "${row.size}" must be a whole number.`);
        return;
      }
    }
    const seenSizes = new Set();
    for (const row of rows) {
      const key = row.size.toLowerCase();
      if (seenSizes.has(key)) {
        setError(`Size "${row.size}" is listed twice — give each size one row.`);
        return;
      }
      seenSizes.add(key);
    }
    // The stock guard: "Track stock" with an empty quantity would
    // serialize to null — i.e. silently become Unlimited. Make the
    // admin choose instead. (Skipped in per-size mode: the rows
    // are the stock there, and the Track controls aren't shown.)
    if (rows.length === 0 && form.stockMode === 'tracked' && String(form.stockQty).trim() === '') {
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
      // Error Logs (docs/ERROR_LOGS.md): when the server stamped the
      // failed call with a request id, cite its short form at the end
      // of the message — the failure can be found by it in the admin
      // Error Logs.
      const refSource =
        (err && err.requestId) ||
        (err && err.photoFailure && err.photoFailure.requestId) ||
        '';
      const ref = refSource ? ` (ref: ${String(refSource).slice(0, 8)})` : '';
      if (err && err.savedProduct) {
        // Fields landed; only the photo step failed. Adopt the saved
        // product so the next Save edits it instead of duplicating,
        // and keep the chosen file so that Save retries the photo.
        // The lead sentence says what actually happened to the photo
        // (photoFailureMessage: the server's own words when it sent
        // any; the HEIC / too-large / dropped-connection truth when
        // it didn't) — never a bare "server could not be reached"
        // when a more specific truth exists.
        setForm(initialForm(err.savedProduct));
        if (onPartialSave) onPartialSave(err.savedProduct);
        const lead = err.photoFailure
          ? photoFailureMessage({ ...err.photoFailure, maxBytes: MAX_PHOTO_BYTES })
          : err.message;
        setError(
          `${lead} The product details were saved — fix the photo ` +
            `problem and press Save again to attach the photo.${ref}`
        );
      } else {
        setError(((err && err.message) || 'Could not save the product.') + ref);
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
          <label htmlFor="pe-type">Style / type (optional)</label>
          <input
            id="pe-type"
            type="text"
            value={form.type}
            onChange={set('type')}
          />
          <p className="hint">Optional — e.g. Classic fit, Graphic, Limited run.</p>
        </div>
      </div>

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

      <div className="field-row">
        <div className="field">
          <label htmlFor="pe-brand">Brand</label>
          <input
            id="pe-brand"
            type="text"
            value={form.brand}
            onChange={set('brand')}
          />
          <p className="hint">Optional — e.g. 824.</p>
        </div>
        <div className="field">
          <label htmlFor="pe-gender">Gender</label>
          <select id="pe-gender" value={form.gender} onChange={set('gender')}>
            <option value="">— None —</option>
            {GENDERS.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </select>
          <p className="hint">Optional — whose fit this is.</p>
        </div>
      </div>

      <div className="field">
        <span className="editor-group-label">Sizes &amp; quantity per size</span>
        {form.legacySizes.length > 0 && form.sizeRows.length === 0 && (
          <p className="hint">
            Current sizes: {form.legacySizes.join(', ')} — add quantity rows to
            switch this product to per-size stock.
          </p>
        )}
        {form.sizeRows.map((row, i) => (
          <div className="size-row" key={i}>
            <input
              type="text"
              aria-label="Size"
              placeholder="Size (e.g. M)"
              value={row.size}
              onChange={setSizeRow(i, 'size')}
            />
            <input
              type="number"
              min="0"
              step="1"
              inputMode="numeric"
              aria-label="Quantity for this size"
              placeholder="Qty"
              value={row.qty}
              onChange={setSizeRow(i, 'qty')}
            />
            <button
              className="btn-ghost"
              type="button"
              onClick={() => removeSizeRow(i)}
            >
              Remove
            </button>
          </div>
        ))}
        <div className="size-row-actions">
          <button className="btn-ghost" type="button" onClick={() => addSizeRow()}>
            ＋ Add a size
          </button>
          {QUICK_SIZES.map((s) => (
            <button
              className="size-chip"
              type="button"
              key={s}
              onClick={() => addSizeRow(s)}
            >
              {s}
            </button>
          ))}
        </div>
        <p className="hint">
          One row per size with how many you have — Small ×2, Medium ×2,
          Large ×2, all on this one product. Each size counts down and
          sells out on its own. Leave every row off for a one-size item,
          or to use the single stock count below instead.
          For fragrances, colognes and deodorant, add the No size row with how many you have.
        </p>
      </div>

      <div className="field">
        <label htmlFor="pe-scent">Scent / fragrance notes (optional)</label>
        <input
          id="pe-scent"
          type="text"
          value={form.scent}
          onChange={set('scent')}
        />
        <p className="hint">
          For perfumes, colognes and deodorant — e.g. sandalwood &amp; vanilla.
        </p>
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
        <span className="editor-group-label">Condition &amp; offers</span>
        <div className="field-row">
          <div className="field">
            <label htmlFor="pe-condition">Condition</label>
            <select id="pe-condition" value={form.condition} onChange={set('condition')}>
              <option value="used">Used</option>
              <option value="new">New</option>
            </select>
            <p className="hint">
              The shop disclosure: everything is used unless it is specified as NEW.
            </p>
          </div>
        </div>
        <label className="check-line">
          <input
            type="checkbox"
            checked={form.condition !== 'new' && Boolean(form.acceptsOffers)}
            disabled={form.condition === 'new'}
            onChange={(e) => setForm((f) => ({ ...f, acceptsOffers: e.target.checked }))}
          />
          <span>
            <strong>Accept offers</strong> — buyers can offer below list price; you accept or
            decline in the admin Offers inbox
          </span>
        </label>
        {form.condition === 'new' ? (
          <p className="hint">New items sell at list price — no offers.</p>
        ) : (
          <p className="hint">
            On by default for priced items. Uncheck to sell this one at list price only.
          </p>
        )}
      </div>

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
          Optional. JPG, PNG, WebP, GIF or SVG, up to 10 MB. Phone photos
          are converted and shrunk automatically before upload.
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

      {sizeRowsActive ? (
        <div className="field">
          <span className="editor-group-label">Inventory</span>
          <p className="hint">
            Stock is counted <strong>per size</strong> — the size rows above
            ARE the stock (
            {filledSizeRows(form).reduce((sum, r) => sum + (Number(r.qty) || 0), 0)}{' '}
            total). The single-count controls come back when every size row
            is removed.
          </p>
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
            <p className="hint">Per size. Blank uses the shop default of 3.</p>
          </div>
        </div>
      ) : (
        <>
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
        </>
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
