import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/server.ts"],
  format: ["esm"],
  target: "node22",
  bundle: true,
  splitting: false,
  clean: false,
  dts: false,
  sourcemap: true,
  noExternal: [/.*/],
});
