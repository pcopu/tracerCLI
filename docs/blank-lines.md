# Blank lines in manual reports

Tracer 0.2.0 excludes whitespace-only physical source lines from manual totals and minimum thresholds. Unmarked comments remain counted. Agents can [declare comment-only ranges](comments.md) explicitly; there is no comment parser.

For each physical line, the rule is `line.trim() === ''`. Spaces, tabs, line endings and the whitespace characters recognized by JavaScript `trim` are blank. A BOM-only line is blank; a BOM followed by text is not. This is deliberately language-neutral: a whitespace-only physical line inside a multiline literal is also excluded, while comment markers and any other non-whitespace text remain counted. Nonblank does not mean executable.

## Coordinates and hashes stay physical

Tracer never strips or rewrites source files. Version-1 maps and exact UTF-8/BOM/CRLF snippet hashes remain unchanged. Original line numbers are preserved. Blank-only ranges can still be linked and queried; editing their whitespace still makes their hashes stale.

`traceCounts` and `links` retain physical navigation, including blank lines. Existing `lines`, `linked`, `withStep`, `unlinked`, `belowMinimum` and their corresponding range lists count only nonblank lines outside current comment declarations. Ranges do not merge across excluded blank gaps. A blank-only selection therefore has zero counted lines but can still expose a current link and physical trace counts.

JSON reports identify `lineBasis: "nonblank-undeclared-comment-lines"`. Each file and the totals add `physicalLines` and `blankLines`; each file also exposes `blankRanges` as inclusive `[start, end]` pairs. With declared comments, the invariant is `lines + blankLines + commentLines === physicalLines`. These counts describe the requested subset in a filtered report. Empty files have zero physical and counted lines.

`check --require-minimum` applies the same nonblank, undeclared-comment basis to the full inventory and includes `lineBasis`, `physicalLines` and `blankLines`. Ordinary `check` remains a link-integrity check. An all-blank source contributes no minimum deficit; that is not a claim of 100% execution coverage.

## Compatibility and measured evidence

This intentionally changes report/threshold counting from 0.1.x, which counted every physical line. It does not change sidecar version 1, stored source ranges, ordered actions, witness hashes, stale detection or the shared installation model. Updating the shared CLI updates the behavior used by every project that invokes it; no per-project pin is introduced.

Measured LCOV intervals remain independent. Their denominator is the matched instrumented `DA` records supplied by the exporter, even when an exporter associates a counter with a blank-looking line. Tracer does not drop or reclassify captured counters, change interval identities or manufacture execution evidence from manual links.
