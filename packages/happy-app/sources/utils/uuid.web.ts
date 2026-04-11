// Web fallback: crypto.randomUUID() requires a secure context (HTTPS/localhost).
// crypto.getRandomValues() works in all contexts, so we build UUID v4 from it.

export function randomUUID(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    // Set version 4 (0100) and variant 10xx per RFC 4122
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
