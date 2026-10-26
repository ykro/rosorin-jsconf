const NON_LATIN_SCRIPT_REGEX =
  /[Ͱ-ϿЀ-ӿԀ-ԯ԰-֏֐-׿؀-ۿ܀-ݏݐ-ݿऀ-෿฀-๿က-႟ᄀ-ᇿ　-鿿가-힯]/;

/**
 * Filters out hallucinated non-Latin scripts (Hebrew, Arabic, Cyrillic, CJK, Thai, etc.)
 * that Gemini Live's multilingual ASR can emit on low-SNR room noise.
 */
export function sanitizeTranscriptChunk(raw: string): string {
  if (NON_LATIN_SCRIPT_REGEX.test(raw)) return '';
  return raw.replace(/[^ -~ -ɏ‐-‧¿¡]/g, '');
}
