// Optional native acceptance using the already installed OpenCode CLI. No SDK,
// model, real SSH host, shared service, or user configuration is required.
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, writeFile, rm, readdir, readFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { randomBytes } from "node:crypto"
import { DENIED, REFUSED, ALLOWED, runCommand } from "./verify-permissions.mjs"
import { authorizeTransfer } from "../dist/src/permission.js"
import { buildSshAgents } from "../dist/src/agents.js"

const rule = (resource, effect) => ({ action: "shell", resource, effect })
// Installed 2.0.28 and the 2.0.31 development API use different response envelopes.
const data = (value) => value?.data ?? value

export async function verifyNative(ctx) {
  assert.equal(typeof ctx.permission.assert, "function", "Native verification blocked: this OpenCode runtime does not expose permission.assert (development API: 2.0.31)")
  const session = data(await ctx.session.create({ title: "SSH authorization acceptance", permissions: [rule("*", "allow"), rule("git push*", "deny")] }))
  const sessionID = session.id
  let cases = 0
  const limitations = []
  const permissionAssert = (request) => ctx.permission.assert(request)
  // Unexpected asks should fail a case, not hang the whole RPC until its timeout.
  async function complete(command, id = sessionID) {
    let timer
    try {
      return await Promise.race([
        runCommand(command, permissionAssert, { sessionID: id }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Native permission did not settle without a reply: ${command}`)), 5_000)
        }),
      ])
    } finally { clearTimeout(timer) }
  }
  async function replyToAsk(command, decision, message, cancel = false) {
    const controller = new AbortController()
    let observation
    let finished = false
    const operation = runCommand(command, permissionAssert, {
      sessionID, controller,
      onState(_state, recorded) { observation = recorded },
    }).finally(() => { finished = true })
    let pending
    for (let tries = 0; tries < 200; tries++) {
      pending = data(await ctx.permission.list({ sessionID }))[0]
      if (pending) break
      assert(!finished, `native ask settled before a reply: ${command}`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert(pending, `native ask did not create a permission request: ${command}`)
    assert.equal(finished, false, "ask must wait")
    assert.equal(observation.writes.length, 0, "ask must not write before approval")
    assert.deepEqual(pending.resources, observation.calls[0].resources)
    assert.deepEqual(pending.save, [command], "save must remain the complete original command")
    if (cancel) controller.abort()
    await ctx.permission.reply({ sessionID, requestID: pending.id, decision, ...(message ? { message } : {}) })
    return operation
  }
  try {
    for (const command of DENIED) {
      const result = await complete(command)
      assert.equal(result.calls.length, 1, command)
      assert.equal(result.writes.length, 0, command)
      assert(result.error && result.error !== result.reached, `${command}: native deny did not reject`)
      assert.match(String(result.error?.message ?? result.error), /permission|denied|not allowed/i, command)
      assert.equal(data(await ctx.permission.list({ sessionID })).length, 0, "deny must not ask")
      cases++
    }
    for (const command of REFUSED) {
      const result = await runCommand(command, permissionAssert, { sessionID })
      assert.match(result.output?.content ?? "", /SSH 命令分析拒绝/, command)
      assert.equal(result.calls.length, 0)
      assert.equal(result.writes.length, 0)
      cases++
    }
    for (const [command] of ALLOWED) {
      const result = await complete(command)
      assert.equal(result.error, result.reached, command)
      assert.equal(result.writes.length, 1)
      assert(result.writes[0].startsWith(`${command} 2>&1\n`), "native allow must send the original source")
      cases++
    }

    // Native last-match semantics, not a locally reimplemented prefix matcher.
    await ctx.session.update({ sessionID, permissions: [rule("*", "deny"), rule("git status*", "allow")] })
    assert.equal((await complete("git status")).writes.length, 1)
    await ctx.session.update({ sessionID, permissions: [rule("git status*", "allow"), rule("*", "deny")] })
    assert.equal((await complete("git status")).writes.length, 0)
    cases += 2

    // Different resources resolve to ask and deny in the SAME check. Any deny
    // must win before an ask is opened, regardless of resource/command ordering.
    await ctx.session.update({ sessionID, permissions: [rule("*", "allow"), rule("git status*", "ask"), rule("git push*", "deny")] })
    for (const command of ["git status && git push origin main", "git push origin main && git status"]) {
      const result = await complete(command)
      assert.equal(result.calls.length, 1)
      assert(result.calls[0].resources.includes("git status"))
      assert(result.calls[0].resources.includes("git push origin main"))
      assert(result.error && result.error !== result.reached)
      assert.match(String(result.error?.message ?? result.error), /permission|denied|not allowed/i)
      assert.equal(result.writes.length, 0)
      assert.deepEqual(data(await ctx.permission.list({ sessionID })), [], "deny+ask must not open a pending ask")
      cases++
    }

    for (const decision of ["once", "reject", "feedback", "cancel"]) {
      await ctx.session.update({ sessionID, permissions: [rule("*", "allow"), rule("git status*", "ask")] })
      const result = await replyToAsk(
        "git status", decision === "once" || decision === "cancel" ? "once" : "reject",
        decision === "feedback" ? "SSH permission verification rejected" : undefined,
        decision === "cancel",
      )
      assert.equal(result.writes.length, decision === "once" ? 1 : 0)
      if (decision === "once") assert.equal(result.error, result.reached)
      else assert(result.error && result.error !== result.reached)
      if (decision === "feedback") assert.match(String(result.error?.message ?? result.error), /SSH permission verification rejected/)
      cases++
    }

    const savedCommand = "git status --short"
    await ctx.session.update({ sessionID, permissions: [rule("*", "ask")] })
    const saved = await replyToAsk(savedCommand, "always")
    assert.equal(saved.error, saved.reached)
    assert.equal(saved.writes.length, 1)
    cases++
    assert.equal((await complete(savedCommand)).writes.length, 1, "saved exact command must work without another reply")
    assert.deepEqual(data(await ctx.permission.list({ sessionID })), [])
    cases++
    // Saved approval is project-scoped, not merely a one-off session resolution.
    const other = data(await ctx.session.create({ title: "SSH saved approval verification", permissions: [rule("*", "ask")] }))
    try {
      assert.equal((await complete(savedCommand, other.id)).writes.length, 1)
      cases++
    } finally { await ctx.session.remove({ sessionID: other.id }) }
    assert.equal((await replyToAsk("git status --branch", "reject")).writes.length, 0, "saved command must not become a prefix allow")
    cases++
    await ctx.session.update({ sessionID, permissions: [rule("*", "ask"), rule(savedCommand, "deny")] })
    const deniedSaved = await complete(savedCommand)
    assert(deniedSaved.error && deniedSaved.error !== deniedSaved.reached)
    assert.match(String(deniedSaved.error?.message ?? deniedSaved.error), /permission|denied|not allowed/i)
    assert.equal(deniedSaved.writes.length, 0, "saved approval must never override a configured deny")
    assert.deepEqual(data(await ctx.permission.list({ sessionID })), [])
    cases++

    // Preserve raw-source save semantics rather than broadening to child resources.
    // Quote removal and compound extraction mean these raw patterns do not match
    // normalized resources. Assert and report that limitation instead of hiding it.
    await ctx.session.update({ sessionID, permissions: [rule("*", "ask")] })
    for (const command of ["git 'status' --porcelain", "git status --porcelain && pwd"]) {
      assert.equal((await replyToAsk(command, "always")).writes.length, 1)
      assert.equal((await replyToAsk(command, "reject")).writes.length, 0, "raw saved pattern must not silently authorize normalized children")
      limitations.push({ command, behavior: "asks-again", reason: "raw saved command differs from normalized permission resources" })
      cases += 2
    }
    for (const command of ["git status --porcelain", "pwd"]) {
      assert.equal((await replyToAsk(command, "reject")).writes.length, 0, "whole-command approval must not separately allow a child")
      cases++
    }
    // PR regressions: exercise native rule matching, not just scanner strings.
    await ctx.session.update({ sessionID, permissions: [rule("*", "allow"), rule("git commit*", "deny"), rule("rm -rf*", "deny")] })
    for (const command of ["git -C repo commit -m x", "git -c foo=bar commit -m x", "git --git-dir=repo commit -m x", "rm -fr /tmp/inert", "rm --force --recursive /tmp/inert"]) {
      const result = await complete(command)
      assert.equal(result.writes.length, 0, command)
      assert(result.error && result.error !== result.reached, command)
      cases++
    }
    await ctx.session.update({ sessionID, permissions: [rule("*", "allow"), { action: "edit", resource: "*", effect: "deny" }] })
    for (const command of ["echo x > /tmp/inert", "echo x | tee /tmp/inert", "bash -c 'echo x >> /tmp/inert'"]) {
      const result = await complete(command)
      assert.equal(result.writes.length, 0, command)
      assert.equal(result.calls.at(-1).action, "edit")
      assert(result.error && result.error !== result.reached, command)
      cases++
    }
    const definition = buildSshAgents({})["ssh-tinker"].permissions
    await ctx.session.update({ sessionID, permissions: [...definition.policy, ...definition.hard] })
    for (const [localPath, expected] of [["new-local-file", "ssh_local_read"], [resolve(ctx.location.directory, "..", "outside-file"), "external_directory"]]) {
      let finished = false
      const operation = authorizeTransfer(ctx, { sessionID, agent: "build", messageID: "msg_test", id: "call_test" }, {
        host: "test@invalid", localPath, localAction: "read", remotePath: "/tmp/inert", remoteAction: "edit",
      }).then(() => ({ allowed: true }), (error) => ({ error })).finally(() => { finished = true })
      let pending
      for (let tries = 0; tries < 200; tries++) {
        pending = data(await ctx.permission.list({ sessionID }))[0]
        if (pending) break
        assert(!finished, "local transfer unexpectedly settled without approval")
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert(pending, `missing native ${expected} prompt`)
      assert.equal(pending.action, expected)
      await ctx.permission.reply({ sessionID, requestID: pending.id, decision: "reject" })
      assert((await operation).error, "local transfer must stop on rejection")
      cases++
    }
    return { cases, limitations }
  } finally { await ctx.session.remove({ sessionID }) }
}

async function main() {
  const cli = process.env.SSH_VERIFY_OPENCODE ?? "opencode"
  const version = spawnSync(cli, ["--version"], { encoding: "utf8", timeout: 10_000 })
  assert.equal(version.status, 0, "native verification requires an installed OpenCode V2 CLI")
  assert.match(version.stdout, /2\./, "OpenCode V2 is required")
  const [major, minor, patch] = version.stdout.match(/\d+\.\d+\.\d+/)[0].split(".").map(Number)
  if (major === 2 && minor === 0 && patch < 31) {
    throw new Error(`Native verification blocked: installed OpenCode ${version.stdout.trim()} lacks the required permission.assert API; development API is 2.0.31. No environment upgrade was performed.`)
  }
  const tempRoot = join(tmpdir(), "opencode")
  await mkdir(tempRoot, { recursive: true })
  const temp = await mkdtemp(join(tempRoot, "ssh-native-permission-"))
  let child
  try {
    const work = join(temp, "work")
    const fixture = join(temp, "fixture")
    await Promise.all([work, fixture, join(temp, "home")].map((path) => mkdir(path, { recursive: true })))
    await writeFile(join(fixture, "package.json"), JSON.stringify({ name: "ssh-native-permission-fixture", type: "module", main: "./index.js", exports: "./index.js" }))
    await writeFile(join(fixture, "index.js"), `
      import {Plugin} from '@opencode/plugin';
      import {Rpc} from '@opencode/plugin/rpc';
      import {verifyNative} from ${JSON.stringify(import.meta.url)};
      export default Plugin.define({id:'ssh-permission-verification',async setup(ctx){
        await ctx.rpc.register(Rpc.define({id:'ssh-permission-verification',events:{},methods:{run:{input:{type:'object'},output:{type:'object'},errors:{}}}}),{
          run:async()=>{try{return await verifyNative(ctx)}catch(error){return {failure:String(error),stack:error?.stack}}}
        });
      }});
    `)
    const config = join(work, "opencode.json")
    await writeFile(config, JSON.stringify({ plugins: [{ package: pathToFileURL(fixture).href }, "ssh-permission-verification"] }))
    const socket = createServer()
    socket.listen(0, "127.0.0.1")
    await once(socket, "listening")
    const port = socket.address().port
    await new Promise((resolve) => socket.close(resolve))
    const password = randomBytes(24).toString("hex")
    const environment = {
      PATH: process.env.PATH, HOME: join(temp, "home"),
      XDG_CONFIG_HOME: join(temp, "config"), XDG_DATA_HOME: join(temp, "data"),
      XDG_CACHE_HOME: join(temp, "cache"), XDG_STATE_HOME: join(temp, "state"),
      OPENCODE_CONFIG_DIR: join(temp, "config"),
      OPENCODE_DB: join(temp, "native.sqlite"), OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
    }
    child = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: work, env: environment, stdio: ["ignore", "pipe", "pipe"],
    })
    let log = ""
    child.stdout.on("data", (chunk) => { log = (log + chunk).slice(-12_000) })
    child.stderr.on("data", (chunk) => { log = (log + chunk).slice(-12_000) })
    const base = `http://127.0.0.1:${port}`
    const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "content-type": "application/json" }
    let ready = false
    for (let tries = 0; tries < 150; tries++) {
      if (child.exitCode !== null) throw new Error(`Isolated OpenCode exited: ${log}`)
      try {
        const response = await fetch(`${base}/api/info`, { headers, signal: AbortSignal.timeout(1_000) })
        if (response.ok) { ready = true; break }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert(ready, `Isolated OpenCode did not become ready: ${log}`)
    const locationQuery = `location%5Bdirectory%5D=${encodeURIComponent(work)}`
    await fetch(`${base}/api/agent?${locationQuery}`, { headers })
    let plugins
    for (let tries = 0; tries < 100; tries++) {
      plugins = await (await fetch(`${base}/api/plugin?${locationQuery}`, { headers })).json()
      const fixtureState = plugins.data?.find((plugin) => plugin.id === "ssh-permission-verification")?.state
      if (fixtureState?.status === "active") break
      if (fixtureState?.status === "failed") throw new Error(`Native fixture failed: ${fixtureState.error}`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const response = await fetch(`${base}/api/rpc/ssh-permission-verification/run?${locationQuery}`, {
      method: "POST", headers, body: JSON.stringify({ input: {} }), signal: AbortSignal.timeout(90_000),
    })
    const result = await response.json()
    if (!response.ok) {
      const configResult = await (await fetch(`${base}/api/config?${locationQuery}`, { headers })).json()
      console.error("Isolated config plugin entries:", JSON.stringify(Array.isArray(configResult) ? configResult.map((entry) => ({ path: entry.path, plugins: entry.info?.plugins })) : Object.keys(configResult)))
      for (const path of await readdir(temp, { recursive: true })) {
        if (path.endsWith(".log")) console.error((await readFile(join(temp, path), "utf8")).slice(-8_000))
      }
    }
    assert(response.ok, `Native verification failed: ${JSON.stringify(result)}\nFixture: ${JSON.stringify(plugins.data?.find((entry) => entry.id === "ssh-permission-verification"))}\n${log}`)
    assert.equal(typeof result.output?.cases, "number", JSON.stringify(result))
    console.log(`PASS native SSH permission checks: ${result.output.cases} cases (OpenCode ${version.stdout.trim()}; real permission.assert, recording SSH transport)`)
    for (const limitation of result.output.limitations ?? []) console.log(`KNOWN LIMITATION: ${JSON.stringify(limitation)}`)
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM")
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3_000))])
      if (child.exitCode === null) { child.kill("SIGKILL"); await once(child, "exit") }
    }
    await rm(temp, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
