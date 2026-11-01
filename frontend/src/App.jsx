import { BrowserRouter, Routes, Route, Outlet } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext.jsx';
import { CartProvider } from './context/CartContext.jsx';
import Header from './components/Header';
import Footer from './components/Footer';
import Hub from './pages/Hub';
import ShopHome from './pages/ShopHome';
import Products from './pages/Products';
import ProductDetail from './pages/ProductDetail';
import Cart from './pages/Cart';
import Checkout from './pages/Checkout';
import OrderConfirmation from './pages/OrderConfirmation';
import Login from './pages/Login';
import Register from './pages/Register';
import AdminLogin from './pages/AdminLogin';
import AdminDashboard from './pages/AdminDashboard';

// Shop layout — plain pass-through for the /shop routes.
function ShopLayout() {
  return <Outlet />;
}

export default function App() {
  return (
    <AuthProvider>
      <CartProvider>
        <BrowserRouter>
          <Header />
          <Routes>
            <Route path="/" element={<Hub />} />
            <Route path="/shop" element={<ShopLayout />}>
              <Route index element={<ShopHome />} />
              <Route path="products" element={<Products />} />
              <Route path="product/:id" element={<ProductDetail />} />
              <Route path="cart" element={<Cart />} />
              <Route path="checkout" element={<Checkout />} />
              <Route path="order-confirmation" element={<OrderConfirmation />} />
              <Route path="login" element={<Login />} />
              <Route path="register" element={<Register />} />
              {/* Admin — direct URL only, deliberately not linked
                  from the header, footer, or any public page. */}
              <Route path="admin/login" element={<AdminLogin />} />
              <Route path="admin" element={<AdminDashboard />} />
            </Route>
            <Route path="*" element={<Hub />} />
          </Routes>
          <Footer />
        </BrowserRouter>
      </CartProvider>
    </AuthProvider>
  );
}
