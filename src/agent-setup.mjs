import { copyFileSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, openSync, closeSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { VERSION } from './tracer.mjs';
import { registerInstalledSkill } from './update.mjs';

const skillSource = fileURLToPath(new URL('../skills/tracer/SKILL.md', import.meta.url));
const marker = '<!-- tracer:agent-guidance -->';
const instruction = `${marker}\nUse the installed tracer skill and tracer CLI for this project’s Tracer workflow.\n<!-- /tracer:agent-guidance -->\n`;
const fail = message => { throw new Error(message); };
function guardPath(path, final = 'directory') {
  const absolute = resolve(path), parts = absolute.slice(parse(absolute).root.length).split(sep).filter(Boolean);
  let current = parse(absolute).root;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    let stat;
    try { stat = lstatSync(current); } catch (error) { if (error.code === 'ENOENT') break; throw error; }
    if (stat.isSymbolicLink() || realpathSync(current) !== current
        || (i === parts.length - 1 && final === 'file' ? !stat.isFile() : !stat.isDirectory())) {
      fail(`Agent setup requires regular, unsymlinked paths: ${current}`);
    }
  }
  return absolute;
}
export function agentLocations(agent, root, { home = homedir(), codexHome = process.env.CODEX_HOME } = {}) {
  if (!['codex', 'claude'].includes(agent)) fail('Supported agents are codex and claude; choose --agent explicitly.');
  const base = agent === 'codex' ? codexHome || join(home, '.codex') : join(home, '.claude');
  return { agent, base: resolve(base), skill: resolve(base, 'skills/tracer'), instruction: join(root, agent === 'codex' ? 'AGENTS.md' : 'CLAUDE.md') };
}
export function detectAgents(root, environment) {
  return ['codex', 'claude'].filter(agent => existsSync(agentLocations(agent, root, environment).base));
}
export function installSkill(locations) {
  guardPath(locations.skill);
  if (existsSync(locations.skill)) {
    guardPath(join(locations.skill, 'SKILL.md'), 'file');
    if (!existsSync(join(locations.skill, 'SKILL.md'))) fail(`Existing skill directory has no SKILL.md and was preserved: ${locations.skill}`);
    return { installed: false, path: locations.skill };
  }
  guardPath(dirname(locations.skill));
  mkdirSync(dirname(locations.skill), { recursive: true });
  mkdirSync(locations.skill); // No recursive overwrite of an existing skill.
  copyFileSync(skillSource, join(locations.skill, 'SKILL.md'), constants.COPYFILE_EXCL);
  return { installed: true, path: locations.skill };
}
export function addInstruction(locations) {
  guardPath(join(locations.skill, 'SKILL.md'), 'file');
  if (!existsSync(join(locations.skill, 'SKILL.md'))) fail('Install or review the Tracer skill before adding a project instruction.');
  const path = guardPath(locations.instruction, 'file');
  const existing = existsSync(path) ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path)) : '';
  if (existing.includes('\0')) fail('Instruction file contains NUL bytes and was preserved.');
  if (existing.includes(marker)) return { added: false, path };
  const newline = existing.includes('\r\n') ? '\r\n' : '\n';
  const addition = `${existing && !existing.endsWith('\n') ? newline : ''}${existing ? newline : ''}${instruction.replaceAll('\n', newline)}`;
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o644);
  try { writeSync(fd, addition); } finally { closeSync(fd); }
  return { added: true, path };
}
export async function setupAgent(root, { agent, install = false, add = false, interactive = !!process.stdin.isTTY && !!process.stdout.isTTY } = {}) {
  if (agent !== undefined && !['codex', 'claude'].includes(agent)) fail('Supported agents are codex and claude; choose --agent explicitly.');
  const detected = detectAgents(root);
  let terminal;
  const ask = async text => {
    terminal ??= createInterface({ input: process.stdin, output: process.stdout });
    return (await terminal.question(text)).trim().toLowerCase();
  };
  try {
    if (!agent && detected.length === 1) agent = detected[0];
    if (!agent && interactive) {
      const answer = await ask(`Agent setup${detected.length > 1 ? ' (multiple configurations found)' : ''}: codex, claude, or skip? [skip] `);
      if (['codex', 'claude'].includes(answer)) agent = answer;
      else if (answer && answer !== 'skip') console.log('Unsupported agent; no agent files changed.');
    }
    if (!agent) {
      if (install || add) fail('Choose --agent codex or --agent claude before authorizing agent changes.');
      console.log('Agent setup is optional. Choose --agent codex|claude; --install-skill and --add-instruction grant separate explicit consent. No agent files changed.');
      return;
    }
    const locations = agentLocations(agent, root);
    guardPath(locations.skill);
    let installed = existsSync(join(locations.skill, 'SKILL.md'));
    if (!installed && !install && interactive) install = ['y', 'yes'].includes(await ask(`Install the Tracer skill for ${agent} at ${locations.skill}? [y/N] `));
    if (install) {
      const result = installSkill(locations); installed = true;
      if (result.installed) registerInstalledSkill(join(locations.skill, 'SKILL.md'), { version: VERSION });
      console.log(`${result.installed ? 'Installed' : 'Preserved existing'} skill: ${result.path}`);
    }
    if (!installed) {
      if (add) fail('Project instruction not added: Tracer skill is missing. Install it with separate --install-skill consent.');
      console.log(`Tracer skill is missing for ${agent}. To install: tracer init --agent ${agent} --install-skill`);
      console.log('No project instruction was added. Skill discovery is agent-dependent, not guaranteed.');
      return;
    }
    // Existing skills are never replaced. Project guidance requires its own yes/flag.
    if (!add && interactive) add = ['y', 'yes'].includes(await ask(`Append Tracer guidance to ${locations.instruction}, preserving existing content? [y/N] `));
    if (add) {
      const result = addInstruction(locations);
      console.log(`${result.added ? 'Added' : 'Preserved existing'} Tracer guidance: ${result.path}`);
    } else console.log(`Skill available for ${agent}. No project instruction changed. Optional: tracer init --agent ${agent} --add-instruction`);
    console.log('Skill discovery depends on your agent. You can explicitly ask it to use the tracer skill.');
  } finally { terminal?.close(); }
}
