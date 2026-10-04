# fallback-font-check

**Stop your text re-wrapping when the webfont loads.**

A small CLI that measures how closely your fallback `@font-face` matches your webfont, using the real text on your real pages, separately for each weight band. It tells you which band is off and prints the `size-adjust` that fixes it.

```
$ npx github:DebugSwiftHQ/fallback-font-check --font Satoshi --fallback "Satoshi Fallback" \
    https://debugswift.com/ https://debugswift.com/services https://debugswift.com/lead-engine \
    https://debugswift.com/about https://debugswift.com/contact

"Satoshi" vs "Satoshi Fallback": 596 strings across 5 page(s)

  weight 300 400    323 strings   mean 1.0024   worst 0.9760   ok
  weight 401 500    166 strings   mean 1.0036   worst 1.0242   ok
  weight 600 900    107 strings   mean 1.0001   worst 1.0489   ok

Every band within 3%. Swapping to the webfont will not re-wrap the text.
```

That's a real run against [debugswift.com](https://debugswift.com), where this tool keeps the fallback honest.

## The problem

Until a webfont loads, the browser draws text in a fallback font. If the fallback is wider or narrower than the webfont, lines break in different places. When the webfont arrives, every paragraph re-wraps and everything below it moves. That movement is **Cumulative Layout Shift**, one of Google's Core Web Vitals.

The fix is a fallback face with `size-adjust` (plus `ascent-override` and friends) tuned so its widths match the webfont. Tools such as `next/font` and Fontaine compute that number for you from the font file's *average* glyph width.

**That average can be badly wrong for your actual copy.** On debugswift.com, the single automatic value ran about 11% wide on 18px body text. Worse, many variable fonts widen their glyphs as the weight goes up while a system fallback like Arial barely changes, so one `size-adjust` can't fit body text and headings at the same time.

The fix that works is one fallback face per weight band, each measured against real text. This tool does the measuring.

## How it works

1. Opens each URL in headless Chromium and waits for fonts to load.
2. Reads your fallback's `@font-face` rules straight from the page's stylesheets, including each one's `font-weight` range and current `size-adjust`. Those ranges become the bands.
3. For every leaf text element (headings, paragraphs, links, list items and so on), renders the same string at the same size, weight and letter-spacing in both fonts, and takes the width ratio.
4. Averages the ratios per band, flags any band whose mean is out of tolerance, and prints `current size-adjust × mean`: the value that would bring it to 1.000.

A ratio above 1 means the webfont is wider than the fallback, so the fallback needs a bigger `size-adjust`.

## Usage

Requires Node 18.3 or later. The first run needs a Chromium build for Playwright:

```bash
npx playwright install chromium
npx github:DebugSwiftHQ/fallback-font-check --font "Your Font" --fallback "Your Font Fallback" https://your-site.com/
```

| Option | Default | |
|---|---|---|
| `--font <family>` | required | The webfont family |
| `--fallback <family>` | required | The fallback family your `@font-face` rules declare |
| `--tolerance <n>` | `0.03` | How far a band's mean may drift, as a fraction |
| `--width <px>` | `412` | Viewport width (phone-sized by default, where re-wraps hurt most) |
| `--min-length <n>` | `15` | Shortest string worth measuring |
| `--json` | off | Machine-readable output |

Give it several pages. Your homepage alone probably doesn't contain every size and weight you use.

**Exit codes:** `0` all bands within tolerance, `1` at least one band out, `2` bad arguments or no fallback face found. Run it in CI against a preview deployment and a font change or a big copy rewrite can't quietly bring layout shift back.

## Your fallback faces should look something like this

These are debugswift.com's real faces. Note how `size-adjust` climbs with the weight, from 98.2% to 104.8%: that's the variable font widening while Arial doesn't.

```css
/* One face per weight band, each tuned separately. Several local() names,
 * because a metric-compatible Arial goes by different names on different systems. */
@font-face {
  font-family: "Satoshi Fallback";
  src: local("Arial"), local("Liberation Sans"), local("Arimo"),
    local("Nimbus Sans"), local("Helvetica Neue"), local("Helvetica");
  font-weight: 300 400;
  ascent-override: 92.36%;
  descent-override: 21.95%;
  line-gap-override: 9.14%;
  size-adjust: 98.2%;
}
@font-face {
  font-family: "Satoshi Fallback";
  src: local("Arial"), local("Liberation Sans"), local("Arimo"),
    local("Nimbus Sans"), local("Helvetica Neue"), local("Helvetica");
  font-weight: 401 500;
  ascent-override: 92.36%;
  descent-override: 21.95%;
  line-gap-override: 9.14%;
  size-adjust: 100.4%;
}
@font-face {
  font-family: "Satoshi Fallback";
  src: local("Arial"), local("Liberation Sans"), local("Arimo"),
    local("Nimbus Sans"), local("Helvetica Neue"), local("Helvetica");
  font-weight: 600 900;
  ascent-override: 92.36%;
  descent-override: 21.95%;
  line-gap-override: 9.14%;
  size-adjust: 104.8%;
}

body { font-family: "Satoshi", "Satoshi Fallback", sans-serif; }
```

## What it can't do

- **It measures the fallback on the machine it runs on.** `local("Arial")` resolves to whatever that machine has. A visitor's device without that font falls through to something else, and no `size-adjust` can help there. If your measurements show you're already matched and you still see layout shift in the field, that's the likely reason. `font-display: block` is the other half of the fix: text is never painted in the fallback, so there's nothing to re-wrap.
- **It measures width only.** Vertical metrics (`ascent-override` and the rest) still need setting from the font file.
- **Chromium only.** Text shaping differs slightly between engines.
- **Only stylesheets the page can read.** Cross-origin stylesheets are skipped, so your fallback faces need to be in a same-origin or inline stylesheet.

## Licence

MIT. Built by [DebugSwift](https://debugswift.com) for our own sites, and shared because the problem isn't ours alone.
