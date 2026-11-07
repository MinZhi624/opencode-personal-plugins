// Focused regressions for the a52a81e PR findings. No real SSH or private files.
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { buildSshArgs, connectionPermission, parseConnectionOptions } from "../dist/src/connection-options.js"
import { normalizeDeviceInput, deviceOptions, profileFromTarget } from "../dist/src/devices/types.js"
import { createDeviceStore } from "../dist/src/devices/store.js"
import { createDevicesTool } from "../dist/src/tools/devices-tool.js"
import { createConnectTool } from "../dist/src/tools/connect.js"
import { createUploadTool, createDownloadTool } from "../dist/src/tools/transfer.js"
import { authorizeTransfer } from "../dist/src/permission.js"
import { buildSshAgents } from "../dist/src/agents.js"
import { scanBashCommand, containsSshCommand } from "../dist/src/shell-parser.js"
import { checkBuffer } from "../dist/src/session/reader.js"
import { createState } from "../dist/src/session/state.js"
import { startReader } from "../dist/src/session/reader.js"
import { executeCommand } from "../dist/src/session/commands.js"
import { createRemoteFileTools } from "../dist/src/tools/remote-files.js"
import sshPlugin from "../dist/src/index.js"

export async function verifyReviewFixes(runCommand) {
  let cases = 0
  for (const options of [
    "-o ProxyCommand=touch /tmp/never", "-oProxyCommand=true", "-o LocalCommand=true",
    "-oPermitLocalCommand=yes", "-o PKCS11Provider=library", "-oKnownHostsCommand=true",
    "-F config", "-E log", "-oInclude=config", "-oSecurityKeyProvider=library",
    "-oUserKnownHostsFile=arbitrary", "-oMatch=exec", "host bash -c true", "-J -Fconfig",
    "-p 0", "-J bad;command", "-i '%d/key'", "-o StrictHostKeyChecking=no",
  ]) {
    assert.throws(() => buildSshArgs("test@invalid", options), undefined, options)
    assert.throws(() => normalizeDeviceInput({ name: "test", host: "invalid", options }), undefined, options)
    cases++
  }
  for (const host of ["-Fconfig", "user@-Fconfig", "-user@host", "user@host command", "a@b@c", "host\n", "user@host;true"]) {
    assert.throws(() => buildSshArgs(host))
    cases++
  }
  for (const user of ["-root", "bad user", "a@b"]) {
    assert.throws(() => normalizeDeviceInput({ name: "test", host: "invalid", user }))
    cases++
  }
  const profile = normalizeDeviceInput({ name: "test", host: "invalid", port: 2222, identityFile: "/path with spaces/key", options: "-J user@jump:2222 -o ConnectTimeout=10" })
  const argv = buildSshArgs("test@invalid", deviceOptions(profile))
  assert.deepEqual(argv.slice(0, 2), ["-F", "none"])
  assert(argv.includes("/path with spaces/key"))
  assert(argv.includes("PermitLocalCommand=no"))
  assert.equal(profileFromTarget("test@invalid", deviceOptions(profile)).identityFile, "/path with spaces/key")
  assert.deepEqual(parseConnectionOptions("-p2222"), ["-p", "2222"])
  const permission = connectionPermission("test@invalid", "-p 2222", "/work")
  assert(permission.metadata.argv.includes("2222"))
  assert.deepEqual(permission.resources, ["test@invalid"])
  assert.notDeepEqual(permission.metadata.argv, connectionPermission("test@invalid", "-p 22", "/work").metadata.argv)
  cases++

  // Validation happens before permission or process creation in the real tool.
  await assert.rejects(createConnectTool({ ctx: { permission: { assert() { assert.fail("unsafe input reached permissions") } } } }).execute(
    { host: "test@invalid", options: "-oProxyCommand=true" }, {},
  ), /不支持/)
  cases++

  const agents = buildSshAgents({})
  for (const definition of Object.values(agents)) {
    for (const action of ["ssh_local_read", "ssh_local_edit", "external_directory"]) {
      assert.equal(definition.permissions.policy.findLast((rule) => rule.action === action)?.effect, "ask")
    }
  }
  for (const id of ["ssh-inspector", "ssh-surveyor"]) {
    assert(agents[id].permissions.hard.some((rule) => rule.action === "ssh_local_edit" && rule.effect === "deny"))
  }
  cases++

  await mkdir(join(tmpdir(), "opencode"), { recursive: true })
  const temp = await mkdtemp(join(tmpdir(), "opencode", "ssh-review-"))
  const tool = { sessionID: "ses_test", agent: "ssh-tinker", messageID: "msg_test", id: "call_test", signal: new AbortController().signal }
  try {
    const work = join(temp, "work"), outside = join(temp, "outside")
    await mkdir(work); await mkdir(outside)
    await writeFile(join(outside, "inert.txt"), "not a private file")
    await symlink(outside, join(work, "link"), "dir")
    await symlink(join(outside, "new.txt"), join(work, "link-file"))
    for (const [localPath, action] of [["link/inert.txt", "read"], ["link/new.txt", "edit"], ["link-file", "edit"], ["new.txt", "edit"]]) {
      const calls = []
      const ctx = { location: { directory: work }, permission: { async assert(request) { calls.push(request) } } }
      const canonical = await authorizeTransfer(ctx, tool, { host: "test@invalid", localPath, localAction: action, remotePath: "/remote", remoteAction: action === "read" ? "edit" : "read" })
      assert(calls.some((call) => call.action === `ssh_local_${action}` && call.resources[0] === canonical))
      assert.equal(calls.some((call) => call.action === "external_directory"), localPath.startsWith("link"))
      cases++
    }
    for (const direction of ["upload", "download"]) {
      let writes = 0
      const rejected = new Error("local transfer denied")
      const state = { ...createState(), host: "test@invalid", remoteDirectory: "/work", proc: { stdin: { write() { writes++ } } } }
      const runtime = {
        ctx: { location: { directory: work }, permission: { async assert(request) { if (request.action.startsWith("ssh_local_")) throw rejected } } },
        async peekFor() { return { state } },
      }
      const transfer = direction === "upload" ? createUploadTool(runtime) : createDownloadTool(runtime)
      await assert.rejects(transfer.execute({ localPath: join(outside, "inert.txt"), remotePath: "/tmp/file" }, tool), (error) => error === rejected)
      assert.equal(writes, 0)
      assert.equal(await readFile(join(outside, "inert.txt"), "utf8"), "not a private file")
      cases++
    }

    let stored
    const devices = createDeviceStore({ storage: { async get() { return stored }, async set(_key, value) { stored = value } } })
    const deviceTool = createDevicesTool({ devices, ctx: { permission: { async assert() {} } } })
    const saved = await devices.save({ name: "test", host: "invalid" })
    assert((await deviceTool.execute({ action: "list" }, tool)).content.includes(`id=${saved.id}`))
    assert((await deviceTool.execute({ action: "save", id: saved.id, name: "renamed", host: "new-host" }, tool)).content.includes(`id=${saved.id}`))
    assert.equal((await devices.list()).length, 1)
    assert.equal((await devices.get(saved.id)).host, "new-host")
    cases++

    if (process.platform === "linux") {
      // Exercise the real stream reader and ssh_read twice over one local Bash
      // pipe. This is protocol acceptance, explicitly NOT a real SSH device.
      const file = join(work, "fixture.txt")
      const content = "  indentation\n\nlast line\n"
      await writeFile(file, content)
      const proc = spawn("/bin/bash", ["--noprofile", "--norc"], { cwd: work, env: { PATH: "/usr/bin:/bin", HOME: temp } })
      const state = { ...createState(), host: "test@invalid", proc, remoteDirectory: work }
      const reading = startReader(state, proc.stdout)
      try {
        const runtime = { ctx: { permission: { async assert() {} } }, async peekFor() { return { state } } }
        const remoteRead = createRemoteFileTools(runtime).read
        assert.equal(await executeCommand(state, "printf 'first\\n'", 5_000), "first\n")
        assert.equal(await executeCommand(state, "printf 'second\\n'", 5_000), "second\n")
        assert.equal((await remoteRead.execute({ path: file }, tool)).content, content)
        assert.equal((await remoteRead.execute({ path: file }, tool)).content, content)
        cases++
      } finally { proc.kill(); await once(proc, "close"); await reading }
    }
  } finally { await rm(temp, { recursive: true, force: true }) }

  for (const command of ["echo x > /tmp/f", "echo x >> /tmp/f", "echo x &> /tmp/f", "echo x 2> /tmp/f", "echo x | tee -a /tmp/f", "bash -c 'echo x > /tmp/f'"]) {
    assert((await scanBashCommand(command)).writePaths.includes("/tmp/f"))
    const rejection = new Error("read-only worker edit denied")
    const result = await runCommand(command, async (request) => { if (request.action === "edit") throw rejection })
    assert.equal(result.error, rejection)
    assert.equal(result.writes.length, 0)
    assert(result.calls.find((call) => call.action === "edit").resources.includes("test@invalid:/tmp/f"))
    cases++
  }
  for (const command of ["echo x 2>&1", "echo x 1>&2", "echo x 2>&-", "cat < /tmp/f"]) {
    assert.deepEqual((await scanBashCommand(command)).writePaths, [])
    cases++
  }
  for (const command of ["git -C repo commit -m x", "git -c foo=bar commit -m x", "git --git-dir=repo --work-tree=repo commit -m x", "git -Crepo -cfoo=bar commit -m x"]) {
    assert((await scanBashCommand(command)).resources.includes("git commit -m x"))
    cases++
  }
  for (const command of ["rm -fr /tmp/f", "rm -r -f /tmp/f", "rm --force --recursive /tmp/f"]) {
    assert((await scanBashCommand(command)).resources.some((resource) => resource.startsWith("rm -rf")))
    cases++
  }
  for (const command of ["git -c core.sshCommand=ssh fetch", "GIT_SSH_COMMAND=ssh git fetch", "GIT_SSH=/usr/bin/ssh git fetch", "git config --global core.sshCommand ssh", "git -ccore.sshCommand=ssh fetch", "rsync -e ssh a host:b", "RSYNC_RSH=ssh rsync a host:b"]) {
    assert.equal(await containsSshCommand(command), true, command)
    cases++
  }

  // Two command responses, every possible marker-line chunk boundary. Preserve
  // genuine leading/trailing blank lines while consuming only the protocol EOL.
  for (const newline of ["\n", "\r\n"]) {
    const payload = `  first\n\n<<__OC_SSH_DONE__first_0_>>${newline}`
    for (let split = 0; split <= payload.length; split++) {
      const state = createState()
      let first, second
      state.currentMarkerId = "first"; state.pendingResolve = (result) => { first = result.output }
      state.buffer = payload.slice(0, split); checkBuffer(state)
      state.buffer += payload.slice(split); checkBuffer(state)
      assert.equal(first, "  first\n\n")
      assert.equal(state.buffer, "")
      state.currentMarkerId = "second"; state.pendingResolve = (result) => { second = result.output }
      state.buffer += "\nnext-command-output\n<<__OC_SSH_DONE__second_0_>>\n"; checkBuffer(state)
      assert.equal(second, "\nnext-command-output\n")
      assert.equal(state.buffer, "")
    }
    cases++
  }

  // Real setup hooks/RPC implementations; not a live server or TUI acceptance.
  let rpc, modelHook, agentTransform, actor = "tinker"
  const registrations = { async dispose() {} }
  const calls = [], lookups = []
  const ctx = {
    options: { agents: { "ssh-tinker": { variant: "high", temperature: 0.3 } } },
    permission: { async assert(request) { calls.push(request) } },
    storage: { async get() { return undefined }, async set() {} },
    tool: { async transform() { return registrations }, async hook() { return registrations } },
    agent: { async transform(callback) { agentTransform = callback; return registrations } },
    session: { async get({ sessionID }) { lookups.push(sessionID); return { agent: actor } }, async hook(_name, callback) { modelHook = callback; return registrations } },
    rpc: { async register(_definition, handlers) { rpc = handlers; return registrations } },
    event: { subscribe() { return { async *[Symbol.asyncIterator]() { yield { type: "session.execution.failed", data: { sessionID: "ses_failed" } } } } } },
  }
  const cleanup = await sshPlugin.setup(ctx)
  try {
    await new Promise((resolve) => setImmediate(resolve))
    assert(lookups.includes("ses_failed"), "execution.failed must reach the connection cleanup path")
    cases++
    const agentDrafts = new Map()
    agentTransform({ get() { return { model: { providerID: "openai", id: "test", variant: "low" } } }, update(id, callback) { const draft = { permissions: [] }; callback(draft); agentDrafts.set(id, draft) } })
    assert.equal(agentDrafts.get("ssh-tinker").model.variant, "high")
    const event = { agent: "ssh-tinker", tools: { shell: {}, read: {}, ssh: {} }, options: {} }
    modelHook(event)
    assert.equal(event.options.temperature, 0.3)
    assert.equal(event.tools.shell, undefined)
    cases++
    const call = { signal: new AbortController().signal, error(_type, message) { throw new Error(message) } }
    for (const [method, input] of [["list", {}], ["save", { name: "test", host: "invalid" }], ["remove", { id: "missing" }], ["connect", { deviceID: "missing" }], ["status", {}]]) {
      await assert.rejects(rpc[method]({ sessionID: "ses_test", ...input }, call), /当前角色不能操作 SSH/)
      cases++
    }
    actor = "ssh-tinker"
    await rpc.list({ sessionID: "ses_test" }, call)
    assert.equal(calls.at(-1).action, "ssh_devices")
    await assert.rejects(rpc.save({ sessionID: "ses_test", name: "bad", host: "invalid", options: "-oProxyCommand=true" }, call), /不支持/)
    cases++
  } finally { await cleanup() }
  console.log(`PASS PR review regressions: ${cases} checks (recording transport, no real SSH)`)
  return cases
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { runCommand } = await import("./verify-permissions.mjs")
  await verifyReviewFixes(runCommand)
}
