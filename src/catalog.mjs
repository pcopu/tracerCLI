import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const CATALOG = 'docs/testing/code-feature-catalog.json';
const hash = text => createHash('sha256').update(text).digest('hex');
const sha = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const percentage = (numerator, denominator) => denominator ? numerator * 100 / denominator : null;

// This is a read-only interpretation of proposed classifications, never a link import.
export function progress(root, state, files, totals) {
  const result = { lineBasis: 'nonblank-undeclared-comment-lines', denominator: totals.lines,
    mapping: { manual: { lines: totals.linked, percent: percentage(totals.linked, totals.lines) },
      withTestWitness: { lines: totals.withStep, percent: percentage(totals.withStep, totals.lines) } },
    categorization: { catalog: CATALOG, status: 'missing', lines: 0, percent: null, issues: [] },
    notice: 'Categorization is model-proposed; manual and witnessed links are navigation, not measured execution or proof of test success.' };
  const out = result.categorization, path = resolve(root, CATALOG);
  if (!existsSync(path)) return result;
  let catalog;
  try {
    let part = root;
    for (const component of CATALOG.split('/')) {
      part = resolve(part, component);
      if (lstatSync(part).isSymbolicLink() || realpathSync(part) !== part) throw Error('Catalog path is not unsymlinked.');
    }
    catalog = JSON.parse(readFileSync(path, 'utf8'));
    if (catalog?.schemaVersion !== 1 || catalog.kind !== 'feature-classification-catalog'
      || catalog.inventory?.schemaVersion !== 1 || catalog.inventory.kind !== 'feature-source-inventory'
      || typeof catalog.inventory.scope !== 'string' || !catalog.inventory.scope.trim()
      || catalog.inventory.lineBasis !== 'nonblank-undeclared-comment-lines' || !Array.isArray(catalog.inventory.files)
      || !sha(catalog.inventory.manifestSha256) || !sha(catalog.inventory.reportSha256)
      || catalog.taxonomy?.schemaVersion !== 1 || !Array.isArray(catalog.taxonomy.features)
      || !Array.isArray(catalog.proposals) || !Array.isArray(catalog.ranges)) throw Error('Unsupported or malformed catalog.');
    const features = new Set(), proposals = new Set();
    for (const f of catalog.taxonomy.features) {
      if (!f || typeof f.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(f.id) || typeof f.title !== 'string' || !f.title.trim() || features.has(f.id)) throw Error('Invalid or duplicate feature.');
      features.add(f.id);
    }
    for (const p of catalog.proposals) {
      if (!p || typeof p.assignmentId !== 'string' || !p.assignmentId.trim() || proposals.has(p.assignmentId)
        || typeof p.model !== 'string' || !p.model.trim() || !sha(p.sha256)) throw Error('Invalid or duplicate proposal.');
      proposals.add(p.assignmentId);
    }
    const inventory = new Map(), duplicates = new Set();
    for (const f of catalog.inventory.files) {
      if (!f || typeof f.path !== 'string' || !f.path || f.path.startsWith('/') || f.path.includes('\\') || f.path.split('/').some(p => !p || p === '.' || p === '..')) { out.issues.push('Invalid inventory path.'); continue; }
      if (inventory.has(f.path)) { duplicates.add(f.path); out.issues.push(`Duplicate inventory file: ${f.path}`); }
      inventory.set(f.path, f);
    }
    // Inventory integrity is reported even when no proposal references an entry.
    for (const [path, f] of inventory) {
      const source = state.files.get(path);
      if (!source) { out.issues.push(`Inventory source is outside current inventory: ${path}`); continue; }
      if (!sha(f.sha256) || !Number.isSafeInteger(f.physicalLines) || f.physicalLines < 0
          || !Number.isSafeInteger(f.includedLines) || !Array.isArray(f.blankRanges) || !Array.isArray(f.commentRanges)) {
        out.issues.push(`Malformed inventory: ${path}`); continue;
      }
      if (source.length !== f.physicalLines || hash(source.join('')) !== f.sha256) out.issues.push(`Stale inventory source: ${path}`);
      const excluded = new Set(); let valid = true;
      for (const range of [...f.blankRanges, ...f.commentRanges]) {
        if (!Array.isArray(range) || range.length !== 2 || !Number.isSafeInteger(range[0]) || !Number.isSafeInteger(range[1]) || range[0] < 1 || range[0] > range[1] || range[1] > f.physicalLines) { valid = false; break; }
        for (let n = range[0]; n <= range[1]; n++) excluded.add(n);
      }
      if (!valid || f.physicalLines - excluded.size !== f.includedLines) out.issues.push(`Malformed inventory exclusions: ${path}`);
    }
    const currentFiles = new Map(files.map(f => [f.path, f])), candidates = [], occupied = new Map();
    for (const [index, row] of catalog.ranges.entries()) {
      const problem = message => out.issues.push(`Range ${index + 1}: ${message}`);
      if (!row || typeof row.path !== 'string') { problem('Malformed range.'); continue; }
      const source = state.files.get(row.path), f = inventory.get(row.path);
      if (!source || !f || duplicates.has(row.path)) { problem(`Missing, duplicate or out-of-scope source: ${row.path}`); continue; }
      if (!sha(f.sha256) || !Number.isSafeInteger(f.physicalLines) || f.physicalLines < 0
          || !Array.isArray(f.blankRanges) || !Array.isArray(f.commentRanges) || !Number.isSafeInteger(f.includedLines)) { problem(`Malformed inventory: ${row.path}`); continue; }
      if (f.physicalLines !== source.length) { problem(`Stale source length: ${row.path}`); continue; }
      const excluded = new Set(); let badExclusion = false;
      for (const range of [...f.blankRanges, ...f.commentRanges]) {
        if (!Array.isArray(range) || range.length !== 2 || !Number.isSafeInteger(range[0]) || !Number.isSafeInteger(range[1]) || range[0] < 1 || range[0] > range[1] || range[1] > source.length) { badExclusion = true; break; }
        for (let n = range[0]; n <= range[1]; n++) excluded.add(n);
      }
      if (badExclusion || source.length - excluded.size !== f.includedLines) { problem(`Malformed inventory exclusions: ${row.path}`); continue; }
      if (!Number.isSafeInteger(row.start) || !Number.isSafeInteger(row.end) || row.start < 1 || row.end < row.start || row.end > source.length
          || !features.has(row.featureId) || !['low', 'medium', 'high'].includes(row.confidence) || typeof row.rationale !== 'string' || !row.rationale.trim()
          || row.status !== 'model-proposed' || !proposals.has(row.assignmentId) || !sha(row.fileSha256) || !sha(row.spanSha256)) { problem(`Malformed classification: ${row.path}`); continue; }
      const exact = source.join(''), catalogLines = exact.split('\n'); if (catalogLines.at(-1) === '') catalogLines.pop();
      if (hash(exact) !== f.sha256 || row.fileSha256 !== f.sha256 || hash(catalogLines.slice(row.start - 1, row.end).join('\n')) !== row.spanSha256) { problem(`Stale source or span: ${row.path}:${row.start}-${row.end}`); continue; }
      const candidate = { row, index, overlap: false }; candidates.push(candidate);
      let entries = occupied.get(row.path); if (!entries) { entries = []; occupied.set(row.path, entries); }
      for (const prior of entries) if (prior.row.end >= row.start && row.end >= prior.row.start) { prior.overlap = candidate.overlap = true; }
      entries.push(candidate);
    }
    const classified = new Map();
    for (const candidate of candidates) {
      const { row, index, overlap } = candidate;
      if (overlap) { out.issues.push(`Range ${index + 1}: overlapping classification: ${row.path}:${row.start}-${row.end}`); continue; }
      const file = currentFiles.get(row.path); if (!file) continue;
      let set = classified.get(row.path); if (!set) { set = new Set(); classified.set(row.path, set); }
      const lines = state.files.get(row.path);
      for (let n = Math.max(row.start, file.start); n <= Math.min(row.end, file.end); n++) {
        if (lines[n - 1].trim() && !file.commentRanges.some(([a,b]) => n >= a && n <= b)) set.add(n);
      }
    }
    out.lines = [...classified.values()].reduce((sum, set) => sum + set.size, 0);
    out.percent = percentage(out.lines, totals.lines);
    out.status = out.issues.length ? 'issues' : 'available';
  } catch (error) { out.status = 'invalid'; out.issues.push(error.message); }
  return result;
}
