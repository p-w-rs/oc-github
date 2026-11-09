import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PermissionBridge, StaleRevisionError } from "oc-secure-kit"
import { createAdmin } from "./admin.js"
import { defaultEffect, normalizeAccount, parentEntity } from "./model.js"
import { inherited } from "./rpc.js"
import { GitHubService, PLUGIN_ID } from "./service.js"
import { startFakeGitHub, type FakeGitHub } from "./testgithub.js"

const TOKEN = "gho_adminTestToken_abcdef0123456789"
const PASS = "export passphrase 123"
const dirs: string[] = []
let github: FakeGitHub
before(async () => { github = await startFakeGitHub({ login: "jdoe", token: TOKEN, orgs: ["acme"], ssoBlocked: ["locked-org"] }) })
after(async () => { await github.stop(); await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))) })

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "ocg-admin-"))
  dirs.push(dir)
  const service = await GitHubService.open(dir, host => host === github.host ? { web: github.web, api: github.api } : undefined)
  const root = async (id: string) => id === "child" ? "root" : id
  service.attach(new PermissionBridge({ plugin: PLUGIN_ID, policy: service.policy, fallback: defaultEffect, parent: parentEntity, root }))
  const admin = createAdmin({ service, root, cost: { N: 2 ** 12, r: 8, p: 1 }, agents: async () => [{ id: "build", name: "build", mode: "primary" }] })
  return { service, admin }
}
const until = async (check: () => Promise<boolean>) => { for (let i = 0; i < 100 && !(await check()); i++) await new Promise(r => setTimeout(r, 50)) }

test("create, sign in from the GUI, see orgs with SSO status; never expose the token", async () => {
  const { admin, service } = await setup()
  await admin.createAccount({ id: "work", host: github.host })
  const started = await admin.signIn({ id: "work" })
  assert.equal(started.userCode, "ABCD-1234")
  let state = await admin.state({ sessionID: "child" })
  assert.equal(state.accounts[0]!.signIn?.status, "waiting")
  github.approve()
  await until(async () => (await admin.state({})).accounts[0]!.login === "jdoe")
  state = await admin.state({ sessionID: "child" })
  const work = state.accounts[0]!
  assert.equal(work.signIn, undefined, "code box disappears once done")
  assert.deepEqual(work.orgs.map(org => [org.login, org.sso, !!org.authorizeUrl]), [["acme", "none", false], ["locked-org", "authorize", true]])
  assert.deepEqual(work.secrets, { token: "set" })
  assert.doesNotMatch(JSON.stringify(state), new RegExp(TOKEN))
  assert.equal(state.session?.root, "root")
  assert.deepEqual(Object.keys(state.groups), ["Git", "Pull requests", "Issues & releases", "Repo admin", "Org & account"])
  await admin.signOut({ id: "work" })
  assert.equal(await service.vault.has("work", "token"), false)
  assert.equal((await admin.state({})).accounts[0]!.login, undefined)
})

test("cells: account rows, org rows inheriting from the account, session rows, stale edits", async () => {
  const { admin, service } = await setup()
  await admin.createAccount({ id: "work", host: github.host })
  let state = await admin.state({})
  state = await admin.setCells({ expectedRevision: state.revision, changes: [
    { entity: "work", capability: "pr-merge", effect: "ask", agent: "*" },
    { entity: "work@acme", capability: "push", effect: "deny", agent: "build" },
  ] })
  assert.equal(inherited(state, "work@acme", "pr-merge", "build"), "ask", "org row inherits from the account")
  assert.equal(inherited(state, "work@acme", "push", "build"), "deny")
  assert.equal(inherited(state, "work", "push", "build"), "allow")
  assert.equal(inherited(state, "work", "force-push", "*"), "ask", "default")
  assert.equal((await service.bridge.effect({ sessionID: "x", agent: "build", capability: "pr-merge", entity: "work@acme" })).effect, "ask", "the GUI shows what the bridge enforces")
  await assert.rejects(admin.setCells({ expectedRevision: 0, changes: [{ entity: "work", capability: "push", effect: "deny", agent: "*" }] }), StaleRevisionError)
  await assert.rejects(admin.setCells({ changes: [{ entity: "nobody", capability: "push", effect: "deny", agent: "*" }] }), /Unknown account/)
  await assert.rejects(admin.setCells({ changes: [{ entity: "work@Bad Org", capability: "push", effect: "deny", agent: "*" }] }), /Invalid org/)
  await assert.rejects(admin.setCells({ changes: [{ entity: "work", capability: "fly", effect: "deny", agent: "*" }] }), /Unknown permission/)
  const session = await admin.setCells({ sessionID: "child", changes: [{ entity: "work", capability: "push", effect: "deny", session: true }] })
  assert.deepEqual(session.session?.cells, { work: { push: "deny" } })
  assert.deepEqual((await admin.state({})).accounts[0]!.extraScopes, ["acme"], "org rows without discovery still show up")
})

