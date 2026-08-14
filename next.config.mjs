import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** @type {import('next').NextConfig} */
export default {
  /*
    `@solana/zk-sdk` ships a WebAssembly binary (`index_bg.wasm`) that it loads
    from a path relative to its own file. Bundling it rewrites that path and the
    binary is never emitted, so the first confidential-transfer call fails with
    ENOENT on a `.next/server/vendor-chunks/index_bg.wasm` that was never
    written. Leaving the package external means it is required from node_modules
    at runtime, WASM and all.

    This is the concrete reason the confidential-transfer stack had only ever run
    from CLI scripts before now.
  */
  serverExternalPackages: ["@solana/zk-sdk"],
  webpack: (config, { isServer }) => {
    /*
      `server/data/*.ts` imports its siblings with explicit `.js` extensions,
      which is what Node's ESM resolver requires for the tsx-run scripts and
      integration tests. Webpack resolves from disk instead, finds no `.js` file
      next to the `.ts` source, and fails — but only once a Next route imports
      that layer, which is why this surfaced when the confidential-payment API
      route was added and not before.

      Aliasing the extension keeps one import style working in both resolvers.
      The alternative — rewriting every import in the data layer — would break
      the scripts that are the project's on-chain evidence.
    */
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    if (!isServer) {
      config.resolve.alias["@solana/zk-sdk/node"] = require.resolve("@solana/zk-sdk/bundler");
      config.experiments.asyncWebAssembly = true;
    }
    return config;
  },
};
