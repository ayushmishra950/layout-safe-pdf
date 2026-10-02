// Dev-only reference shaper using macOS CoreText.
// Usage: coretext-shape <PostScriptName> <text>   -> JSON [{gid, x, y, adv}] in font units
import CoreText
import Foundation

let args = CommandLine.arguments
let font = CTFontCreateWithName(args[1] as CFString, 1000, nil)
let upm = Double(CTFontGetUnitsPerEm(font))
let attr = NSAttributedString(string: args[2], attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font])
let line = CTLineCreateWithAttributedString(attr)
var out: [[String: Any]] = []
for run in CTLineGetGlyphRuns(line) as! [CTRun] {
  let n = CTRunGetGlyphCount(run)
  var glyphs = [CGGlyph](repeating: 0, count: n)
  var pos = [CGPoint](repeating: .zero, count: n)
  var adv = [CGSize](repeating: .zero, count: n)
  CTRunGetGlyphs(run, CFRange(location: 0, length: n), &glyphs)
  CTRunGetPositions(run, CFRange(location: 0, length: n), &pos)
  CTRunGetAdvances(run, CFRange(location: 0, length: n), &adv)
  let runFont = (CTRunGetAttributes(run) as NSDictionary)[kCTFontAttributeName as String] as! CTFont
  let ps = CTFontCopyPostScriptName(runFont) as String
  for i in 0..<n {
    out.append(["gid": Int(glyphs[i]), "x": Int((pos[i].x * upm / 1000).rounded()), "y": Int((pos[i].y * upm / 1000).rounded()), "adv": Int((adv[i].width * upm / 1000).rounded()), "font": ps])
  }
}
let data = try! JSONSerialization.data(withJSONObject: out)
print(String(data: data, encoding: .utf8)!)
