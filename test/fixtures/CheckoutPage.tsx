// ═══════════════════════════════════════════════════════════════════════
// Test fixture: CheckoutPage.tsx
//
// Expected lazy detection results:
//
//   LAZY:
//     PaymentForm   → viewport (position 2, below fold, has handlers+effects)
//     AddressForm   → viewport (position 3, below fold, has handlers)
//       ↳ same suspense_group as PaymentForm (adjacent siblings)
//     PromoCode     → interaction (conditionally rendered)
//     OrderHistory  → idle (position 5, below fold, low priority)
//
//   KEEP STATIC:
//     CartItems     → first child in route component, above fold
//     OrderSummary  → no handlers/state (pure display, low JS cost)
//     CartProvider  → context provider, must hydrate before consumers
//
// ═══════════════════════════════════════════════════════════════════════

import React, { useState, useCallback } from 'react';
import { CartProvider } from './CartProvider';      // wraps children → provider
import { CartItems } from './CartItems';            // position 0, interactive
import { OrderSummary } from './OrderSummary';      // position 1, display only
import { PaymentForm } from './PaymentForm';        // position 2, heavy interactive
import { AddressForm } from './AddressForm';        // position 3, interactive
import { PromoCode } from './PromoCode';            // conditional, rarely used
import { OrderHistory } from './OrderHistory';      // position 5, optional section

export default function CheckoutPage({ order, user }) {
  const [showPromo, setShowPromo] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const handleTogglePromo = useCallback(() => {
    setShowPromo((prev) => !prev);
  }, []);

  return (
    <CartProvider cartId={order.cartId}>
      <div className="checkout-layout">
        <CartItems items={order.items} />
        <OrderSummary totals={order.totals} />
        <PaymentForm userId={user.id} />
        <AddressForm userId={user.id} defaultAddress={user.address} />
        {showPromo && <PromoCode cartId={order.cartId} />}
        <button onClick={handleTogglePromo}>Have a promo code?</button>
        {showHistory && <OrderHistory userId={user.id} />}
      </div>
    </CartProvider>
  );
}
