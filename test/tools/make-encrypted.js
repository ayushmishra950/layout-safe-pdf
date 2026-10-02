ObjC.import('PDFKit'); ObjC.import('Foundation');
function run(argv){
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  const opts = $.NSMutableDictionary.dictionary;
  opts.setObjectForKey($(argv[2]), $.PDFDocumentUserPasswordOption);
  opts.setObjectForKey($('owner123'), $.PDFDocumentOwnerPasswordOption);
  return doc.writeToURLWithOptions($.NSURL.fileURLWithPath(argv[1]), opts);
}
