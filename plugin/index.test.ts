import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import type { Plugin } from "@opencode/plugin"
import { PolicyStore, Vault } from "oc-secure-kit"
import plugin, { createPlugin, parseOptions, PLUGIN_ID } from "./index.js"
import { startFakeGitHub, type FakeGitHub } from "./testgithub.js"
import { startSshd, type TestSshd } from "./testsshd.js"

const exec = promisify(execFile)
const TOKEN = "gho_fakeTokenForTests_0123456789abcdef"
const REAL_HOME = homedir()
const REAL_FILES = ["authorized_keys", "known_hosts"].map(name => join(REAL_HOME, ".ssh", name))
const fingerprint = async () => Promise.all(REAL_FILES.map(async path => createHash("sha256").update(await readFile(path).catch(() => Buffer.from("missing"))).digest("hex")))
const dirs: string[] = []
let github: FakeGitHub
let sshd: TestSshd
let realBefore: string[]
let home: string

before(async () => {
  realBefore = await fingerprint()
  home = await mkdtemp(join(tmpdir(), "ocg-home-"))
  dirs.push(home)
  process.env.HOME = home // the plugin and git must never read or write the developer's real home
  delete process.env.GH_TOKEN; delete process.env.GITHUB_TOKEN
  sshd = await startSshd()
  github = await startFakeGitHub({ login: "jdoe", token: TOKEN, orgs: ["acme"], ssoBlocked: ["locked-org"], authorizedKeys: sshd.authorizedKeys })
  await github.createRepo("acme", "app")
  await github.createRepo("someone-else", "lib")
})
after(async () => {
  await github?.stop(); await sshd?.stop()
  process.env.HOME = REAL_HOME
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })))
  assert.deepEqual(await fingerprint(), realBefore, "real ~/.ssh files unchanged")
})

type Effect = "allow" | "ask" | "deny"
type Tool = { name: string; description: string; execute: (input: unknown, context: unknown) => Promise<{ content: string }> }

