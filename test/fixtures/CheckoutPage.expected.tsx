// ═══════════════════════════════════════════════════════════════════════
// EXPECTED OUTPUT after phantom lazy transform
//
// Changes from original:
// 1. PaymentForm, AddressForm → React.lazy() with .then() for named exports
// 2. PromoCode, OrderHistory → React.lazy()
// 3. PaymentForm + AddressForm wrapped in shared <Suspense> (adjacent siblings)
// 4. PromoCode wrapped in its own <Suspense>
// 5. OrderHistory wrapped in its own <Suspense>
// 6. lazy + Suspense added to react import
// 7. CartProvider, CartItems, OrderSummary → unchanged (kept static)
// ═══════════════════════════════════════════════════════════════════════

import React, { useState, useCallback, lazy, Suspense } from 'react';
import { CartProvider } from './CartProvider';
import { CartItems } from './CartItems';
import { OrderSummary } from './OrderSummary';

// Named exports require .then() wrapper for React.lazy
const PaymentForm = lazy(() => import('./PaymentForm').then(m => ({ default: m.PaymentForm })));
const AddressForm = lazy(() => import('./AddressForm').then(m => ({ default: m.AddressForm })));
const PromoCode = lazy(() => import('./PromoCode').then(m => ({ default: m.PromoCode })));
const OrderHistory = lazy(() => import('./OrderHistory').then(m => ({ default: m.OrderHistory })));

export default function CheckoutPage({ order, user }) {
  const [showPromo, setShowPromo] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const handleTogglePromo = useCallback(() => {
    setShowPromo((prev) => !prev);
  }, []);

  return (
    <CartProvider cartId={order.cartId}>
      <div className="checkout-layout">
        {/* Kept static — above fold, interactive */}
        <CartItems items={order.items} />

        {/* Kept static — display only, low JS cost */}
        <OrderSummary totals={order.totals} />

        {/* Adjacent lazy components share one Suspense boundary */}
        <Suspense fallback={null}>
          <PaymentForm userId={user.id} />
          <AddressForm userId={user.id} defaultAddress={user.address} />
        </Suspense>

        {/* Conditionally rendered — own Suspense boundary */}
        {showPromo && (
          <Suspense fallback={null}>
            <PromoCode cartId={order.cartId} />
          </Suspense>
        )}

        <button onClick={handleTogglePromo}>Have a promo code?</button>

        {/* Low priority — own Suspense boundary */}
        {showHistory && (
          <Suspense fallback={null}>
            <OrderHistory userId={user.id} />
          </Suspense>
        )}
      </div>
    </CartProvider>
  );
}
