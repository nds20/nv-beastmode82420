// Smoke Shop 824 — shared behavior: cart, pricing rules, age gate.
// Cart lives in localStorage as [{ slug, qty }]. Pricing rules:
//  - price null => "Price TBD": counts in the cart, excluded from totals,
//    and blocks checkout until its price is confirmed.
//  - tax is 10.2% on priced items only.
(function () {
  var CART_KEY = 'ss824_cart';
  window.TAX_RATE = 0.102;

  window.money = function (n) { return '$' + Number(n).toFixed(2); };
  window.priceLabel = function (p) { return p.price == null ? 'Price TBD' : window.money(p.price); };

  window.getCart = function () {
    try {
      var raw = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
      return Array.isArray(raw) ? raw.filter(function (i) { return i && window.getProduct(i.slug); }) : [];
    } catch (e) { return []; }
  };

  window.saveCart = function (cart) {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
    window.renderCartBadge();
  };

  window.cartCount = function () {
    return window.getCart().reduce(function (sum, i) { return sum + i.qty; }, 0);
  };

  window.cartTotals = function () {
    var cart = window.getCart();
    var subtotal = 0, hasTbd = false;
    cart.forEach(function (i) {
      var p = window.getProduct(i.slug);
      if (p.price == null) { hasTbd = true; } else { subtotal += p.price * i.qty; }
    });
    var tax = subtotal * window.TAX_RATE;
    return { subtotal: subtotal, tax: tax, total: subtotal + tax, hasTbd: hasTbd, count: window.cartCount() };
  };

  window.addToCart = function (slug, qty) {
    qty = Math.max(1, Math.min(10, qty || 1));
    var cart = window.getCart();
    var line = cart.find(function (i) { return i.slug === slug; });
    if (line) { line.qty = Math.min(10, line.qty + qty); } else { cart.push({ slug: slug, qty: qty }); }
    window.saveCart(cart);
  };

  window.renderCartBadge = function () {
    var badge = document.querySelector('[data-cart-count]');
    if (!badge) return;
    var n = window.cartCount();
    badge.textContent = n;
    badge.hidden = n === 0;
  };

  // Add-to-cart buttons anywhere: <button data-add-to-cart="slug">
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-add-to-cart]');
    if (!btn) return;
    window.addToCart(btn.getAttribute('data-add-to-cart'), 1);
    var original = btn.textContent;
    btn.textContent = 'Added ✓';
    btn.classList.add('added');
    setTimeout(function () { btn.textContent = original; btn.classList.remove('added'); }, 1200);
  });

  document.addEventListener('DOMContentLoaded', window.renderCartBadge);

  // ---- Age gate (landing page) ----
  document.addEventListener('DOMContentLoaded', function () {
    var overlay = document.getElementById('ageOverlay');
    if (!overlay) return;
    if (sessionStorage.getItem('ss824_age_ok') === '1') { overlay.hidden = true; return; }
    overlay.hidden = false;
    document.body.classList.add('gated');

    var form = document.getElementById('ageForm');
    var error = document.getElementById('ageError');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var zip = document.getElementById('ageZip').value.replace(/\D/g, '');
      var confirmed = document.getElementById('ageConfirm').checked;
      if (zip.length < 5) { error.textContent = 'Please enter a valid ZIP code.'; error.hidden = false; return; }
      if (!confirmed) { error.textContent = 'Please confirm you are 21 or older to enter.'; error.hidden = false; return; }
      sessionStorage.setItem('ss824_age_ok', '1');
      overlay.hidden = true;
      document.body.classList.remove('gated');
    });

    var deny = document.getElementById('ageDeny');
    deny.addEventListener('click', function () {
      document.getElementById('ageCardMain').hidden = true;
      document.getElementById('ageCardDenied').hidden = false;
    });
  });
})();