async function host(reply: "approve" | "reject" = "approve", options: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ocg-data-"))
  const workspace = await mkdtemp(join(tmpdir(), "ocg-ws-"))
  dirs.push(dir, workspace)
  const hooks = { evaluate: [] as any[], before: [] as any[], after: [] as any[], shell: [] as any[] }
  const transforms: ((editor: any) => void)[] = []
  const tools = new Map<string, Tool>()
  const prompts: { action: string; resources: string[] }[] = []
  const registration = (list: unknown[], item: unknown) => { list.push(item); return { dispose: async () => { const i = list.indexOf(item); if (i >= 0) list.splice(i, 1) } } }
  const rebuild = () => { tools.clear(); for (const transform of transforms) transform({ add: (tool: Tool) => tools.set(tool.name, tool) }) }
  const ctx = {
    options: { dataDirectory: dir, endpoints: { [github.host]: { web: github.web, api: github.api } }, ...options },
    session: { get: async ({ sessionID }: { sessionID: string }) => ({ parentID: sessionID === "child" ? "root" : undefined, location: { directory: workspace } }) },
    permission: {
      hook: async (_: string, callback: any) => registration(hooks.evaluate, callback),
      assert: async (input: any) => {
        const event = { ...input, effect: "allow" as Effect }
        for (const hook of hooks.evaluate) await hook(event)
        if (event.effect === "deny") throw new Error(event.message ?? "denied")
        if (event.effect === "ask") { prompts.push({ action: input.action, resources: input.resources }); if (reply === "reject") throw new Error("rejected by user") }
      },
    },
    tool: {
      transform: async (callback: any) => { transforms.push(callback); rebuild(); return { dispose: async () => { transforms.splice(transforms.indexOf(callback), 1); rebuild() } } },
      reload: async () => rebuild(),
      hook: async (name: string, callback: any) => registration(name === "execute.before" ? hooks.before : hooks.after, callback),
    },
    shell: { hook: async (_: string, callback: any) => registration(hooks.shell, callback) },
    event: { subscribe: () => (async function* () {})() },
  }
  const cleanup = await createPlugin().setup(ctx as unknown as Plugin.Context) as () => Promise<void>
  let n = 0
  const context = (agent: string, sessionID: string) => ({ sessionID, agent, messageID: "m", id: `c${++n}`, signal: new AbortController().signal, progress: async () => {} })
  const call = async (name: string, input: unknown, agent = "build", sessionID = "child") => {
    const tool = tools.get(name)
    if (!tool) throw new Error(`no tool ${name}`)
    const c = context(agent, sessionID)
    let event: any
    try { event = { tool: name, id: c.id, input, status: "completed", result: await tool.execute(input, c) } }
    catch (error) { event = { tool: name, id: c.id, input, status: "error", error } }
    for (const hook of hooks.after) await hook(event)
    if (event.status === "error") throw event.error
    return JSON.parse(event.result.content)
  }
  /** The native shell tool path: execute.before, shell.create.before, a real sh, execute.after. */
  const shell = async (command: string, workdir?: string, agent = "build") => {
    const c = context(agent, "child")
    const input = { command, description: "t", ...(workdir && { workdir }) }
    for (const hook of hooks.before) await hook({ tool: "shell", ...c, input })
    const create = { command, cwd: workdir ?? workspace, timeout: 60_000, shell: "/bin/sh", env: {} as Record<string, string | undefined> }
    for (const hook of hooks.shell) await hook(create)
    const { exit, output } = await new Promise<{ exit: number; output: string }>((resolve, reject) => {
      const child = spawn("/bin/sh", ["-c", command], { cwd: create.cwd, env: { ...process.env, ...create.env } as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] })
      let output = ""
      child.stdout.on("data", chunk => { output += chunk }); child.stderr.on("data", chunk => { output += chunk })
      child.on("error", reject); child.on("close", code => resolve({ exit: code ?? -1, output }))
    })
    const event = { tool: "shell", id: c.id, input, status: "completed", result: { output: { exit, output }, content: [{ type: "text", text: output }] } as any }
    for (const hook of hooks.after) await hook(event)
    return { exit, text: event.result.content[0].text as string, env: create.env }
  }
  /** A work account signed in through the device flow. */
  const signedIn = async (id = "work", extra: Record<string, unknown> = {}) => {
    await call("github_account_upsert", { id, host: github.host, ...extra })
    const started = await call("github_signin", { id })
    github.approve()
    for (let i = 0; i < 50 && (await call("github_list", {})).accounts.find((a: { id: string }) => a.id === id).signedInAs === null; i++) await new Promise(r => setTimeout(r, 100))
    return started
  }
  return { dir, workspace, tools, prompts, call, shell, signedIn, cleanup, hooks, policy: () => PolicyStore.open(dir), vault: () => Vault.open({ dir, plugin: PLUGIN_ID }) }
}

const remote = (owner: string, repo: string) => `${github.web}/${owner}/${repo}.git`

test("plugin identity, tools, and safe failure", async () => {
  assert.equal(plugin.id, PLUGIN_ID)
  const h = await host()
  assert.equal(h.tools.size, 8)
  await h.cleanup()
  assert.equal(h.tools.size, 0)
  assert.equal(Object.values(h.hooks).reduce((sum, list) => sum + list.length, 0), 0)
  const broken = await host("approve", { dataDirectory: "relative" })
  assert.equal(broken.tools.size, 0)
  assert.throws(() => parseOptions({ endpoints: { x: { web: "ftp://x" } } }), /needs web and api/)
})

test("browser sign-in discovers the account and its orgs, including SSO-blocked ones", async () => {
  const h = await host()
  const started = await h.signedIn()
  assert.match(started.tellUser, /ABCD-1234/)
  const list = await h.call("github_list", {})
  const work = list.accounts[0]
  assert.equal(work.signedInAs, "jdoe")
  assert.deepEqual(work.orgs.map((org: { org: string; sso: string }) => [org.org, org.sso]), [["acme", "none"], ["locked-org", "authorize"]])
  assert.equal(work.secrets.token, "set")
  assert.doesNotMatch(JSON.stringify(list), new RegExp(TOKEN), "the token never reaches the agent")
  const detail = await h.call("github_account_get", { id: "work" })
  assert.match(detail.orgs.find((org: { login: string }) => org.login === "locked-org").authorizeUrl, /sso\?authorization_request=req-1/)
  await new Promise(r => setTimeout(r, 20))
  const description = h.tools.get("github_list")!.description
  assert.match(description, /work: login jdoe on 127\.0\.0\.1:\d+, git over https → orgs: acme, locked-org \[needs SSO authorization by the user\]/)
  assert.match(description, /an account is an identity you act as; orgs are organizations/)
})

