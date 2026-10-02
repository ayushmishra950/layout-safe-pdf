// Dev-only: render page 1 of a PDF to PNG with macOS PDFKit.
// Usage: osascript -l JavaScript test/tools/render.js in.pdf out.png [scale] [x,y,w,h crop in pt from top-left] [password]
ObjC.import('PDFKit'); ObjC.import('AppKit');
function run(argv) {
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  if (argv[4]) doc.unlockWithPassword($(argv[4]));
  const page = doc.pageAtIndex(0);
  const box = page.boundsForBox($.kPDFDisplayBoxMediaBox);
  const s = Number(argv[2] || 1.5);
  const W = box.size.width, H = box.size.height;
  const [cx, cy, cw, ch] = argv[3] ? argv[3].split(',').map(Number) : [0, 0, W, H];
  const img = $.NSImage.alloc.initWithSize($.NSMakeSize(cw * s, ch * s));
  img.lockFocus;
  $.NSColor.whiteColor.set;
  $.NSRectFill($.NSMakeRect(0, 0, cw * s, ch * s));
  const ctx = $.NSGraphicsContext.currentContext.CGContext;
  $.CGContextScaleCTM(ctx, s, s);
  $.CGContextTranslateCTM(ctx, -cx, -(H - cy - ch));
  page.drawWithBoxToContext($.kPDFDisplayBoxMediaBox, ctx);
  img.unlockFocus;
  const rep = $.NSBitmapImageRep.imageRepWithData(img.TIFFRepresentation);
  rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({})).writeToFileAtomically(argv[1], true);
  return 'ok';
}
