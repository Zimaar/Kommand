/**
 * Normalizes a phone number to E.164 format (+[country code][number]).
 *
 * Handled input formats:
 *   "+971 50 123 4567"  → "+971501234567"   (spaces in E.164)
 *   "00971501234567"    → "+971501234567"   (00 international prefix)
 *   "0501234567"        → "+971501234567"   (local with defaultCountryCode "971")
 *   "14155552671"       → "+14155552671"    (international digits, no prefix)
 *   "+14155552671"      → "+14155552671"    (already E.164)
 */
export function normalizePhoneNumber(input: string, defaultCountryCode?: string): string {
  let s = input.trim();

  // 00xxxxxxx → +xxxxxxx
  if (s.startsWith('00')) {
    s = '+' + s.slice(2);
  }

  const hasPlus = s.startsWith('+');

  // Strip everything that isn't a digit
  const digits = s.replace(/\D/g, '');

  // Local number: leading 0 + country code provided → strip 0, prepend country code
  if (!hasPlus && digits.startsWith('0') && defaultCountryCode) {
    return '+' + defaultCountryCode + digits.slice(1);
  }

  // Anything else: just ensure the + prefix
  return '+' + digits;
}
