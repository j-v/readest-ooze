/**
 * FoliateTTSHelper - Uses foliate-js TTS module to generate SSML chunks
 * for offline audio download, ensuring exact parity with online TTS highlighting.
 */

import { BookDoc, SectionItem } from '@/libs/document';
import { createRejectFilter } from '@/utils/node';
import { TTSGranularity } from './types';

// copied from foliate-js
const NS = {
  XML: 'http://www.w3.org/XML/1998/namespace',
  SSML: 'http://www.w3.org/2001/10/synthesis',
};

const setLangIfMissing = (el: Element, lang: string) => {
  const langAttr = (el as HTMLElement).lang || el?.getAttributeNS?.(NS.XML, 'lang');
  if (!langAttr) {
    if (el.parentElement) {
      setLangIfMissing(el.parentElement, lang);
    } else {
      el.setAttributeNS(NS.XML, 'lang', lang);
    }
  }
};

/**
 * Result from generating SSML for a section
 */
export interface SSMLChunk {
  ssml: string;
  blockIndex: number;
}

/**
 * Generate all SSML chunks for a section using Foliate's TTS module.
 * This ensures the same segmentation as the live TTS path.
 *
 * @param doc - The Document to process (can be offscreen)
 * @param granularity - 'word' or 'sentence'
 * @returns Array of SSML strings for each block in the document
 */
export async function generateSSMLChunksFromDocument(
  doc: Document,
  granularity: TTSGranularity = 'sentence',
): Promise<SSMLChunk[]> {
  // Dynamic import of foliate-js modules to avoid NodeFilter reference at module load time
  // NodeFilter is only available in browser context
  const { TTS } = await import('foliate-js/tts.js');
  const { textWalker } = await import('foliate-js/text-walker.js');

  // Create the standard node filter (must match TTSController.#initTTSForSection)
  const nodeFilter = createRejectFilter({
    tags: ['rt', 'canvas', 'br'],
    classes: ['annotationLayer'],
    contents: [{ tag: 'a', content: /^[\[\(]?[\*\d]+[\)\]]?$/ }],
  });

  // No-op highlighter since we're doing offline generation
  const noopHighlighter = () => {};

  // Create TTS instance on the offscreen document
  const tts = new TTS(doc, textWalker, nodeFilter, noopHighlighter, granularity);

  const chunks: SSMLChunk[] = [];

  // Get first block's SSML
  let ssml = tts.start();
  let blockIndex = 0;

  while (ssml) {
    chunks.push({ ssml, blockIndex });
    blockIndex++;
    ssml = tts.next();
  }

  return chunks;
}

/**
 * Load a section document from BookDoc for offline processing.
 * Returns an offscreen Document that can be used with Foliate TTS.
 *
 * @param bookDoc - The book document
 * @param href - The section href to load
 * @returns The section's Document or null if not found
 */
export async function loadSectionDocument(
  bookDoc: BookDoc,
  href: string,
): Promise<Document | null> {
  const section = bookDoc.sections?.find((s: SectionItem) => {
    const sectionHref = s.id || '';
    // Match by href inclusion (handles fragment differences)
    return href.includes(sectionHref) || sectionHref.includes(href);
  });

  if (!section) {
    console.warn('[FoliateTTSHelper] Section not found for href:', href);
    return null;
  }

  try {
    const doc = await section.createDocument();
    console.log('[FoliateTTSHelper] Loaded section document:', {
      requestedHref: href,
      matchedSectionId: section.id,
      docTitle: doc.title || doc.querySelector('title')?.textContent || '(no title)',
    });
    const language = bookDoc.metadata.language;
    const bookLang = Array.isArray(language) ? language[0]! : language;
    setLangIfMissing(doc.documentElement, bookLang);
    return doc;
  } catch (error) {
    console.error('[FoliateTTSHelper] Error loading section document:', error);
    return null;
  }
}

/**
 * Generate all SSML chunks for a book section by href.
 * Convenience wrapper that loads the document and generates SSML.
 *
 * @param bookDoc - The book document
 * @param href - The section href
 * @param granularity - 'word' or 'sentence'
 * @returns Array of SSML chunks or empty array on error
 */
export async function generateSSMLChunksForSection(
  bookDoc: BookDoc,
  href: string,
  granularity: TTSGranularity = 'sentence',
): Promise<SSMLChunk[]> {
  const doc = await loadSectionDocument(bookDoc, href);
  if (!doc) {
    return [];
  }

  return generateSSMLChunksFromDocument(doc, granularity);
}
