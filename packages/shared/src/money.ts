const kes = new Intl.NumberFormat("en-KE", {
  style: "currency",
  currency: "KES",
  maximumFractionDigits: 0,
});

/** Formats whole shillings for display, e.g. 1500 -> "Ksh 1,500". */
export const formatKes = (amount: number): string => kes.format(amount);
