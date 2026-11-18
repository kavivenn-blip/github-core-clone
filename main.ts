// The entrypoint: the small lifecycle that connects this forge to the trial
// environment. The environment is a separate server whose origin comes from
// MAKEFUN_ENV_URL. This process binds an ephemeral port for the forge, tells
// the environment which port it picked, and then waits until the environment
// reports the trial finished. Only then does it shut down and exit.
//
// The forge itself lives in ./src/app.ts; this file only owns the handshake
// with the environment, so it stays short on purpose. It must never bind the
// environment's own port (8080): listen(0) lets the kernel choose a free one.
//
// A request that fails or times out is retried with a short exponential
// backoff, because the environment may still be starting when this process
// boots. Two answers end the retries early: a register refused as a contract
// error (400/405) is fatal, and a register answered 409 only means another
// entry registered first, which is fine — this process simply waits like any
// other.

import { createApp } from "./src/app.ts";

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");
if (envOrigin === "") {
  process.stderr.write("entry: MAKEFUN_ENV_URL is empty, so there is no environment to join\n");
  process.exit(1);
}

const CALL_BUDGET_MS = 30_000;
const BACKOFF_START_MS = 250;
const BACKOFF_LIMIT_MS = 2_000;

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function backoffFor(failures: number): number {
  return Math.min(BACKOFF_LIMIT_MS, BACKOFF_START_MS * 2 ** Math.min(failures, 8));
}

type Attempt = "finished" | "again";

async function tryRegister(port: number): Promise<Attempt> {
  let answer: Response;
  try {
    answer = await fetch(`${envOrigin}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port }),
      signal: AbortSignal.timeout(CALL_BUDGET_MS),
    });
  } catch {
    return "again";
  }
  if (answer.status === 200 || answer.status === 409) {
    return "finished";
  }
  if (answer.status === 400 || answer.status === 405) {
    throw new Error(`registration refused with HTTP ${answer.status}`);
  }
  return "again";
}

async function announce(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    if ((await tryRegister(port)) === "finished") {
      return;
    }
    await pause(backoffFor(failures));
  }
}

async function waitUntilDone(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const answer = await fetch(`${envOrigin}/done`, {
        signal: AbortSignal.timeout(CALL_BUDGET_MS),
      });
      if (answer.ok) {
        const payload = (await answer.json()) as { done?: unknown };
        if (payload.done === true) {
          return;
        }
      }
    } catch {
      // The environment is not answering yet: keep polling.
    }
    await pause(backoffFor(failures));
  }
}

async function run(): Promise<void> {
  const forge = createApp();
  await new Promise<void>((done, fail) => {
    forge.once("error", fail);
    forge.listen(0, () => {
      done();
    });
  });
  const bound = forge.address();
  if (bound === null || typeof bound === "string") {
    throw new Error("the forge did not bind a TCP port");
  }
  process.stdout.write(`entry: forge listening on ${bound.port}\n`);
  await announce(bound.port);
  process.stdout.write("entry: port announced, waiting for the trial to end\n");
  await waitUntilDone();
  forge.close();
  process.stdout.write("entry: trial finished\n");
}

try {
  await run();
  process.exit(0);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`entry: ${detail}\n`);
  process.exit(1);
}