test("git over https: clone, commit and push with the account's own login and identity", async () => {
  const h = await host()
  await h.signedIn()
  const clone = await h.shell(`git clone -q ${remote("acme", "app")} app && echo cloned`)
  assert.equal(clone.exit, 0, clone.text)
  assert.ok(clone.env.GIT_CONFIG_GLOBAL && clone.env.GIT_CONFIG_NOSYSTEM === "1")
  const repo = join(h.workspace, "app")
  const commit = await h.shell(`git commit -q --allow-empty -m change && git log -1 --format='%an <%ae>'`, repo)
  assert.match(commit.text, /^Test User <4242\+jdoe@users\.noreply\.127\.0\.0\.1:\d+>/, commit.text)
  const push = await h.shell("git push -q origin HEAD:feature && echo pushed", repo)
  assert.equal(push.exit, 0, push.text)
  assert.match(push.text, /pushed/)
  assert.deepEqual(h.prompts, [], "allowed by default")
  const leak = await h.shell(`git config --get credential.${github.web}.helper && cat "$(dirname "$(git config --get-all credential.${github.web}.helper | tail -1 | tr -d "!'")")/token"`, repo)
  assert.doesNotMatch(leak.text, new RegExp(TOKEN), "token masked in the output of commands it was supplied to")
  const plain = await h.shell("git status --short; echo plain", repo)
  assert.deepEqual(plain.env, {}, "local read-only git commands are untouched")
})

test("repos owned by nobody the account reaches use the system git untouched", async () => {
  const h = await host()
  await h.signedIn()
  const result = await h.shell(`git ls-remote ${remote("someone-else", "lib")} || true`)
  assert.deepEqual(result.env, {})
  const none = await h.shell(`OCG_ACCOUNT=none git ls-remote ${remote("acme", "app")} || true`)
  assert.deepEqual(none.env, {}, "OCG_ACCOUNT=none means the system git")
})

test("permissions: risky actions ask, denied ones run without credentials, org rows override", async () => {
  const h = await host()
  await h.signedIn()
  await h.shell(`git clone -q ${remote("acme", "app")} app`)
  const repo = join(h.workspace, "app")
  await h.shell("git commit -q --allow-empty -m x", repo)
  const forced = await h.shell("git push -q --force origin HEAD:main && echo pushed", repo)
  assert.equal(forced.exit, 0, forced.text)
  assert.deepEqual(h.prompts.map(p => [p.action, p.resources]), [["oc-github.force-push", ["work@acme"]]])

  await (await h.policy()).setCells([{ entity: "work@acme", row: { agent: "*" }, capability: "push", effect: "deny" }])
  const denied = await h.shell("git push -q origin HEAD:other && echo pushed", repo)
  assert.notEqual(denied.exit, 0)
  assert.match(denied.text, /push on work@acme: denied by the GitHub permissions table/)
  assert.doesNotMatch(denied.text, /pushed/)

  const rejecting = await host("reject")
  await rejecting.signedIn()
  await rejecting.shell(`git clone -q ${remote("acme", "app")} app`)
  const declined = await rejecting.shell("git push -q -f origin HEAD:main", join(rejecting.workspace, "app"))
  assert.match(declined.text, /force-push on work@acme: not granted \(rejected by user\)/)
})

