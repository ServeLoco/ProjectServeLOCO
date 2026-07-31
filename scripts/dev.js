#!/usr/bin/env node

const net = require('net');
const readline = require('readline');
const { concurrently } = require('concurrently');

const MODES = ['local', 'proddb'];
const DEFAULT_MODE = 'local';

function printUsage() {
  console.log('Usage: node scripts/dev.js [local|proddb] [--yes]');
  console.log('  local   - API + Admin + Web + Customer app against local MySQL/Mongo');
  console.log('  proddb  - local API code against PRODUCTION DBs, local UIs (requires confirmation)');
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let mode = DEFAULT_MODE;
  let yes = false;

  for (const arg of args) {
    if (arg === '--yes') {
      yes = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (MODES.includes(arg)) {
      mode = arg;
    } else {
      console.error(`Unknown argument: ${arg}`);
      printUsage();
      process.exit(1);
    }
  }

  return { mode, yes };
}

function probePort(host, port, timeout = 2000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
      }
    };

    socket.setTimeout(timeout);

    socket.once('connect', () => {
      cleanup();
      resolve(true);
    });

    socket.once('error', () => {
      cleanup();
      resolve(false);
    });

    socket.once('timeout', () => {
      cleanup();
      resolve(false);
    });

    socket.connect(port, host);
  });
}

async function localPreflight() {
  const mySqlOk = await probePort('localhost', 3306);
  const mongoOk = await probePort('localhost', 27017);

  if (!mySqlOk || !mongoOk) {
    console.error('\n❌ Local dev preflight failed.\n');
    if (!mySqlOk) {
      console.error('   MySQL is not reachable on localhost:3306.');
      console.error('   Start it before running the local stack, e.g.:');
      console.error('     sudo systemctl start mysql');
    }
    if (!mongoOk) {
      console.error('   MongoDB is not reachable on localhost:27017.');
      console.error('   Start it before running the local stack, e.g.:');
      console.error('     mongod --dbpath /var/lib/mongodb');
    }
    console.error('\nAborting — no processes were started.\n');
    process.exit(1);
  }

  console.log('✅ Local MySQL and MongoDB are reachable.\n');
}

function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function proddbGuard(skipPrompt) {
  console.log('\n⚠️  WARNING: proddb mode');
  console.log('   The local API server will connect to PRODUCTION databases.');
  console.log('   Reads and writes will hit real customer/order data.');
  console.log('   Use this only for final pre-push verification.\n');

  if (!skipPrompt) {
    const answer = await askQuestion('Type y to continue: ');
    if (answer !== 'y') {
      console.log('\nAborted — no processes were started.\n');
      process.exit(0);
    }
  } else {
    console.log('   --yes passed; skipping interactive confirmation.\n');
  }
}

async function main() {
  const { mode, yes } = parseArgs(process.argv);

  if (mode === 'local') {
    await localPreflight();
  } else {
    await proddbGuard(yes);
  }

  const apiCmd = mode === 'local'
    ? { command: 'npm run dev', cwd: 'apps/api', name: 'api', prefixColor: 'blue' }
    : { command: 'npm run dev:proddb', cwd: 'apps/api', name: 'api', prefixColor: 'magenta' };

  const commands = [
    apiCmd,
    { command: 'npm run dev', cwd: 'apps/admin', name: 'admin', prefixColor: 'green' },
    { command: 'npm start', cwd: 'apps/customer-app', name: 'app', prefixColor: 'yellow' },
  ];

  const { result } = concurrently(commands, {
    raw: false,
    killOthers: ['failure', 'success'],
    restartTries: 0,
    prefix: 'name',
    prefixLength: 10,
  });

  try {
    await result;
  } catch (error) {
    // concurrently exits with a non-zero code if any process fails;
    // the tool has already printed the failure, so just forward the code.
    process.exit(error.exitCode || 1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
