/**
 * Normalises a Kenyan mobile number to the MSISDN format M-Pesa expects:
 * 2547XXXXXXXX or 2541XXXXXXXX. Accepts the common ways people type it
 * (0712 345 678, +254712345678, 254-712-345-678, 712345678).
 * Returns null when the input isn't a Kenyan mobile number.
 */
export const normalizeKenyanPhone = (input: string): string | null => {
  const digits = input.replace(/[\s\-().]/g, "").replace(/^\+/, "");
  if (!/^\d+$/.test(digits)) return null;

  const local = digits.startsWith("254")
    ? digits.slice(3)
    : digits.startsWith("0")
      ? digits.slice(1)
      : digits;

  return /^[17]\d{8}$/.test(local) ? `254${local}` : null;
};
