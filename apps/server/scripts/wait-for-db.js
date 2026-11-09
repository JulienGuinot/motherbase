const net = require('net');

const databaseUrl = new URL(process.env.DATABASE_URL);
const host = databaseUrl.hostname;
const port = Number(databaseUrl.port || 5432);
const timeoutMs = Number(process.env.DB_WAIT_TIMEOUT_MS || 120000);
const retryMs = Number(process.env.DB_WAIT_RETRY_MS || 1000);
const deadline = Date.now() + timeoutMs;

function waitForDb() {
  const socket = net.createConnection({ host, port });
  let retried = false;

  socket.once('connect', () => {
    socket.destroy();
    process.exit(0);
  });

  socket.once('error', () => retry(socket));
  socket.setTimeout(retryMs, () => retry(socket));

  function retry(socketToClose) {
    if (retried) {
      return;
    }

    retried = true;
    socketToClose.destroy();
    scheduleRetry();
  }
}

function scheduleRetry() {
  if (Date.now() >= deadline) {
    console.error(`Database not reachable at ${host}:${port} after ${timeoutMs}ms`);
    process.exit(1);
  }

  setTimeout(waitForDb, retryMs);
}

waitForDb();
