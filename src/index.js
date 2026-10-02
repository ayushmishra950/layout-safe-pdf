// Public API.

export { PDFDocument } from './core/document.js';
export { PDFPage } from './core/page.js';
export {
  PDFName, PDFRef, PDFDict, PDFStream, PDFString, PDFNumber, N,
} from './core/objects.js';
export { PDFPasswordError } from './core/crypt.js';
export { UnsupportedFilterError } from './core/filters.js';
export { limits, setLimits, PDFLimitError } from './core/limits.js';
export { PDFSyntaxError } from './core/parser.js';
export { parseOperations, rebuildContent } from './content/operations.js';
export { ContentInterpreter } from './content/interpreter.js';
export { PDFFont, loadFont } from './fonts/font.js';
export { TextEditor } from './text/editor.js';
export { extractText, extractLines } from './text/extract.js';
