// Dev-only verification with macOS PDFKit (independent PDF engine).
// Usage: osascript -l JavaScript test/tools/pdfkit-check.js file.pdf [password]
ObjC.import('PDFKit');
function run(argv) {
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  if (!doc || doc.isNil()) return 'FAIL: PDFKit could not open ' + argv[0];
  if (doc.isLocked && argv[1]) doc.unlockWithPassword($(argv[1]));
  const n = doc.pageCount;
  const text = ObjC.unwrap(doc.pageAtIndex(0).string) || '';
  return 'OK pages=' + n + ' encrypted=' + doc.isEncrypted + ' page1: ' + text.replace(/\s+/g, ' ').slice(0, 120);
}
