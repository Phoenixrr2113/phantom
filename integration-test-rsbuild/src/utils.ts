/**
 * Format a number as a currency string.
 * This is a pure helper — should NOT be extracted by Phantom.
 * When used inside an extracted event handler, this import should be
 * rewritten to an absolute path in the chunk module.
 */
export function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}
