import { initializeSentry } from "../../dist/bootstrap.js";

initializeSentry("api", {
  transport: () => ({
    send(envelope) {
      process.stdout.write(`SENTRY_ENVELOPE=${JSON.stringify(envelope)}\n`);
      return Promise.resolve({ statusCode: 200 });
    },
    flush() {
      return Promise.resolve(true);
    }
  })
});
