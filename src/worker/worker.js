const { parentPort, workerData } = require('worker_threads');
const asyncHooks = require('async_hooks');
const util = require('util');
const fs = require('fs');
const babel = require('babel-core');
const { VM } = require('vm2');

const fetch = require('node-fetch');
const _ = require('lodash');
const falafel = require('falafel');
const prettyFormat = require('pretty-format');

const { traceLoops } = require('./loopTracer');
const { traceFunction } = require('./functionTracer');
const { traceConsole } = require('./consoleTracer');

const LOG_FILE = './log.txt';
fs.writeFileSync(LOG_FILE, '');
const log = (...msg) =>
  fs.appendFileSync(
    LOG_FILE,
    msg.map((m) => (_.isString(m) ? m : prettyFormat(m))).join(' ') + '\n'
  );

const event = (type, payload) => ({ type, payload });
const Events = {
  ConsoleLog: (message) => event('ConsoleLog', { message }),
  ConsoleWarn: (message) => event('ConsoleWarn', { message }),
  ConsoleError: (message) => event('ConsoleError', { message }),

  EnterFunction: (id, name, start, end) =>
    event('EnterFunction', { id, name, start, end }),
  ExitFunction: (id, name, start, end) =>
    event('ExitFunction', { id, name, start, end }),
  ErrorFunction: (message, id, name, start, end) =>
    event('ErrorFunction', { message, id, name, start, end }),

  InitPromise: (id, parentId) => event('InitPromise', { id, parentId }),
  ResolvePromise: (id) => event('ResolvePromise', { id }),
  BeforePromise: (id) => event('BeforePromise', { id }),
  AfterPromise: (id) => event('AfterPromise', { id }),

  InitMicrotask: (id, parentId) => event('InitMicrotask', { id, parentId }),
  BeforeMicrotask: (id) => event('BeforeMicrotask', { id }),
  AfterMicrotask: (id) => event('AfterMicrotask', { id }),

  InitTimeout: (id, callbackName) => event('InitTimeout', { id, callbackName }),
  BeforeTimeout: (id) => event('BeforeTimeout', { id }),

  UncaughtError: (error) =>
    event('UncaughtError', {
      name: (error || {}).name,
      stack: (error || {}).stack,
      message: (error || {}).message,
    }),
  EarlyTermination: (message) => event('EarlyTermination', { message }),
};

let events = [];
const postEvent = (event) => {
  events.push(event);
  parentPort.postMessage(JSON.stringify(event));
};

const eid = asyncHooks.executionAsyncId();
const tid = asyncHooks.triggerAsyncId();

const asyncIdToResource = {};

const init = (asyncId, type, triggerAsyncId, resource) => {
  asyncIdToResource[asyncId] = resource;
  if (type === 'PROMISE') {
    postEvent(Events.InitPromise(asyncId, triggerAsyncId));
  }
  if (type === 'Timeout') {
    const callbackName = resource._onTimeout.name || 'anonymous';
    postEvent(Events.InitTimeout(asyncId, callbackName));
  }
  if (type === 'Microtask') {
    postEvent(Events.InitMicrotask(asyncId, triggerAsyncId));
  }
};

const before = (asyncId) => {
  const resource = asyncIdToResource[asyncId] || {};
  const resourceName = resource.constructor.name;
  if (resourceName === 'PromiseWrap') {
    postEvent(Events.BeforePromise(asyncId));
  }
  if (resourceName === 'Timeout') {
    postEvent(Events.BeforeTimeout(asyncId));
  }
  if (resourceName === 'AsyncResource') {
    postEvent(Events.BeforeMicrotask(asyncId));
  }
};

const after = (asyncId) => {
  const resource = asyncIdToResource[asyncId] || {};
  const resourceName = resource.constructor.name;
  if (resourceName === 'PromiseWrap') {
    postEvent(Events.AfterPromise(asyncId));
  }
  if (resourceName === 'AsyncResource') {
    postEvent(Events.AfterMicrotask(asyncId));
  }
};

const destroy = (asyncId) => {
  const resource = asyncIdToResource[asyncId] || {};
};

const promiseResolve = (asyncId) => {
  const promise = asyncIdToResource[asyncId].promise;
  postEvent(Events.ResolvePromise(asyncId));
};

asyncHooks
  .createHook({ init, before, after, destroy, promiseResolve })
  .enable();

const jsSourceCode = workerData;

// console.log(modifiedSource);
// TODO: Maybe change this name to avoid conflicts?
const nextId = (() => {
  let id = 0;
  return () => id++;
})();

const arrToPrettyStr = (arr) =>
  arr.map((a) => (_.isString(a) ? a : prettyFormat(a))).join(' ') + '\n';

const START_TIME = Date.now();
const TIMEOUT_MILLIS = 5000;
const EVENT_LIMIT = 500;

const Tracer = {
  enterFunc: (id, name, start, end) =>
    postEvent(Events.EnterFunction(id, name, start, end)),
  exitFunc: (id, name, start, end) =>
    postEvent(Events.ExitFunction(id, name, start, end)),
  errorFunc: (message, id, name, start, end) =>
    postEvent(Events.ErrorFunction(message, id, name, start, end)),
  log: (...args) => {
    // postEvent(Events.EnterFunction(1, 'console.log', 1, 1));
    postEvent(Events.ConsoleLog(arrToPrettyStr(args)));
    // postEvent(Events.ExitFunction(1, 'console.log', 1, 1));
  },
  warn: (...args) => postEvent(Events.ConsoleWarn(arrToPrettyStr(args))),
  error: (...args) => postEvent(Events.ConsoleError(arrToPrettyStr(args))),
  iterateLoop: () => {
    const hasTimedOut = Date.now() - START_TIME > TIMEOUT_MILLIS;
    const reachedEventLimit = events.length >= EVENT_LIMIT;
    const shouldTerminate = reachedEventLimit || hasTimedOut;
    if (shouldTerminate) {
      postEvent(
        Events.EarlyTermination(
          hasTimedOut
            ? `Terminated early: Timeout of ${TIMEOUT_MILLIS} millis exceeded.`
            : `Termianted early: Event limit of ${EVENT_LIMIT} exceeded.`
        )
      );
      process.exit(1);
    }
  },
};

// E.g. call stack size exceeded errors...
process.on('uncaughtException', (err) => {
  postEvent(Events.UncaughtError(err));
  process.exit(1);
});

const vm = new VM({
  timeout: 6000,
  sandbox: {
    nextId,
    Tracer,
    fetch,
    _,
    lodash: _,
    setTimeout,
    queueMicrotask,
    console: {
      log: Tracer.log,
      warn: Tracer.warn,
      error: Tracer.error,
    },
  },
});

// const output = babel.transform(jsSourceCode.toString(), {
//   plugins: [traceFunction],
// }).code;

// let modifiedSource = babel.transform(output.toString(), {
//   plugins: [traceLoops],
// }).code;

// modifiedSource = babel.transform(output.toString(), {
//   plugins: [traceConsole],
// }).code;
let modifiedSource;

modifiedSource = babel.transform(jsSourceCode.toString(), {
  plugins: [traceConsole, traceFunction, traceLoops],
}).code;

// console.log(modifiedSource);
vm.run(modifiedSource);
