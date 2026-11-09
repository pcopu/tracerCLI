#!/usr/bin/env node
import { Tracer, VERSION, NOTICE, location, validateMinimum } from '../src/tracer.mjs';
import { initialize, runApp } from '../src/project.mjs';
import { setupAgent } from '../src/agent-setup.mjs';
import { checkForUpdate, updateCLI, configureUpdates, updateStatus, rollbackUpdate, maybeAutoUpdate } from '../src/update.mjs';
let selectedCommand;

const help = `Tracer ${VERSION} — source ↔ ordered CLI actions ↔ test steps

Usage: tracer [--root REPOSITORY] [--map PATH] [--include-ext .zig] COMMAND

  init [--app-json '["node","cli/app.mjs"]'] [--actions-json '["actions","--json"]']
       [--minimum-traces N] [--agent codex|claude] [--install-skill] [--add-instruction]
  actions                 Run configured discovery, or the app’s --help
  app -- ARGS...          Explicitly run the configured app with exact arguments
  link SOURCE:START-END --action TEXT [--action TEXT ...]
       [--step TEST:START-END] --why TEXT
  report [--source PATH[:RANGE] | --action TEXT | --step PATH[:RANGE]
          | --sequence '["first action","next action"]'] [--minimum-traces N] [--json]
  check [--require-minimum] [--minimum-traces N] [--json]
  config [--minimum-traces N] [--json]
  unlink ID
  update [--check | --status | --install-managed | --rollback | --auto off|check|apply]
         [--version VERSION | --commit FULL_SHA] [--json]
  --help | --version

init never overwrites existing config/map or executes an app. In a terminal it may
offer agent setup. Skill installation and project guidance require separate consent. Only actions and app
execute the reviewed tracer.json argv configuration, without shell interpolation.
Global options go before the command. Repeat --include-ext to add source languages.
Ranges are 1-based, inclusive. Mapped actions are literal descriptions, never executed.
One distinct exact ordered action sequence is one manual trace per line, regardless
of duplicate links or witnesses. Repeated actions inside it remain ordered steps.
The project minimum defaults to 1. check gates integrity; --require-minimum also
gates declared trace counts across the source inventory. Neither measures execution.
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
  if (!['init', 'actions', 'app', 'link', 'report', 'check', 'unlink', 'config', 'update'].includes(command)) fail(`Unknown command: ${command ?? '(missing)'}`);
  selectedCommand = command;
  if (command === 'update') {
    const options = {};
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i];
      if (!['--check', '--status', '--install-managed', '--rollback', '--auto', '--version', '--commit', '--json'].includes(flag)) fail(`Unknown update option: ${flag}`);
      if (Object.hasOwn(options, flag)) fail(`Duplicate option: ${flag}`);
      options[flag] = ['--auto', '--version', '--commit'].includes(flag) ? value(rest, i++, flag) : true;
    }
    const modes = ['--check', '--status', '--install-managed', '--rollback', '--auto'].filter(flag => Object.hasOwn(options, flag));
    if (modes.length > 1) fail('Choose one update mode at a time.');
    if (options['--version'] && options['--commit']) fail('Choose either an exact version or an exact commit.');
    if ((options['--status'] || options['--rollback'] || options['--auto']) && (options['--version'] || options['--commit'])) fail('Version/commit pins apply only to update, check or install-managed.');
    const requested = { version: options['--version'], commit: options['--commit'] };
    const result = options['--status'] ? updateStatus() : options['--auto'] ? configureUpdates(options['--auto'])
      : options['--rollback'] ? rollbackUpdate() : options['--check'] ? await checkForUpdate(requested)
      : await updateCLI({ ...requested, installManaged: !!options['--install-managed'] });
    if (options['--json']) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Tracer update: ${result.status ?? 'configured'}${result.version ? ` (${result.version})` : ''}`);
      if (result.message) console.log(result.message);
      if (result.auto !== undefined) console.log(`Automatic updates: ${result.auto}`);
      if (result.commit) console.log(`Verified commit: ${result.commit}`);
      if (result.launcher) console.log(`Managed launcher: ${result.launcher}`);
      if (result.skills) for (const skill of result.skills) console.log(`Skill ${skill.status}: ${skill.path ?? skill.message ?? ''}`);
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
  let source, id;
  const optionArgs = [...rest];
  if (command === 'link' || command === 'unlink') {
    const positional = optionArgs.shift();
    if (!positional || positional.startsWith('--')) fail(`${command} requires ${command === 'link' ? 'a source range' : 'an exact link id'} first.`);
    if (command === 'link') source = positional; else id = positional;
  }
  const allowed = {
    init: ['--app-json', '--actions-json', '--minimum-traces', '--agent', '--install-skill', '--add-instruction'],
    link: ['--action', '--step', '--why'], report: ['--source', '--action', '--step', '--sequence', '--json', '--minimum-traces'],
    check: ['--json', '--require-minimum', '--minimum-traces'], config: ['--json', '--minimum-traces'], unlink: [],
  }[command];
  for (let i = 0; i < optionArgs.length; i++) {
    const flag = optionArgs[i];
    if (!allowed.includes(flag)) fail(`Unknown ${command} option: ${flag}`);
    if (Object.hasOwn(options, flag) && !(command === 'link' && flag === '--action')) fail(`Duplicate option: ${flag}`);
    if (['--json', '--require-minimum', '--install-skill', '--add-instruction'].includes(flag)) options[flag] = true;
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
    await setupAgent(tracer.root, { agent: options['--agent'], install: !!options['--install-skill'], add: !!options['--add-instruction'] });
  } else if (command === 'link') {
    const result = tracer.link({ source, actions, step: options['--step'], why: options['--why'] });
    console.log(`${result.changed ? 'Linked' : 'Already linked'}: ${result.link.id}\n${location(result.link.source)} → ${JSON.stringify(result.link.actions)} → ${result.link.step ? location(result.link.step) : '(no test witness)'}\n${NOTICE}`);
  } else if (command === 'unlink') {
    tracer.unlink(id); console.log(`Removed manual link: ${id}. No source or test files changed.`);
  } else if (command === 'config') {
    const result = tracer.config(minimumTraces);
    console.log(options['--json'] ? JSON.stringify(result, null, 2) : `Project minimum: ${result.minimumTraces} distinct manual trace(s) per source line.\n${NOTICE}`);
  } else if (command === 'check') {
    const result = tracer.check({ requireMinimum: !!options['--require-minimum'], minimumTraces });
    if (options['--json']) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`${result.valid}/${result.total} links have current snippets and valid ranges. This is link integrity.\n${NOTICE}`);
      for (const { link, errors } of result.invalid) console.log(`INVALID LINK ${link.id ?? '(no id)'}: ${errors.join('; ')}`);
      if (result.minimumTraces !== undefined) console.log(`${result.belowMinimum} source lines below project minimum ${result.minimumTraces}.`);
    }
    if (result.invalid.length || result.belowMinimum) process.exitCode = 1;
  } else {
    const result = tracer.report(query, { minimumTraces });
    if (options['--json']) { console.log(JSON.stringify(result, null, 2)); return; }
    console.log(`${NOTICE}\nMinimum: ${result.minimumTraces} distinct manual trace(s) per line. Counts deduplicate exact ordered action sequences.`);
    if (query) console.log(`LOOKUP ${query.kind}: ${JSON.stringify(query.value)}. Counts describe matching source, not test execution.`);
    for (const file of result.files) {
      console.log(`${file.path}: ${file.linked} linked / ${file.lines} lines; ${file.belowMinimum} below minimum`);
      console.log(`  Linked: ${formatRanges(file.linkedRanges)}\n  Unlinked: ${formatRanges(file.unlinkedRanges)}`);
      for (const range of file.traceCounts) console.log(`  ${range.start}${range.end !== range.start ? `-${range.end}` : ''}: ${range.count} manual trace(s), ${range.withStepCount} with test witnesses`);
      for (const link of file.links) console.log(`  ${location(link.source)} → ${JSON.stringify(link.actions)} → ${link.step ? location(link.step) : '(no test witness)'} [${link.id}]\n    ${link.why}`);
    }
    const t = result.totals;
    console.log(`TOTAL: ${t.files} files; ${t.lines} lines; ${t.linked} linked (${t.withStep} with a test witness); ${t.unlinked} unlinked; ${t.belowMinimum} below minimum.`);
    console.log('Inventory: tracked + nonignored untracked source, including tests, comments and blank lines. Ignored/non-source files are outside the count.');
    for (const item of result.excluded) console.log(`EXCLUDED ${item.path}: ${item.reason}`);
    for (const { link, errors } of result.invalid) console.log(`INVALID LINK ${link.id ?? '(no id)'}: ${errors.join('; ')}`);
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
