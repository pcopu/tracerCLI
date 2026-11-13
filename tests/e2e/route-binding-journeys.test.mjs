import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const cli = fileURLToPath(new URL('../../bin/tracer.mjs', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tracer-route-bindings-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const put = (path, data) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n'); };
  const read = path => readFileSync(join(root, path), 'utf8');
  const run = (...args) => spawnSync(process.execPath, [cli, '--root', root, ...args], { encoding: 'utf8', timeout: 15000, env: { ...process.env, TRACER_NO_UPDATE: '1', NODE_OPTIONS: '', HOME: root } });
  const ok = (...args) => { const r = run(...args); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  for (const path of ['src/model.mjs', 'tests/a.mjs', 'tests/b.mjs', 'tests/restricted.mjs', 'tests/helper.mjs']) put(path, '// synthetic file\n');
  const scenario = (id, paths) => ({ id, title: id, featureId: 'model', state: paths.length ? 'needs-extension' : 'unwritten', existingPaths: paths, plannedActions: ['Open', 'Save'], expectedOutcomes: ['Model survives'] });
  const draft = { schemaVersion: 1, kind: 'proposed-scenario-association-map', status: 'model-proposed-unreviewed',
    scenarios: [scenario('shared', ['tests/a.mjs', 'tests/b.mjs', 'tests/helper.mjs']), scenario('also', ['tests/a.mjs']), scenario('blocked', ['tests/restricted.mjs']), scenario('unwritten', [])],
    associations: [{ rangeId: 'model-range', featureId: 'model', status: 'model-proposed-unreviewed', source: { path: 'src/model.mjs', start: 1, end: 1 }, scenarioIds: ['shared', 'also'], rationale: 'Preserved model', confidence: 'low', uncertainty: 'Assertions unknown', proposedAssertions: ['Saved model survives'] }] };
  put('draft.json', draft); put('proposal.json', ok('proposal', 'prepare', '--file', 'draft.json'));
  const routes = { version: 1, routes: [
    { id: 'aggregate', paths: ['tests/a.mjs', 'tests/b.mjs'], argv: ['test', 'aggregate', '--label', 'two words', '--repeat', '--repeat'] },
    { id: 'alias', paths: ['tests/b.mjs'], argv: ['test', 'aggregate', '--label', 'two words', '--repeat', '--repeat'] },
    { id: 'restricted', paths: ['tests/restricted.mjs'], argv: ['test', 'restricted'], restriction: 'Requires permitted new route' }
  ] };
  put('routes.json', routes);
  const bind = () => ok('proposal', 'bind', '--file', 'proposal.json', '--routes', 'routes.json', '--json');
  return { root, put, read, run, ok, bind, routes };
}
test('route binding public journey joins exact paths, deduplicates argv, retains restrictions and gaps without execution', t => {
  const p = fixture(t), proposal = p.read('proposal.json'), catalog = p.read('routes.json');
  p.put('tracer.json', { version: 1, app: ['node', 'must-not-execute.mjs'], actions: ['actions'] });
  p.put('must-not-execute.mjs', "import {writeFileSync} from 'node:fs'; writeFileSync('executed', 'BAD');\n");
  const result = p.bind();
  assert.equal(result.kind, 'provisional-plan-route-bindings');
  assert.equal(result.proposalSha256, digest(proposal)); assert.equal(result.routesSha256, digest(catalog));
  assert.equal(result.assertionMatch, 'unknown'); assert.equal(result.status, 'provisional');
  assert.equal(result.bindings.length, 2);
  const selected = result.bindings.find(b => b.selectable);
  assert.deepEqual(selected.routeIds, ['aggregate', 'alias']);
  assert.deepEqual(selected.argv, p.routes.routes[0].argv);
  assert.deepEqual(selected.planIds, ['shared', 'also']);
  assert.deepEqual(selected.matches, [{ planId: 'shared', paths: ['tests/a.mjs', 'tests/b.mjs'] }, { planId: 'also', paths: ['tests/a.mjs'] }]);
  assert.deepEqual(selected.predictedSources.map(r => r.rangeId), ['model-range']);
  assert.equal(selected.predictedSources[0].status, 'provisional');
  const blocked = result.bindings.find(b => !b.selectable);
  assert.deepEqual(blocked.planIds, ['blocked']); assert.deepEqual(blocked.restrictions, ['Requires permitted new route']);
  assert.deepEqual(result.plans.map(p => [p.id, p.status, p.unmatchedPaths]), [
    ['shared', 'candidate', ['tests/helper.mjs']], ['also', 'candidate', []], ['blocked', 'restricted', []], ['unwritten', 'unmatched', []]
  ]);
  assert.equal(p.read('proposal.json'), proposal); assert.equal(p.read('routes.json'), catalog);
  assert.equal(existsSync(join(p.root, 'executed')), false); assert.equal(existsSync(join(p.root, 'docs/testing/code-e2e-links.json')), false);
  assert.deepEqual(p.bind(), result, 'Repeated read-only binding is deterministic');
});
test('route binding public journey rejects ambiguous selectors, unsafe paths, malformed catalogs while retaining stale source warnings', t => {
  const p = fixture(t), original = structuredClone(p.routes), before = p.read('proposal.json');
  const bad = [
    v => v.routes.push({ ...v.routes[0], argv: ['test', 'different'] }),
    v => { v.routes[0].paths = ['../outside.mjs']; },
    v => { v.routes[0].paths = ['tests/missing.mjs']; },
    v => { v.routes[0].argv = 'test'; },
    v => { v.routes[0].argv = []; },
    v => { v.routes[0].argv = ['test', '\u0000bad']; },
    v => { v.routes[0].restriction = ''; },
    v => { v.routes[0].extra = true; },
    v => { v.version = 2; },
    v => { v.routes[0].id = ''; },
    v => { v.routes[0].paths = []; }
  ];
  for (const mutate of bad) {
    const next = structuredClone(original); mutate(next); p.put('routes.json', next);
    const r = p.run('proposal', 'bind', '--file', 'proposal.json', '--routes', 'routes.json');
    assert.notEqual(r.status, 0, JSON.stringify(next)); assert.equal(p.read('proposal.json'), before);
  }
  p.put('routes.json', original);
  symlinkSync(join(p.root, 'tests/a.mjs'), join(p.root, 'tests/link.mjs'));
  p.routes.routes[0].paths = ['tests/link.mjs']; p.put('routes.json', p.routes);
  assert.notEqual(p.run('proposal', 'bind', '--file', 'proposal.json', '--routes', 'routes.json').status, 0);
  p.put('routes.json', original); p.put('src/model.mjs', '// changed source\n');
  const stale = p.run('proposal', 'bind', '--file', 'proposal.json', '--routes', 'routes.json');
  assert.equal(stale.status, 0, stale.stderr);
  const staleResult = JSON.parse(stale.stdout);
  assert.equal(staleResult.bindings.length, 2);
  assert.equal(staleResult.proposalSha256, digest(before));
  assert.equal(staleResult.proposalValidation.valid, false);
  assert.ok(staleResult.proposalValidation.issues.some(issue => issue.includes('Stale')));
  const prediction = staleResult.bindings.find(binding => binding.selectable).predictedSources[0];
  assert.equal(prediction.status, 'stale');
  assert.equal(prediction.scoreEligible, false);
  assert.ok(prediction.issues.some(issue => issue.includes('Stale')));
  const malformed = JSON.parse(before);
  malformed.scenarios.push(malformed.scenarios[0]); p.put('proposal.json', malformed);
  assert.notEqual(p.run('proposal', 'bind', '--file', 'proposal.json', '--routes', 'routes.json').status, 0);
  p.put('proposal.json', before);
  for (const mutate of [
    value => { value.scenarios[0].existingPaths = ['../outside.mjs']; },
    value => { value.associations[0].source.path = '../outside.mjs'; },
    value => { value.associations[0].source.start = 0; }
  ]) {
    const malformed = JSON.parse(before); mutate(malformed); p.put('proposal.json', malformed);
    assert.notEqual(p.run('proposal', 'bind', '--file', 'proposal.json', '--routes', 'routes.json').status, 0);
  }
  p.put('proposal.json', before);
  const invalidSource = JSON.parse(before);
  invalidSource.associations[0].source.end = 999; p.put('proposal.json', invalidSource);
  const invalidResult = p.bind();
  assert.equal(invalidResult.bindings.length, 2);
  const invalidPrediction = invalidResult.bindings[0].predictedSources[0];
  assert.equal(invalidPrediction.status, 'invalid');
  assert.equal(invalidPrediction.scoreEligible, false);
  p.put('proposal.json', before);
  assert.equal(p.read('proposal.json'), before);
});
test('route binding public journey preserves exact argument boundaries, unions duplicate IDs and keeps alias restrictions effective', t => {
  const p = fixture(t);
  p.routes.routes = [
    { id: 'same', paths: ['tests/a.mjs'], argv: ['test', '', '  ', 'a b'] },
    { id: 'same', paths: ['tests/b.mjs'], argv: ['test', '', '  ', 'a b'] },
    { id: 'guarded', paths: ['tests/restricted.mjs'], argv: ['test', '', '  ', 'a b'], restriction: 'Still restricted' },
    { id: 'distinct-boundaries', paths: ['tests/a.mjs'], argv: ['test', '', '  ', 'a', 'b'] },
    { id: 'unmatched-route', paths: ['src/model.mjs'], argv: ['test', 'unused'] }
  ];
  p.put('routes.json', p.routes);
  const bound = p.bind();
  assert.equal(bound.bindings.length, 2);
  assert.deepEqual(bound.bindings[0].routeIds, ['same', 'guarded']);
  assert.deepEqual(bound.bindings[0].argv, ['test', '', '  ', 'a b']);
  assert.equal(bound.bindings[0].selectable, false);
  assert.deepEqual(bound.bindings[0].restrictions, ['Still restricted']);
  assert.deepEqual(bound.bindings[0].planIds, ['shared', 'also', 'blocked']);
  assert.deepEqual(bound.bindings[1].argv, ['test', '', '  ', 'a', 'b']);
  assert.deepEqual(bound.unmatchedRouteIds, ['unmatched-route']);
  p.put('routes.json', { version: 1, routes: [] });
  assert.deepEqual(p.bind().plans.map(plan => plan.status), ['unmatched', 'unmatched', 'unmatched', 'unmatched']);
  assert.notEqual(p.run('proposal', 'bind', '--file', 'proposal.json').status, 0);
  assert.notEqual(p.run('proposal', 'bind', '--file', 'proposal.json', '--routes', 'routes.json', '--routes', 'routes.json').status, 0);
});
test('route binding public journey accepts an external catalog while enforcing catalog and body path boundaries', t => {
  const p = fixture(t);
  const external = realpathSync(mkdtempSync(join(tmpdir(), 'tracer-external-routes-')));
  t.after(() => rmSync(external, { recursive: true, force: true }));
  const catalog = join(external, 'routes.json');
  writeFileSync(catalog, JSON.stringify(p.routes) + '\n');
  const result = p.ok('proposal', 'bind', '--file', 'proposal.json', '--routes', catalog, '--json');
  assert.equal(result.bindings.length, 2);
  assert.equal(result.routesSha256, digest(readFileSync(catalog)));
  assert.equal(existsSync(join(p.root, 'external-routes.json')), false);
  const linked = join(external, 'linked.json'); symlinkSync(catalog, linked);
  assert.notEqual(p.run('proposal', 'bind', '--file', 'proposal.json', '--routes', linked).status, 0);
  const next = structuredClone(p.routes); next.routes[0].paths = [join(p.root, 'tests/a.mjs')];
  writeFileSync(catalog, JSON.stringify(next));
  assert.notEqual(p.run('proposal', 'bind', '--file', 'proposal.json', '--routes', catalog).status, 0);
  next.routes[0].paths = ['../outside.mjs']; writeFileSync(catalog, JSON.stringify(next));
  assert.notEqual(p.run('proposal', 'bind', '--file', 'proposal.json', '--routes', catalog).status, 0);
  writeFileSync(catalog, Buffer.from([0xff]));
  assert.notEqual(p.run('proposal', 'bind', '--file', 'proposal.json', '--routes', catalog).status, 0);
});
