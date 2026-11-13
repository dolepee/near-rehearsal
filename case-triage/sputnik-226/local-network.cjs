'use strict';
const net = require('node:net');

// near-workspaces 5's port search treats permission errors as occupied ports.
// Check its bind hosts first so a restricted shell fails instead of searching
// indefinitely. This is only a setup probe, not a guarantee of a later free port.
async function checkLocalNetwork() {
  for (const host of ['127.0.0.1', '0.0.0.0']) {
    await new Promise((resolve, reject) => {
      const server = net.createServer();
      const timer = setTimeout(() => {
        server.close(() => {});
        reject(new Error(`Local Sandbox networking unavailable: bind probe timed out on ${host}. Run in an environment that permits local TCP listeners.`));
      }, 3000);
      const fail = (error) => {
        clearTimeout(timer);
        reject(new Error(`Local Sandbox networking unavailable: ${error.code || error.message} binding ${host}. Run in an environment that permits local TCP listeners; increasing Node heap will not fix this restriction.`));
      };
      server.once('error', fail);
      try {
        server.listen(0, host, () => server.close((error) => {
          clearTimeout(timer);
          if (error) fail(error);
          else resolve();
        }));
      } catch (error) {
        fail(error);
      }
    });
  }
}

module.exports = {checkLocalNetwork};
