#!/usr/bin/env node
/* fallback-font-check
 *
 * Measures how closely a fallback @font-face matches your webfont's real widths,
 * on your real pages, per weight band, and prints the size-adjust that would
 * close the gap.
 *
 * Why: when a fallback font is wider or narrower than the webfont, paragraphs
 * break lines in different places. The moment the webfont arrives the text
 * re-wraps and everything below it moves (Cumulative Layout Shift). A single
 * size-adjust derived from a font file's average glyph width can be far off for
 * real copy, and wrong in a different direction at each weight. */

import { parseArgs } from "node:util";
import { chromium } from "playwright";

const HELP = `
Usage: fallback-font-check --font <family> --fallback <family> <url> [url...]

Measures every text element on each page twice, once in the webfont and once in
the fallback, and reports the width ratio per weight band. The bands come from
the font-weight ranges on your fallback's @font-face rules.

Options
  --font <family>       The webfont family, e.g. "Satoshi"            (required)
  --fallback <family>   The fallback family, e.g. "Satoshi Fallback"  (required)
  --tolerance <n>       Allowed drift of a band's mean, as a fraction (default 0.03)
  --width <px>          Viewport width                                (default 412)
  --min-length <n>      Shortest string worth measuring, in chars     (default 15)
  --json                Print the result as JSON
  -h, --help            Show this help

Exit code 1 when any band is out of tolerance, so it can run in CI.
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    font: { type: "string" },
    fallback: { type: "string" },
    tolerance: { type: "string", default: "0.03" },
    width: { type: "string", default: "412" },
    "min-length": { type: "string", default: "15" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help || !values.font || !values.fallback || !positionals.length) {
  console.log(HELP);
  process.exit(values.help ? 0 : 2);
}

const FONT = values.font;
const FALLBACK = values.fallback;
const TOLERANCE = Number(values.tolerance);
const WIDTH = Number(values.width);
const MIN_LENGTH = Number(values["min-length"]);

/* "normal" is 400 and "bold" is 700 in CSS. A single weight is a band of one. */
function parseWeight(raw) {
  const words = { normal: 400, bold: 700 };
  const parts = String(raw || "normal").trim().split(/\s+/).map((w) => words[w] ?? Number(w));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return { lo: parts[0], hi: parts[1] ?? parts[0] };
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: WIDTH, height: 900 } });

const samples = [];
let faces = [];
const warnings = [];

for (const url of positionals) {
  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  await page.evaluate(() => document.fonts.ready);

  const result = await page.evaluate(
    ({ font, fallback, minLength }) => {
      /* The fallback faces as shipped, read from the CSSOM so the "from" value in
       * the report is the one actually in production, never a stale copy. */
      const found = [];
      for (const sheet of document.styleSheets) {
        let rules;
        try {
          rules = sheet.cssRules;
        } catch {
          continue; /* a cross-origin stylesheet can't be read */
        }
        for (const rule of rules) {
          if (!(rule instanceof CSSFontFaceRule)) continue;
          const family = (rule.style.getPropertyValue("font-family") || "").replace(/["']/g, "").trim();
          if (family.toLowerCase() !== fallback.toLowerCase()) continue;
          found.push({
            weight: rule.style.getPropertyValue("font-weight").trim() || "normal",
            sizeAdjust: parseFloat(rule.style.getPropertyValue("size-adjust")) || 100,
          });
        }
      }

      const loaded = document.fonts.check(`16px "${font}"`);

      const probe = document.createElement("span");
      probe.style.cssText =
        "position:absolute;visibility:hidden;white-space:nowrap;left:-9999px;top:-9999px;";
      document.body.appendChild(probe);

      const out = [];
      const seen = new Set();
      for (const el of document.querySelectorAll("h1,h2,h3,h4,h5,h6,p,a,li,span,td,th,label,button,figcaption,blockquote,dt,dd")) {
        const text = (el.textContent || "").trim();
        /* Leaf elements only, long enough for a width to mean something, each once. */
        if (text.length < minLength || el.querySelector("*") || seen.has(text)) continue;
        seen.add(text);

        const cs = getComputedStyle(el);
        probe.textContent = text.slice(0, 300);
        probe.style.fontSize = cs.fontSize;
        probe.style.fontWeight = cs.fontWeight;
        probe.style.fontStyle = cs.fontStyle;
        probe.style.letterSpacing = cs.letterSpacing;

        probe.style.fontFamily = `"${font}"`;
        const real = probe.getBoundingClientRect().width;
        probe.style.fontFamily = `"${fallback}"`;
        const fake = probe.getBoundingClientRect().width;
        if (real > 0 && fake > 0) out.push({ weight: Number(cs.fontWeight), ratio: real / fake });
      }
      probe.remove();
      return { found, loaded, out };
    },
    { font: FONT, fallback: FALLBACK, minLength: MIN_LENGTH },
  );

  if (!result.loaded) warnings.push(`${url}: "${FONT}" never loaded, so every ratio here compares the fallback with itself.`);
  if (!faces.length) faces = result.found;
  samples.push(...result.out);
}
await browser.close();

if (!faces.length) {
  console.error(`\nNo @font-face rule for "${FALLBACK}" was found in any same-origin stylesheet.\n`);
  process.exit(2);
}

const bands = faces
  .map((f) => ({ ...f, range: parseWeight(f.weight) }))
  .filter((f) => f.range)
  .sort((a, b) => a.range.lo - b.range.lo);

const report = bands.map((face) => {
  const hits = samples.filter((s) => s.weight >= face.range.lo && s.weight <= face.range.hi);
  if (!hits.length) return { weight: face.weight, strings: 0 };
  const mean = hits.reduce((a, s) => a + s.ratio, 0) / hits.length;
  const worst = hits.reduce((w, s) => (Math.abs(1 - s.ratio) > Math.abs(1 - w) ? s.ratio : w), 1);
  return {
    weight: face.weight,
    strings: hits.length,
    mean: Number(mean.toFixed(4)),
    worst: Number(worst.toFixed(4)),
    ok: Math.abs(1 - mean) <= TOLERANCE,
    sizeAdjust: face.sizeAdjust,
    suggested: Number((face.sizeAdjust * mean).toFixed(1)),
  };
});

const failed = report.filter((r) => r.strings && !r.ok).length;
const unmeasured = samples.filter((s) => !bands.some((b) => s.weight >= b.range.lo && s.weight <= b.range.hi)).length;

if (values.json) {
  console.log(JSON.stringify({ font: FONT, fallback: FALLBACK, tolerance: TOLERANCE, pages: positionals, bands: report, unmeasured, warnings }, null, 2));
} else {
  console.log(`\n"${FONT}" vs "${FALLBACK}": ${samples.length} strings across ${positionals.length} page(s)\n`);
  for (const r of report) {
    const label = `weight ${r.weight}`.padEnd(16);
    if (!r.strings) {
      console.log(`  ${label} no text rendered at these weights`);
      continue;
    }
    const verdict = r.ok
      ? "ok"
      : `OUT BY ${(Math.abs(1 - r.mean) * 100).toFixed(1)}%  ->  size-adjust: ${r.suggested}%  (now ${r.sizeAdjust}%)`;
    console.log(`  ${label} ${String(r.strings).padStart(4)} strings   mean ${r.mean.toFixed(4)}   worst ${r.worst.toFixed(4)}   ${verdict}`);
  }
  if (unmeasured) console.log(`\n  ${unmeasured} string(s) were rendered at a weight no fallback face covers.`);
  for (const w of warnings) console.log(`\n  Warning: ${w}`);
  console.log(
    failed
      ? `\n${failed} band(s) out of tolerance. Paste the suggested size-adjust into the matching @font-face.\n`
      : `\nEvery band within ${(TOLERANCE * 100).toFixed(0)}%. Swapping to the webfont will not re-wrap the text.\n`,
  );
}

process.exit(failed ? 1 : 0);
