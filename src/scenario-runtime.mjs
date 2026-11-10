import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { validateScenarioCatalog } from './scenarios.mjs';

const NOTICE = 'ADAPTER-REPORTED CALLBACK RESULTS ONLY. Callbacks are supplied explicitly by the adapter; catalog strings never execute. A fulfilled assertion callback (including undefined) does not verify assertion strength. Results are not measured execution, per-action source causality, or proof that declared source ran. Catalog snippet hashes are structurally validated, not checked against files here.';
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const now = () => new Date().toISOString();
const clone = value => JSON.parse(JSON.stringify(value));
const MAX_RESULT_BYTES = 64 * 1024 * 1024;

function fault(code) {
  const error = new Error(`Scenario runtime rejected operation (${code}).`);
  error.name = 'ScenarioRuntimeError';
  error.code = code;
  return error;
}
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
// Accept JSON data, not accessors, toJSON methods, sparse arrays or executable values.
// This preserves JSON.stringify key order without invoking caller-provided serializers.
function jsonData(value, ancestors = new Set(), depth = 0) {
  if (depth > 32) throw fault('invalid-json-data');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object' || ancestors.has(value)) throw fault('invalid-json-data');
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw fault('invalid-json-data');
  const keys = Reflect.ownKeys(value);
  if (array && keys.length !== value.length + 1) throw fault('invalid-json-data');
  ancestors.add(value);
  for (const key of keys) {
    if (array && key === 'length') continue;
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !property.enumerable || !Object.hasOwn(property, 'value')
        || (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) throw fault('invalid-json-data');
    jsonData(property.value, ancestors, depth + 1);
  }
  ancestors.delete(value);
}
function safeContext(context) {
  try {
    jsonData(context);
    if (!context || typeof context !== 'object' || Array.isArray(context)) throw fault('invalid-context');
    for (const [key, value] of Object.entries(context)) {
      if (!['build', 'platform', 'inputRoute'].includes(key) || typeof value !== 'string'
          || !value || value !== value.trim() || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) throw fault('invalid-context');
    }
    return clone(context);
  } catch { throw fault('invalid-context'); }
}
function countFailure(failures, code) {
  const existing = failures.find(value => value.code === code);
  if (existing) existing.count = Math.min(Number.MAX_SAFE_INTEGER, existing.count + 1);
  else failures.push({ code, count: 1 });
}
function observed(promise) {
  // A forgotten await must not cause an unhandled rejection before step can record it.
  // Returning the original promise still rejects normally for an awaiting adapter.
  promise.catch(() => {});
  return promise;
}

/**
 * Capture a trusted adapter's explicit callbacks against a pinned declaration.
 * context is only {build?, platform?, inputRoute?}, each a caller-supplied safe,
 * non-secret, trimmed single-line string of 1-256 characters. No args or outputs
 * are saved. Preconditions and source associations remain author declarations.
 *
 * catalogSha256 hashes UTF-8 JSON.stringify(catalog), preserving property order;
 * it is NOT the exact file-byte hash used by `tracer scenario link`.
 * This helper performs no filesystem/network operations and never runs strings.
 */