test("ambiguous owners: nothing supplied, agent told to decide or ask; OCG_ACCOUNT picks", async () => {
  const h = await host()
  await h.signedIn("work")
  await h.call("github_account_upsert", { id: "other", host: github.host, auth: "token", owners: ["acme"] })
  await (await h.vault()).set("other", "token", TOKEN)
  const unclear = await h.shell(`git ls-remote ${remote("acme", "app")}`)
  assert.notEqual(unclear.exit, 0)
  assert.match(unclear.text, /acme is reachable from several accounts \(other, work\)\. Nothing was supplied\..*OCG_ACCOUNT=<account>/s)
  const chosen = await h.shell(`OCG_ACCOUNT=work git ls-remote ${remote("acme", "app")}`)
  assert.equal(chosen.exit, 0, chosen.text)
  const unknown = await h.shell(`OCG_ACCOUNT=nope git ls-remote ${remote("acme", "app")}`)
  assert.match(unknown.text, /OCG_ACCOUNT=nope is not an account/)
})

test("gh commands get the account's token, host and a private gh config", async () => {
  const h = await host()
  await h.signedIn()
  await h.shell(`git clone -q ${remote("acme", "app")} app`)
  const result = await h.shell(`gh pr merge 3 --squash 2>/dev/null; echo "$GH_HOST|$GH_CONFIG_DIR"`, join(h.workspace, "app"))
  assert.equal(result.env.GH_ENTERPRISE_TOKEN, TOKEN)
  assert.match(result.text, new RegExp(`^${github.host.replace(/[.]/g, "\\.")}\\|.*\\/gh$`, "m"))
  const auth = await h.shell("gh auth status 2>/dev/null; true", join(h.workspace, "app"))
  assert.deepEqual(auth.env, {}, "gh auth is left to the user")
})

test("ssh accounts: generated key uploaded through the API, git over ssh with the plugin's own key", async () => {
  const h = await host()
  await h.signedIn("personal", { transport: "ssh", owners: [sshd.user] })
  const keygen = await h.call("github_ssh_keygen", { id: "personal" })
  assert.equal(keygen.uploaded, true, JSON.stringify(keygen))
  assert.match(await readFile(sshd.authorizedKeys, "utf8"), /oc-github:personal/)
  // A bare repo inside the sshd user's (temporary) home, addressed like a GitHub repo path.
  const bare = join(sshd.home, sshd.user, "tools.git")
  await mkdir(join(sshd.home, sshd.user), { recursive: true })
  await exec("git", ["init", "-q", "--bare", "-b", "main", bare])
  const result = await h.shell(`OCG_ACCOUNT=personal git ls-remote ssh://${sshd.user}@127.0.0.1:${sshd.port}${bare} && echo ssh-ok`)
  assert.equal(result.exit, 0, result.text)
  assert.match(result.env.GIT_SSH_COMMAND!, /-F \/dev\/null .*IdentityAgent=none .*-i '.*ssh-key'/)
  assert.match(await readFile(join(h.dir, "known_hosts"), "utf8"), /127\.0\.0\.1/, "host keys go to the plugin's own known_hosts")
})

test("the user's own git config is ignored unless the account layers it", async () => {
  const h = await host()
  await writeFile(join(home, ".gitconfig"), "[user]\n\tname = System Person\n\temail = system@example.com\n")
  await h.signedIn("work", { name: "Work Name" })
  await h.shell(`git clone -q ${remote("acme", "app")} app`)
  const repo = join(h.workspace, "app")
  const isolated = await h.shell("git commit -q --allow-empty -m a && git log -1 --format=%an", repo)
  assert.match(isolated.text, /^Work Name/m)
  await h.call("github_account_upsert", { id: "work", useSystemGitConfig: true, name: null })
  const layered = await h.shell("git config --get user.email; git commit -q --allow-empty -m b && git log -1 --format=%ae", repo)
  assert.match(layered.text, /4242\+jdoe@users\.noreply/, "account values still win, but the system file is included")
  assert.equal(layered.env.GIT_CONFIG_NOSYSTEM, undefined)
  await rm(join(home, ".gitconfig"))
})

test("removing an account deletes its login and permissions", async () => {
  const h = await host()
  await h.signedIn()
  await (await h.policy()).setCells([{ entity: "work@acme", row: { agent: "*" }, capability: "push", effect: "deny" }])
  await h.call("github_account_remove", { id: "work" })
  assert.deepEqual(h.prompts.map(p => p.action), ["oc-github.remove"])
  assert.deepEqual(await (await h.vault()).list(), [])
  assert.deepEqual(Object.keys((await h.policy()).snapshot().entities), [])
})
