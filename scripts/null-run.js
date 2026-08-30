'use strict';

// Falsifiability gate, mirroring the spec repo kit's `sysspec null run`
// (which the orders/v3.1.0 pin predates): serve a plausible 200 {} to every
// request, run the bound feature suite against it, and go red unless ZERO
// scenarios pass. A scenario that passes against a service that does
// nothing is a hollow binding or an assertion-free scenario.
//
// Usage: node scripts/null-run.js [--port N] --results <file> -- <suite cmd...>

const http = require('node:http');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const args = process.argv.slice(2);
const sep = args.indexOf('--');
if (sep === -1) {
  console.error('usage: null-run.js [--port N] --results <file> -- <suite cmd...>');
  process.exit(2);
}
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 && i < sep ? args[i + 1] : fallback;
};
const port = Number(opt('--port', '9099'));
const results = opt('--results', undefined);
const cmd = args.slice(sep + 1);
if (!results || cmd.length === 0) {
  console.error('usage: null-run.js [--port N] --results <file> -- <suite cmd...>');
  process.exit(2);
}

fs.rmSync(results, { force: true });

const server = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`null service answering 200 {} on 127.0.0.1:${port}`);
  const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit' });
  const timer = setTimeout(() => {
    console.error('null run: the suite hung - likely an event await with no client timeout');
    child.kill('SIGKILL');
    process.exit(1);
  }, 300000);
  child.on('exit', () => {
    clearTimeout(timer);
    server.close();
    check();
  });
});

function check() {
  if (!fs.existsSync(results)) {
    // A missing results file is never a pass.
    console.error(`null run: no results were written to ${results}`);
    process.exit(1);
  }
  const doc = JSON.parse(fs.readFileSync(results, 'utf8'));
  const passed = [];
  for (const feature of doc) {
    for (const element of feature.elements || []) {
      if (element.type !== 'scenario') continue;
      const steps = element.steps || [];
      if (steps.length > 0 && steps.every((s) => (s.result || {}).status === 'passed')) {
        passed.push(`${feature.uri || '?'}: ${element.name} (line ${element.line})`);
      }
    }
  }
  if (passed.length > 0) {
    console.error('null run: these scenarios PASS against a service that does nothing:');
    for (const p of passed) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('null run ok: zero scenarios pass against the null service - the suite is falsifiable');
  process.exit(0);
}
