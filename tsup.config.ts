import { defineConfig } from "tsup";

/**
 * The package is a browser-safe pure core (no Node.js built-ins, no runtime
 * dependencies), so it targets ES2020 and ships CJS + ESM + declarations.
 * Both the Powerduck desktop/web renderer and Node-based tools (CLI, MCP
 * server) consume the same built output.
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: false,
  clean: true,
  target: "es2020",
  platform: "neutral",
  minify: "terser",
  terserOptions: {
    ecma: 2020,
    compress: {
      drop_debugger: true,
    },
    mangle: {
      toplevel: true,
      keep_classnames: true,
      keep_fnames: true,
    },
    format: {
      comments: false,
    },
  },
});