test("tokens from the GUI, requests and auto-pick", async () => {
  const { admin, service } = await setup()
  await service.store.put(normalizeAccount({ id: "bot", host: github.host, auth: "token" }))
  await service.requests.add({ entity: "bot", name: "token", purpose: "CI bot" })
  assert.deepEqual((await admin.state({})).requests.map(request => request.label), ["login for bot"])
  assert.deepEqual(await admin.setToken({ id: "bot", token: `  ${TOKEN} ` }), { login: "jdoe" })
  assert.deepEqual((await admin.state({})).requests, [])
  assert.equal(service.redactor.redact(`x ${TOKEN}`), "x [REDACTED:bot/token]")
  assert.match((await admin.setToken({ id: "bot", token: "bad-token-123" })).error ?? "", /Bad credentials/)
  assert.equal((await admin.setAutoPick({ autoPick: false })).autoPick, false)
  assert.equal((await admin.state({})).autoPick, false)
})

test("export on one install, preview and import on another", async () => {
  const a = await setup()
  await a.admin.createAccount({ id: "work", host: github.host })
  await a.service.saveGrant((await a.service.store.get("work"))!, { token: TOKEN })
  await a.service.vault.set("work", "ssh-key", "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n")
  await a.service.policy.setCells([
    { entity: "work@acme", row: { agent: "build" }, capability: "push", effect: "deny" },
    { entity: "work", row: { session: "root" }, capability: "push", effect: "deny" },
  ])
  const exported = await a.admin.exportBundle({ passphrase: PASS })
  assert.deepEqual(exported.counts, { accounts: 1, secrets: 2 })
  assert.doesNotMatch(exported.content, new RegExp(TOKEN))

  const b = await setup()
  await b.admin.createAccount({ id: "personal", host: github.host, transport: "ssh" })
  await assert.rejects(b.admin.previewImport({ content: exported.content, passphrase: "wrong passphrase" }), /Wrong passphrase/)
  const preview = await b.admin.previewImport({ content: exported.content, passphrase: PASS })
  assert.deepEqual(preview.accounts, [{ id: "personal", status: "local-only" }, { id: "work", status: "added" }])
  await b.admin.applyImport({ content: exported.content, passphrase: PASS, mode: "merge" })
  await until(async () => (await b.admin.state({})).accounts.find(account => account.id === "work")?.login === "jdoe")
  const state = await b.admin.state({ sessionID: "root" })
  assert.deepEqual(state.accounts.map(account => account.id), ["personal", "work"])
  assert.equal(state.accounts.find(account => account.id === "work")!.orgs.length, 2, "orgs rediscovered after import")
  assert.equal(inherited(state, "work@acme", "push", "build"), "deny", "agent rows travel")
  assert.deepEqual(state.session?.cells, {}, "session overrides do not")
  assert.equal(await b.service.vault.get("work", "token"), TOKEN)
  await b.admin.applyImport({ content: exported.content, passphrase: PASS, mode: "replace" })
  assert.deepEqual((await b.admin.state({})).accounts.map(account => account.id), ["work"])
})
