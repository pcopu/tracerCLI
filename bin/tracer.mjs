#!/usr/bin/env node
import { Tracer, VERSION, NOTICE, location, validateMinimum } from '../src/tracer.mjs';
import { initialize, runApp } from '../src/project.mjs';
import { bindProposalRoutes } from '../src/route-bindings.mjs';
import { setupAgent } from '../src/agent-setup.mjs';
import { checkForUpdate, updateCLI, configureUpdates, updateStatus, rollbackUpdate, maybeAutoUpdate, refreshRegisteredSkills } from '../src/update.mjs';
import { importMeasured, reportMeasured, checkMeasured, unionMeasured } from '../src/measured.mjs';
import { prepareScenarios, checkScenarios, reportScenarios, scenarioPacket, linkScenarios } from '../src/scenarios.mjs';
import { proposalCommand, DEFAULT_PROPOSAL } from '../src/proposals.mjs';
import { auditQueue } from '../src/audit-queue.mjs';
let selectedCommand;

const help = `Tracer ${VERSION} — source ↔ ordered CLI actions ↔ test steps

Usage: tracer [--root REPOSITORY] [--map PATH] [--include-ext .zig] COMMAND

  init [--app-json '["node","cli/app.mjs"]'] [--actions-json '["actions","--json"]']
       [--minimum-traces N] [--agent codex|claude] [--install-skill] [--add-instruction]
  actions                 Run configured discovery, or the app’s --help
  app -- ARGS...          Explicitly run the configured app with exact arguments
  link SOURCE:START-END --action TEXT [--action TEXT ...]
       [--step TEST:START-END] --why TEXT
  dead-code PATH:START-END --why TEXT --evidence TEXT
  undead-code ID
  report [--source PATH[:RANGE] | --action TEXT | --step PATH[:RANGE]
          | --sequence '["first action","next action"]'] [--minimum-traces N] [--json]
  check [--require-minimum] [--minimum-traces N] [--suggest-moves] [--json]
  config [--minimum-traces N] [--json]
  unlink ID
  comment SOURCE:START-END  Declare reviewed comment lines (not syntax-verified)
  uncomment ID             Remove a comment declaration after review
  ignore PATH --why TEXT    Exclude a file/directory from manual mapping totals only
  unignore EXACT_PATH      Restore a saved ignored path (directories end in /)
  update [--check | --status | --install-managed | --rollback | --refresh-skills | --auto off|check|apply]
         [--version VERSION | --commit FULL_SHA] [--json]
  measure import --before FILE --after FILE --manifest FILE --sources FILE
                 [--strip-prefix PREFIX/] [--allow-stale] [--json]
  measure report [--source PATH[:RANGE] | --action TEXT | --sequence JSON] [--json]
  measure union --input-root ROOT [--input-root ROOT ...] [--scope strict|source-lines] [--outcomes FILE] [--json]
  measure check [--json]
  audit enqueue --file PROPOSAL --author NAME [--offset N] [--limit N]
                [--context PATH ...] [--max-pending N] [--json]
  audit claim --worker NAME [--job ID] [--json]
  audit record --file RECEIPT [--json]
  audit fail --job ID [--claim ID] --reason TEXT [--json]
  audit retry --job ID [--json]
  audit status|drain --file PROPOSAL [--offset N] [--limit N] [--json]
  proposal prepare|check|report --file PROPOSAL [--json]
  proposal bind --file PROPOSAL --routes CATALOG [--json]
  proposal audit --file PROPOSAL [--offset N] [--limit N] [--json]
  proposal prioritize --file PROPOSAL [--limit N] [--json]
  next [--file PROPOSAL] [--limit N] [--scenario ID] [--json]
  scenario prepare|check --file CATALOG [--json]
  scenario report|packet --file CATALOG [--scenario ID] [--json]
  scenario link --file CATALOG [--scenario ID] --reviewed
                --expect-catalog-sha256 HASH --expect-map-sha256 HASH [--json]
  --help | --version

init never overwrites existing config/map or executes an app. In a terminal it may
offer agent setup. Skill installation and project guidance require separate consent. Only actions and app
execute the reviewed tracer.json argv configuration, without shell interpolation.
CLI-driven testing needs an application CLI covering the authorized app features.
If the app has no CLI, one must be built; Tracer does not build it automatically.
Global options go before the command. Repeat --include-ext to add source languages.
Ranges are 1-based, inclusive. Mapped actions are literal descriptions, never executed.
One distinct exact ordered action sequence is one manual trace per nonblank line, regardless
of duplicate links or witnesses. Repeated actions inside it remain ordered steps.
For whole-codebase mapping, propose the full scenario map first, then audit in batches.
Proposals may include unwritten tests and uncertainty; no execution is prerequisite.
The project minimum defaults to 1. check gates integrity; --require-minimum also
gates declared trace counts across included project mapping scope. Neither measures execution.
${NOTICE}`;
const fail = message => { throw new Error(message); };
const formatRanges = ranges => ranges.map(([start, end]) => start === end ? `${start}` : `${start}-${end}`).join(', ') || 'none';
function value(args, index, option) {
  if (args[index + 1] === undefined || args[index + 1] === '') fail(`${option} requires a value.`);
  return args[index + 1];
}
function minimum(text) {
  if (!/^[1-9]\d*$/.test(text)) fail('Minimum traces must be a positive safe integer.');
  return validateMinimum(Number(text));
}
async function main(args) {
  if (!args.length || args.length === 1 && ['--help', '-h'].includes(args[0])) { console.log(help); return; }
  if (args.length === 1 && args[0] === '--version') { console.log(VERSION); return; }
  const settings = { extensions: [] };
  while (args[0]?.startsWith('--')) {
    const option = args[0];
    if (!['--root', '--map', '--include-ext'].includes(option)) fail(`Unknown global option: ${option}`);
    const supplied = value(args, 0, option);
    if (option === '--include-ext') settings.extensions.push(supplied);
    else {
      const name = option.slice(2);
      if (Object.hasOwn(settings, name)) fail(`Duplicate option: ${option}`);
      settings[name] = supplied;
    }
    args = args.slice(2);
  }
  const [command, ...rest] = args;
  if (rest.length === 1 && rest[0] === '--help') { console.log(help); return; }
  if (!['init', 'actions', 'app', 'link', 'report', 'check', 'unlink', 'comment', 'uncomment', 'dead-code', 'undead-code', 'ignore', 'unignore', 'config', 'update', 'measure', 'scenario', 'proposal', 'next', 'audit'].includes(command)) fail(`Unknown command: ${command ?? '(missing)'}`);
  selectedCommand = command;
  if (command === 'audit') {
    const [mode, ...flags] = rest, options = {};
    const allowed = { enqueue: ['--file', '--author', '--offset', '--limit', '--context', '--max-pending'],
      claim: ['--worker', '--job'], record: ['--file'], fail: ['--job', '--claim', '--reason'], retry: ['--job'],
      status: ['--file', '--offset', '--limit'], drain: ['--file', '--offset', '--limit'] }[mode];
    if (!allowed) fail('Use audit enqueue, claim, record, fail, retry, status or drain.');
    for (let i = 0; i < flags.length; i++) {
      const flag = flags[i], key = flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (flag !== '--json' && !allowed.includes(flag) || Object.hasOwn(options, key) && flag !== '--context') fail(`Unknown or duplicate audit ${mode} option: ${flag}`);
      const supplied = flag === '--json' ? true : value(flags, i++, flag);
      if (['--offset', '--limit', '--max-pending'].includes(flag)) {
        if (!/^(0|[1-9]\d*)$/.test(supplied)) fail(`${flag} requires a nonnegative integer.`);
        options[key] = Number(supplied);
      } else if (flag === '--context') (options.context ??= []).push(supplied);
      else options[key] = supplied;
    }
    const result = auditQueue(new Tracer(settings), mode, options);
    console.log(JSON.stringify(result, null, 2));
    if (mode === 'drain' && !result.complete) process.exitCode = 1;
    return;
  }
  if (command === 'proposal' || command === 'next') {
    const [mode, ...flags] = command === 'next' ? ['next', ...rest] : rest, options = {};
    if (!['prepare', 'check', 'report', 'audit', 'prioritize', 'bind', ...(command === 'next' ? ['next'] : [])].includes(mode)) fail('Use proposal prepare, check, report, audit or prioritize.');
    const allowed = ['--file', '--json', ...(mode === 'audit' ? ['--offset', '--limit'] : mode === 'next' ? ['--limit', '--scenario'] : mode === 'prioritize' ? ['--limit'] : mode === 'bind' ? ['--routes'] : [])];
    for (let i = 0; i < flags.length; i++) {
      const flag = flags[i];
      if (!allowed.includes(flag) || Object.hasOwn(options, flag)) fail(`Unknown or duplicate proposal ${mode} option: ${flag}`);
      options[flag] = flag === '--json' ? true : value(flags, i++, flag);
    }
    if (!options['--file'] && mode !== 'next') fail(`proposal ${mode} requires --file.`);
    if (mode === 'bind' && !options['--routes']) fail('proposal bind requires --routes.');
    for (const flag of ['--offset', '--limit']) if (options[flag] !== undefined && !/^(0|[1-9]\d*)$/.test(options[flag])) fail(`${flag} requires a nonnegative integer.`);
    const result = mode === 'bind' ? bindProposalRoutes(new Tracer(settings), options['--file'], options['--routes']) : proposalCommand(new Tracer(settings), options['--file'] ?? DEFAULT_PROPOSAL, { mode, scenarioId: options['--scenario'],
      offset: options['--offset'] === undefined ? 0 : Number(options['--offset']), limit: options['--limit'] === undefined ? (mode === 'next' ? 1 : 25) : Number(options['--limit']) });
    console.log(JSON.stringify(result, null, 2));
    if (mode === 'check' && !result.valid) process.exitCode = 1;
    return;
  }
  if (command === 'scenario') {
    const [mode, ...flags] = rest, options = {};
    const common = ['--file', '--json'];
    const allowed = { prepare: common, check: common,
      report: [...common, '--scenario'], packet: [...common, '--scenario'],
      link: [...common, '--scenario', '--reviewed', '--expect-catalog-sha256', '--expect-map-sha256'] }[mode];
    if (!allowed) fail('Use scenario prepare, check, report, packet or link.');
    for (let i = 0; i < flags.length; i++) {
      const flag = flags[i];
      if (!allowed.includes(flag) || Object.hasOwn(options, flag)) fail(`Unknown or duplicate scenario ${mode} option: ${flag}`);
      options[flag] = ['--json', '--reviewed'].includes(flag) ? true : value(flags, i++, flag);
    }
    if (!options['--file']) fail(`scenario ${mode} requires --file.`);
    const tracer = new Tracer(settings), file = options['--file'], scenarioId = options['--scenario'];
    const result = mode === 'prepare' ? prepareScenarios(tracer, file)
      : mode === 'check' ? checkScenarios(tracer, file)
      : mode === 'report' ? reportScenarios(tracer, file, scenarioId)
      : mode === 'packet' ? scenarioPacket(tracer, file, scenarioId)
      : linkScenarios(tracer, file, { scenarioId, reviewed: !!options['--reviewed'],
        expectedCatalogSha256: options['--expect-catalog-sha256'], expectedMapSha256: options['--expect-map-sha256'] });
    // Catalogs, proposals and reports remain machine-readable even without --json.
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === 'measure') {
    const [mode, ...flags] = rest, options = {};
    const allowed = { import: ['--before', '--after', '--manifest', '--sources', '--strip-prefix', '--allow-stale', '--json'],
      report: ['--source', '--action', '--sequence', '--json'], check: ['--json'], union: ['--input-root', '--scope', '--outcomes', '--json'] }[mode];
    if (!allowed) fail('Use measure import, report, check or union.');
    for (let i = 0; i < flags.length; i++) {
      const flag = flags[i];
      if (!allowed.includes(flag) || (Object.hasOwn(options, flag) && flag !== '--input-root')) fail(`Unknown or duplicate measure ${mode} option: ${flag}`);
      if (flag === '--input-root') (options[flag] ??= []).push(value(flags, i++, flag));
      else options[flag] = ['--json', '--allow-stale'].includes(flag) ? true : value(flags, i++, flag);
    }
    if (mode === 'import' && ['--before', '--after', '--manifest', '--sources'].some(flag => !options[flag])) fail('measure import requires --before, --after, --manifest and --sources.');
    const selectors = ['--source', '--action', '--sequence'].filter(flag => options[flag] !== undefined);
    if (selectors.length > 1) fail('measure report accepts one selector.');
    const flag = selectors[0], query = flag ? { kind: flag.slice(2), value: flag === '--sequence' ? JSON.parse(options[flag]) : options[flag] } : undefined;
    const tracer = new Tracer(settings);
    const result = mode === 'import' ? importMeasured(tracer.root, { before: options['--before'], after: options['--after'],
      manifest: options['--manifest'], sources: options['--sources'], stripPrefix: options['--strip-prefix'], allowStale: !!options['--allow-stale'] })
      : mode === 'report' ? reportMeasured(tracer.root, query) : mode === 'union'
        ? unionMeasured(tracer.root, { inputRoots: options['--input-root'], outcomes: options['--outcomes'], scopeMode: options['--scope'] }) : checkMeasured(tracer.root);
    if (options['--json']) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(result.notice);
      if (mode === 'import') console.log(`${result.changed ? 'Imported' : 'Already imported'} interval: ${result.id}`);
      else if (mode === 'union') {
        console.log(`Scope ${result.scope.id} (${result.scope.mode}); ${result.intervals.unique} unique intervals, ${result.intervals.duplicates} duplicates.`);
        console.log(`All observed: ${result.allObserved.observedLines}/${result.allObserved.instrumentedLines}; passed-only known: ${result.passedOnlyKnown.observedLines}/${result.passedOnlyKnown.instrumentedLines}; unknown outcomes: ${result.intervals.outcomes.unknown}.`);
      } else if (mode === 'check') {
        console.log(`${result.intervals} interval(s); ${result.invalid.length} stale source file(s).`);
        for (const item of result.invalid) console.log(`STALE ${item.path}: ${item.error}`);
      } else for (const interval of result.intervals) {
        console.log(`INTERVAL ${interval.id} run ${interval.manifest.runId}: ${JSON.stringify(interval.manifest.actions)}`);
        for (const file of interval.files) console.log(`  ${file.path}: ${file.observedLines}/${file.instrumentedLines} instrumented lines increased; ${file.status}\n    Observed: ${formatRanges(file.observedRanges)}`);
      }
    }
    if (mode === 'check' && result.invalid.length) process.exitCode = 1;
    return;
  }
  if (command === 'update') {
    const options = {};
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i];
      if (!['--check', '--status', '--install-managed', '--rollback', '--refresh-skills', '--auto', '--version', '--commit', '--json'].includes(flag)) fail(`Unknown update option: ${flag}`);
      if (Object.hasOwn(options, flag)) fail(`Duplicate option: ${flag}`);
      options[flag] = ['--auto', '--version', '--commit'].includes(flag) ? value(rest, i++, flag) : true;
    }
    const modes = ['--check', '--status', '--install-managed', '--rollback', '--refresh-skills', '--auto'].filter(flag => Object.hasOwn(options, flag));
    if (modes.length > 1) fail('Choose one update mode at a time.');
    if (options['--version'] && options['--commit']) fail('Choose either an exact version or an exact commit.');
    if ((options['--status'] || options['--rollback'] || options['--refresh-skills'] || options['--auto']) && (options['--version'] || options['--commit'])) fail('Version/commit pins apply only to update, check or install-managed.');
    const requested = { version: options['--version'], commit: options['--commit'] };
    const result = options['--status'] ? updateStatus() : options['--auto'] ? configureUpdates(options['--auto'])
      : options['--rollback'] ? rollbackUpdate() : options['--refresh-skills'] ? { status: 'skills-refreshed', skills: refreshRegisteredSkills() } : options['--check'] ? await checkForUpdate(requested)
      : await updateCLI({ ...requested, installManaged: !!options['--install-managed'] });
    if (options['--refresh-skills'] && result.skills.some(skill => ['preserved', 'metadata-error'].includes(skill.status))) {
      result.status = 'skills-partial'; process.exitCode = 1;
    }
    if (options['--json']) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Tracer update: ${result.status ?? 'configured'}${result.version ? ` (${result.version})` : ''}`);
      if (result.message) console.log(result.message);
      if (result.auto !== undefined) console.log(`Automatic updates: ${result.auto}`);
      if (result.commit) console.log(`Verified commit: ${result.commit}`);
      if (result.launcher) console.log(`Managed launcher: ${result.launcher}`);
      if (result.skills) for (const skill of result.skills) console.log(`Skill ${skill.status}: ${skill.path ?? ''}${skill.message ? `${skill.path ? ': ' : ''}${skill.message}` : ''}`);
      if (result.verification) console.log(result.verification);
    }
    return;
  }
  if (command === 'app' || command === 'actions') {
    if (command === 'app' && rest[0] !== '--') fail('Use tracer app -- followed by the exact app arguments.');
    if (command === 'actions' && rest.length) fail('actions accepts no arguments; configure its argv in tracer.json.');
    const child = await runApp(new Tracer(settings), command === 'app' ? rest.slice(1) : [], { discovery: command === 'actions' });
    if (child.signal) {
      // Mirror termination by signal on platforms that support it.
      try { process.kill(process.pid, child.signal); } catch { process.exitCode = child.fallbackStatus; }
    } else process.exitCode = child.status ?? 1;
    return;
  }
  // Validate CLI arguments before resolving or changing a repository.
  const options = {}, actions = [];
  let source, id, path;
  const optionArgs = [...rest];
  if (['link', 'unlink', 'comment', 'uncomment', 'dead-code', 'undead-code', 'ignore', 'unignore'].includes(command)) {
    const positional = optionArgs.shift();
    if (!positional || positional.startsWith('--')) fail(`${command} requires ${['link', 'comment', 'dead-code'].includes(command) ? 'a source range' : ['ignore', 'unignore'].includes(command) ? 'a repository-relative path' : 'an exact id'} first.`);
    if (['link', 'comment', 'dead-code'].includes(command)) source = positional; else if (['ignore', 'unignore'].includes(command)) path = positional; else id = positional;
  }
  const allowed = {
    init: ['--app-json', '--actions-json', '--minimum-traces', '--agent', '--install-skill', '--add-instruction'],
    link: ['--action', '--step', '--why'], report: ['--source', '--action', '--step', '--sequence', '--json', '--minimum-traces'],
    check: ['--json', '--require-minimum', '--minimum-traces', '--suggest-moves'], config: ['--json', '--minimum-traces'], unlink: [], comment: [], uncomment: [], 'dead-code': ['--why', '--evidence'], 'undead-code': [], ignore: ['--why'], unignore: [],
  }[command];
  for (let i = 0; i < optionArgs.length; i++) {
    const flag = optionArgs[i];
    if (!allowed.includes(flag)) fail(`Unknown ${command} option: ${flag}`);
    if (Object.hasOwn(options, flag) && !(command === 'link' && flag === '--action')) fail(`Duplicate option: ${flag}`);
    if (['--json', '--require-minimum', '--suggest-moves', '--install-skill', '--add-instruction'].includes(flag)) options[flag] = true;
    else {
      const supplied = value(optionArgs, i, flag); i++;
      if (command === 'link' && flag === '--action') actions.push(supplied);
      else options[flag] = supplied;
    }
  }
  const minimumTraces = options['--minimum-traces'] === undefined ? undefined : minimum(options['--minimum-traces']);
  if (command === 'check' && minimumTraces !== undefined && !options['--require-minimum']) fail('--minimum-traces on check requires --require-minimum.');
  let query;
  if (command === 'report') {
    const selectors = ['--source', '--action', '--step', '--sequence'].filter(key => Object.hasOwn(options, key));
    if (selectors.length > 1) fail('report accepts exactly one selector.');
    if (selectors.length) {
      const flag = selectors[0];
      query = { kind: flag.slice(2), value: flag === '--sequence' ? JSON.parse(options[flag]) : options[flag] };
    }
  }
  if (command === 'init' && options['--agent'] !== undefined && !['codex', 'claude'].includes(options['--agent'])) fail('Supported agents are codex and claude; choose --agent explicitly.');
  const tracer = new Tracer(settings);
  if (command === 'init') {
    const result = initialize(tracer, {
      app: options['--app-json'] === undefined ? undefined : JSON.parse(options['--app-json']),
      actions: options['--actions-json'] === undefined ? undefined : JSON.parse(options['--actions-json']), minimumTraces,
    });
    console.log(`${result.projectCreated ? 'Created' : 'Preserved'} ${result.project}; ${result.mapCreated ? 'created' : 'preserved'} ${result.map}. No app commands executed.`);
    console.log('An application CLI lets agents and tests operate your app through commands. Before coverage work, inspect its features and build or extend that CLI to expose every authorized app feature.');
    if (result.appConfigured) console.log('An application CLI is configured, but setup has not run it or verified its features. Review tracer.json before using tracer actions; check for missing routes before claiming full CLI coverage.');
    else {
      console.log('No application CLI is connected. This does not prove the app has no CLI: inspect the repository first. If none exists, one must be built with your authorization; Tracer does not create it automatically.');
      console.log('Next: ask your agent to inspect the app and explain what needs connecting or building. Once a CLI is ready, review and add its app executable/arguments to tracer.json explicitly; init preserves existing configuration. For a new setup, provide them with tracer init --app-json.');
    }
    console.log('Keep the CLI and its tests current whenever app features change. Preserve consent, authentication and safety checks; report missing or restricted features honestly. Mapping can be inspected independently, but manual links do not prove execution or complete coverage.');
    await setupAgent(tracer.root, { agent: options['--agent'], install: !!options['--install-skill'], add: !!options['--add-instruction'] });
  } else if (command === 'dead-code') {
    const result = tracer.deadCode(source, options['--why'], options['--evidence']);
    console.log(`${result.changed ? 'Marked' : 'Already marked'} dead code: ${result.mark.id} ${location(result.mark.source)}. Review before deletion or retention.`);
  } else if (command === 'undead-code') {
    const result = tracer.undeadCode(id); console.log(`Removed dead-code declaration: ${result.id}`);
  } else if (command === 'link') {
    const result = tracer.link({ source, actions, step: options['--step'], why: options['--why'] });
    console.log(`${result.changed ? 'Linked' : 'Already linked'}: ${result.link.id}\n${location(result.link.source)} → ${JSON.stringify(result.link.actions)} → ${result.link.step ? location(result.link.step) : '(no test witness)'}\n${NOTICE}`);
  } else if (command === 'unlink') {
    tracer.unlink(id); console.log(`Removed manual link: ${id}. No source or test files changed.`);
  } else if (command === 'comment') {
    const result = tracer.comment(source);
    console.log(`${result.changed ? 'Marked comment' : 'Already marked comment'}: ${result.comment.id}\n${location(result.comment.source)}\nComment exclusions are declarations, not verified syntax or execution evidence.`);
  } else if (command === 'uncomment') {
    tracer.uncomment(id); console.log(`Removed comment declaration: ${id}. No source or links changed.`);
  } else if (command === 'ignore') {
    const result = tracer.ignore(path, options['--why']);
    console.log(`${result.changed ? 'Ignored' : 'Already ignored'}: ${result.ignored.path}\n${result.ignored.why}\nOnly manual mapping totals and minimum thresholds change. Tests, source files, links and measured evidence are preserved.`);
  } else if (command === 'unignore') {
    tracer.unignore(path); console.log(`Removed project mapping ignore: ${path}. Other matching rules may still apply. No source files, links or tests changed.`);
  } else if (command === 'config') {
    const result = tracer.config(minimumTraces);
    console.log(options['--json'] ? JSON.stringify(result, null, 2) : `Project minimum: ${result.minimumTraces} distinct manual trace(s) per nonblank source line.\n${NOTICE}`);
  } else if (command === 'check') {
    const result = tracer.check({ requireMinimum: !!options['--require-minimum'], minimumTraces, suggestMoves: !!options['--suggest-moves'] });
    if (options['--json']) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`${result.valid}/${result.total} links have current snippets and valid ranges. This is link integrity.\n${NOTICE}`);
      for (const { link, errors } of result.invalid) console.log(`INVALID LINK ${link.id ?? '(no id)'}: ${errors.join('; ')}`);
      console.log(`${result.commentValid}/${result.commentTotal} comment declarations have current source hashes. Comment syntax is not verified.`);
      for (const { comment, errors } of result.invalidComments) console.log(`INVALID COMMENT ${comment.id ?? '(no id)'}: ${errors.join('; ')}`);
      for (const { mark, errors } of result.invalidDeadCode) console.log(`INVALID DEAD CODE ${mark.id ?? '(no id)'}: ${errors.join('; ')}`);
      console.log(`${result.scopeNotice}\nIgnored scope: ${result.ignoredFiles.length} inventoried source files.`);
      for (const rule of result.ignoredSources) console.log(`IGNORE RULE ${rule.path}: ${rule.matchedFiles} source files; ${rule.why}`);
      if (result.moveSuggestions) {
        console.log(result.moveSuggestions.notice);
        console.log(`Move suggestions: ${result.moveSuggestions.totals.returnedReferences} references; ${result.moveSuggestions.totals.omittedReferences} omitted; truncated=${result.moveSuggestions.truncated}.`);
        for (const row of result.moveSuggestions.items) console.log(`MOVE ${row.linkIndex} ${row.id ?? '(no id)'} ${row.field}: ${row.status}; matches=${row.matchCount ?? 'unknown'}; ${row.candidates.map(location).join(', ')}`);
      }
      if (result.minimumTraces !== undefined) console.log(`${result.belowMinimum} nonblank source lines below project minimum ${result.minimumTraces}; ${result.blankLines} blank lines excluded; ${result.commentLines} declared comment lines excluded.`);
    }
    if (result.invalid.length || result.invalidComments.length || result.invalidDeadCode.length || result.belowMinimum) process.exitCode = 1;
  } else {
    const result = tracer.report(query, { minimumTraces });
    if (options['--json']) { console.log(JSON.stringify(result, null, 2)); return; }
    console.log(`${NOTICE}\n${result.commentNotice}\nMinimum: ${result.minimumTraces} distinct manual trace(s) per included nonblank line. Counts deduplicate exact ordered action sequences. Physical trace counts and links remain navigable, including blanks and declared comments.`);
    if (query) console.log(`LOOKUP ${query.kind}: ${JSON.stringify(query.value)}. Counts describe matching source, not test execution.`);
    console.log(result.scopeNotice);
    for (const rule of result.ignoredSources) console.log(`IGNORE RULE ${rule.path}: ${rule.matchedFiles} source files; ${rule.why}`);
    for (const file of [...result.files, ...result.ignoredFiles]) {
      console.log(file.ignoredBy ? `IGNORED ${file.path}: ${file.lines} manual source lines omitted from totals; ${file.physicalLines} physical lines; rules ${JSON.stringify(file.ignoredBy)}` : `${file.path}: ${file.linked} linked / ${file.lines} nonblank lines; ${file.belowMinimum} below minimum; ${file.blankLines} blank lines excluded; ${file.commentLines} declared comment lines excluded`);
      for (const comment of file.comments) console.log(`  DECLARED COMMENT ${location(comment.source)} [${comment.id}]`);
      console.log(`  Linked: ${formatRanges(file.linkedRanges)}\n  Unlinked: ${formatRanges(file.unlinkedRanges)}`);
      for (const range of file.traceCounts) console.log(`  ${range.start}${range.end !== range.start ? `-${range.end}` : ''}: ${range.count} manual trace(s), ${range.withStepCount} with test witnesses`);
      for (const link of file.links) console.log(`  ${location(link.source)} → ${JSON.stringify(link.actions)} → ${link.step ? location(link.step) : '(no test witness)'} [${link.id}]\n    ${link.why}`);
    }
    const t = result.totals, progress = result.progress;
    const percent = value => value === null ? 'N/A' : `${value.toFixed(2)}%`;
    console.log(`CATEGORIZATION: ${progress.categorization.status}; ${progress.categorization.lines} / ${progress.denominator} included lines (${percent(progress.categorization.percent)}).`);
    console.log(`PROPOSED SCENARIO MAP: ${progress.proposed.status}; ${progress.proposed.lines} / ${progress.proposed.denominator} included lines (${percent(progress.proposed.percent)}).`);
    console.log(`REVIEWED MANUAL LINKS (operator-declared): ${progress.reviewed.lines} / ${progress.reviewed.denominator} included lines (${percent(progress.reviewed.percent)}).`);
    console.log(`EXECUTED: ${progress.executed.status}; ${percent(progress.executed.percent)}. ${progress.executed.notice}`);
    for (const issue of progress.proposed.issues) console.log(`PROPOSAL ISSUE: ${issue}`);
    console.log(`SCENARIO MAPPING: ${progress.mapping.manual.lines} / ${progress.denominator} manual-linked lines (${percent(progress.mapping.manual.percent)}); ${progress.mapping.withTestWitness.lines} / ${progress.denominator} with test witnesses (${percent(progress.mapping.withTestWitness.percent)}).`);
    console.log(`DECLARED DEAD CODE: ${progress.deadCode.lines} / ${progress.deadCode.denominator} whole included lines (${percent(progress.deadCode.percent)}). ${progress.deadCode.notice}`);
    for (const mark of progress.deadCode.marks) console.log(`  ${location(mark.source)} [${mark.id}] Why: ${mark.why}; evidence: ${mark.evidence}`);
    for (const { mark, errors } of progress.deadCode.invalid) console.log(`INVALID DEAD CODE ${mark.id ?? '(no id)'}: ${errors.join('; ')}`);
    console.log(progress.notice);
    for (const issue of progress.categorization.issues) console.log(`CATALOG ISSUE: ${issue}`);
    console.log(`TOTAL: ${t.files} files; ${t.lines} nonblank lines; ${t.linked} linked (${t.withStep} with a test witness); ${t.unlinked} unlinked; ${t.belowMinimum} below minimum; ${t.blankLines} blank lines excluded; ${t.commentLines} declared comment lines excluded.`);
    console.log(`IGNORED TOTAL: ${result.ignoredTotals.files} files; ${result.ignoredTotals.lines} manual source lines; ${result.ignoredTotals.physicalLines} physical lines. These are outside the totals above, not proven covered.`);
    console.log(`Included inventory: ${t.physicalLines} physical lines in tracked + Git-unignored untracked source. Unmarked comments, tests and tooling stay counted unless explicitly ignored above; whitespace-only lines and current comment declarations are excluded. Built-in exclusions and non-source files are outside the count.`);
    for (const item of result.excluded) console.log(`EXCLUDED ${item.path}: ${item.reason}`);
    for (const { link, errors } of result.invalid) console.log(`INVALID LINK ${link.id ?? '(no id)'}: ${errors.join('; ')}`);
    for (const { comment, errors } of result.invalidComments) console.log(`INVALID COMMENT ${comment.id ?? '(no id)'}: ${errors.join('; ')}`);
  }
}
try {
  await main(process.argv.slice(2));
  if ((process.exitCode ?? 0) === 0) {
    const result = await maybeAutoUpdate({ command: selectedCommand });
    if (['updated', 'available', 'error', 'unavailable'].includes(result.status)) {
      console.error(`tracer update: ${result.message ?? result.status}${result.version ? ` (${result.version})` : ''}`);
      if (result.skills) for (const skill of result.skills.filter(item => !['current', 'updated'].includes(item.status))) console.error(`tracer skill: ${skill.message ?? skill.status}`);
    }
  }
}
catch (error) { console.error(`tracer: ${error.message}`); process.exitCode = 1; }
