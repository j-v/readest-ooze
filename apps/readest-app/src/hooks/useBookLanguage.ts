import { useReaderStore } from '@/store/readerStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { isValidLang, code6392to6391, normalizeToFullLang } from '@/utils/lang';
import { useMemo } from 'react';

/**
 * Hook to get the best available language code for a book.
 *
 * Strategy:
 * 1. Try to get the language from the current View's raw metadata (ReaderStore).
 * 2. Validate and normalize it to a 2-char ISO code.
 * 3. If invalid, fallback to the store's Book object (BookDataStore), which is usually pre-normalized.
 * 4. Fallback to 'en'.
 */
export const useBookLanguage = (bookKey: string): string => {
  const { getView } = useReaderStore();
  const { getBookData } = useBookDataStore();

  return useMemo(() => {
    const view = getView(bookKey);
    const bookData = getBookData(bookKey);

    // 1. Try View Metadata (Raw)
    const rawLang = view?.book?.metadata?.language;
    const candidateLang = Array.isArray(rawLang) ? rawLang[0] : rawLang;

    if (candidateLang && isValidLang(candidateLang)) {
      const normalized = normalizeToFullLang(candidateLang);
      // Convert 3-char codes (bibliographic) to 2-char if possible
      if (normalized.length === 3) {
        const twoChar = code6392to6391(normalized);
        if (twoChar) return twoChar;
      } else {
        return normalized;
      }
    }

    // 2. Fallback to BookDataStore (Normalized)
    if (bookData?.book?.primaryLanguage) {
      return bookData.book.primaryLanguage;
    }

    // 3. Fallback to default
    return 'en';
  }, [bookKey, getView, getBookData]);
};
