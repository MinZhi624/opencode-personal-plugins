import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const plugin = join(root, "plugins/opencode-matt-workshop")
const temporary = await mkdtemp(join(tmpdir(), "matt-build-"))
const compiler = process.platform === "win32" ? join(root, "node_modules/.bin/tsc.cmd") : join(root, "node_modules/.bin/tsc")
const result = spawnSync(compiler, ["--project", join(plugin, "tsconfig.json"), "--outDir", temporary], { cwd: root, stdio: "inherit" })
if (result.status !== 0) process.exit(result.status ?? 1)

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]))).flat()
}
try {
  const expected = join(plugin, "dist")
  const generated = temporary
  const generatedFiles = (await files(generated)).map((path) => relative(generated, path)).sort()
  const expectedFiles = (await files(expected)).map((path) => relative(expected, path)).sort()
  if (JSON.stringify(generatedFiles) !== JSON.stringify(expectedFiles)) throw new Error(`Committed dist file list differs from a clean TypeScript build. Generated: ${generatedFiles.join(", ")}; committed: ${expectedFiles.join(", ")}`)
  for (const path of generatedFiles) if (!Buffer.from(await readFile(join(generated, path))).equals(Buffer.from(await readFile(join(expected, path))))) throw new Error(`Committed dist differs from a clean TypeScript build: ${path}`)
  console.log("Matt Workshop dist matches a clean TypeScript build.")
} finally {
  await rm(temporary, { recursive: true, force: true })
}