export function createScenarioRun({ catalog, scenarioId, runId, context = {} } = {}) {
  let pinned, serialized;
  try {
    jsonData(catalog);
    serialized = JSON.stringify(catalog);
    pinned = JSON.parse(serialized);
    validateScenarioCatalog(pinned, { requireHashes: true });
  } catch { throw fault('invalid-catalog'); }
  if (!identifier(runId)) throw fault('invalid-run-id');
  if (!identifier(scenarioId)) throw fault('invalid-scenario-id');
  const scenario = pinned.scenarios.find(value => value.id === scenarioId);
  if (!scenario) throw fault('unknown-scenario');
  const named = new Map(pinned.steps.map(value => [value.id, value]));
  const safe = safeContext(context), steps = [];
  let plannedEvents = 0, plannedBytes = 0;
  for (const [index, id] of scenario.steps.entries()) {
    const declaration = named.get(id);
    plannedEvents += declaration.actions.length + declaration.expectations.length;
    if (plannedEvents > 100000) throw fault('run-too-large');
    const record = {
      occurrence: index + 1, stepId: id, title: declaration.title,
      status: 'not-run', startedAt: null, finishedAt: null, failures: [],
      actions: declaration.actions.map((label, actionIndex) => ({
        index: actionIndex + 1, label, status: 'not-run', sequence: null, startedAt: null, finishedAt: null,
      })),
      expectations: declaration.expectations.map(value => ({
        id: value.id, status: 'not-run', sequence: null, startedAt: null, finishedAt: null,
      })),
    };
    plannedBytes += Buffer.byteLength(JSON.stringify(record));
    if (plannedBytes > MAX_RESULT_BYTES) throw fault('run-too-large');
    steps.push(record);
  }
  const scope = new AsyncLocalStorage(), failures = [], events = [];
  const startedAt = now();
  let cursor = 0, active = null, final = null;

  function reject(code, record = active?.record) {
    if (!final) {
      countFailure(failures, code);
      if (record) { countFailure(record.failures, code); record.status = 'failed'; }
    }
    return fault(code);
  }

  // Validation precedes the callback: rejected labels/IDs never enter user code.
  async function perform(token, kind, key, callback) {
    if (final) throw fault('run-finished');
    const record = token.record, current = scope.getStore();
    if (active !== token || !token.accepting) throw reject('operation-outside-step', record);
    if (current?.token !== token) throw reject('operation-outside-step', record);
    if (current.kind !== 'step') throw reject('operation-nested', record);
    if (token.pending) throw reject('operation-concurrent', record);
    if (typeof callback !== 'function') throw reject('operation-callback-required', record);
    let outcome;
    if (kind === 'action') {
      outcome = record.actions[token.actionCursor];
      if (!outcome || key !== outcome.label) throw reject('action-order', record);
      token.actionCursor++;
    } else {
      if (record.actions.some(value => value.status !== 'passed')) throw reject('expectation-before-actions', record);
      outcome = record.expectations.find(value => value.id === key);
      if (!outcome) throw reject('expectation-unknown', record);
      if (outcome.status !== 'not-run') throw reject('expectation-repeated', record);
    }
    outcome.status = 'running'; outcome.startedAt = now(); outcome.sequence = events.length + 1;
    const event = {
      sequence: outcome.sequence, occurrence: record.occurrence, stepId: record.stepId, kind,
      ...(kind === 'action' ? { actionIndex: outcome.index, label: outcome.label } : { expectationId: outcome.id }),
      status: 'running', startedAt: outcome.startedAt, finishedAt: null,
    };
    events.push(event);
    // Set the lock before invoking a callback, including a synchronous callback.
    token.pending = true;
    const operation = (async () => {
      try {
        const value = await scope.run({ token, kind: 'operation' }, callback);
        if (kind === 'expectation' && value === false) {
          const error = reject('expectation-false', record);
          outcome.failure = event.failure = { code: 'expectation-false' };
          throw error;
        }
        outcome.status = event.status = 'passed';
        return value;
      } catch (error) {
        outcome.status = event.status = 'failed';
        if (!outcome.failure) {
          const code = kind === 'action' ? 'action-callback-failed' : 'expectation-callback-failed';
          reject(code, record); outcome.failure = event.failure = { code };
        }
        throw error;
      } finally {
        outcome.finishedAt = event.finishedAt = now(); token.pending = false;
      }
    })();
    token.operation = observed(operation);
    return await operation;
  }

  async function advance(stepId, callback) {
    if (final) throw fault('run-finished');
    if (scope.getStore()) throw reject('step-nested', active?.record ?? scope.getStore().token.record);
    if (active) throw reject('step-concurrent');
    if (!identifier(stepId)) throw reject('step-id-invalid');
    if (steps[cursor]?.stepId !== stepId) throw reject('step-order');
    if (typeof callback !== 'function') throw reject('step-callback-required');
    const record = steps[cursor++];
    const token = { record, actionCursor: 0, accepting: true, pending: false, operation: null };
    active = token; record.status = 'running'; record.startedAt = now();
    const api = Object.freeze({
      action: (label, actionCallback) => observed(perform(token, 'action', label, actionCallback)),
      expect: (id, expectationCallback) => observed(perform(token, 'expectation', id, expectationCallback)),
    });
    let rejected = false, originalError;
    try {
      await scope.run({ token, kind: 'step' }, () => callback(api));
    } catch (error) {
      rejected = true; originalError = error; reject('step-callback-failed', record);
    } finally {
      token.accepting = false;
      if (token.pending) {
        reject('operation-not-awaited', record);
        // Keep the step active until in-flight user work settles. finish cannot
        // manufacture a terminal report while that work can still change state.
        await token.operation.catch(() => {});
      }
      record.finishedAt = now(); active = null;
      record.status = record.failures.length ? 'failed'
        : [...record.actions, ...record.expectations].every(value => value.status === 'passed') ? 'passed' : 'incomplete';
    }
    if (rejected) throw originalError;
    // Adapter catches cannot turn recorded callback/protocol failures into passes.
    if (record.status === 'failed') throw fault('step-failed');
    return freeze(clone(record));
  }

  function finish() {
    if (final) return final;
    if (active) throw reject('run-pending');
    final = freeze(clone({
      version: 1, kind: 'scenario-run-result', evidence: 'adapter-reported', notice: NOTICE,
      runId, scenarioId, catalogSha256: createHash('sha256').update(serialized).digest('hex'),
      catalogDigestBasis: 'sha256-utf8-json-stringify', context: safe,
      status: failures.length ? 'failed' : steps.every(value => value.status === 'passed') ? 'passed' : 'incomplete',
      startedAt, finishedAt: now(), failures, steps, events,
    }));
    return final;
  }
  return Object.freeze({ step: (stepId, callback) => observed(advance(stepId, callback)), finish });
}
