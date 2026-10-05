import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@rewriters\//,
        replacement: path.join(here, "src/shared/rewriters/"),
      },
      { find: /^@client\//, replacement: path.join(here, "src/client/") },
      { find: /^@\//, replacement: path.join(here, "src/") },
    ],
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
  },
});
