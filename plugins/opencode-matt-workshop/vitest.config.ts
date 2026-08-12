import { defineConfig } from "vitest/config"
export default defineConfig({ test: { include: ["plugins/opencode-matt-workshop/tests/**/*.test.ts"], environment: "node" } })
