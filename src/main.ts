/**
 * One entry point for hosts that run the same image as different services (Render, Fly...):
 * SERVICE_ROLE=worker starts the background worker, anything else starts the API.
 */
if (process.env.SERVICE_ROLE === 'worker') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('./worker.js');
} else {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('./server.js');
}
