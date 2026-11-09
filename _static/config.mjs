globalThis.gnStaticMode = true;

(() => {
  const decode = value => Array.from(atob(value), (byte, index) =>
    String.fromCharCode(byte.charCodeAt(0) ^ ((73 + index * 17) & 255))).join('');
  const endpoints = Object.freeze(["PikYRqKxzu6ijJRgYAhUJzRFFqM=","PikYRqKxzu64mp8qdklbJDwNHqPwgQ=="].map(decode));
  globalThis.gnWispEndpoints = endpoints;
  globalThis.gnWispEndpoint = endpoints[0];

  globalThis.gnOpenWisp = async function openWisp(createClient) {
    for (const endpoint of endpoints) {
      let client, timer, accepted = false;
      try {
        client = createClient(endpoint);
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Wisp handshake timed out.')), 5000);
        });
        await Promise.race([client.ready, timeout]);
        if (!client.closed) {
          accepted = true;
          return { client, endpoint };
        }
      } catch {} finally {
        clearTimeout(timer);
        if (!accepted) client?.close();
      }
    }
    throw new Error('Could not connect to either Wisp server.');
  };
})();
