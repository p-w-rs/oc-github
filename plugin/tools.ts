import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { RunDir } from "oc-secure-kit"
import { addSshKey } from "./github.js"
import { CAPABILITIES, mergeAccount, normalizeAccount, orgEntity, SSH_KEY, TOKEN, validAccountId, type Account, type Discovery } from "./model.js"
import type { GitHubService } from "./service.js"

export const TOOL_NAMES = [
  "github_list", "github_account_get", "github_account_upsert", "github_account_remove", "github_signin", "github_refresh",
  "github_ssh_keygen", "github_request_token",
] as const

export interface ToolDefinition {
  readonly name: (typeof TOOL_NAMES)[number]
  readonly description: () => string
  readonly input: Record<string, unknown>
  readonly execute: (input: any, context: ToolContext) => Promise<{ content: string }>
}

export const USAGE = [
  "Use normal git and gh commands in your shell; the right account's login is supplied to that one command after a permission check (the user may be asked).",
  "The account is picked from the repository owner (remote URL, -R owner/repo, owner/repo arguments). If the plugin cannot tell, the command result says so: decide from the conversation or ask the user, then rerun with OCG_ACCOUNT=<account> in front of the command.",
  "OCG_ACCOUNT=none uses the user's own system git/gh login instead; do that only when the user asks for it.",
].join("\n")

const ACCOUNT_ID = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$", maxLength: 64, description: "Account name chosen by the user, e.g. work or personal" }
const json = (value: unknown) => ({ content: JSON.stringify(value, null, 2) })

function describe(account: Account, discovery: Discovery | undefined): string {
  const login = discovery?.login ? `login ${discovery.login}` : "not signed in"
  const orgs = discovery?.orgs?.length
    ? discovery.orgs.map(org => `${org.login}${org.sso === "authorize" ? " [needs SSO authorization by the user]" : org.sso === "ok" ? " [SSO ok]" : ""}`).join(", ")
    : "none"
  return `  ${account.id}: ${login} on ${account.host}, git over ${account.transport}${account.label ? ` (${account.label})` : ""} → orgs: ${orgs}${account.owners?.length ? `; also handles: ${account.owners.join(", ")}` : ""}`
}

export function inventory(accounts: readonly Account[], discovery: Record<string, Discovery>, autoPick: boolean): string {
  if (!accounts.length) return "No GitHub accounts are configured yet. Create one with github_account_upsert, then github_signin."
  return [
    "GitHub accounts (an account is an identity you act as; orgs are organizations that account can reach):",
    ...accounts.map(account => describe(account, discovery[account.id])),
    ...(autoPick ? [] : ["Automatic account choice is off: put OCG_ACCOUNT=<account> in front of git/gh commands to use an account."]),
  ].join("\n")
}

function run(command: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] })
    let stderr = ""
    child.stderr.on("data", chunk => { stderr += chunk })
    child.on("error", reject)
    child.on("close", code => resolve({ code, stderr }))
  })
}

export function createTools(service: GitHubService): ToolDefinition[] {
  const caller = (context: ToolContext) => ({ sessionID: context.sessionID, agent: context.agent, source: { type: "tool" as const, messageID: context.messageID, id: context.id } })
  const check = (context: ToolContext, capability: string, entity: string, metadata?: Record<string, unknown>) =>
    service.bridge.check({ ...caller(context), capability, entities: [entity], ...(metadata && { metadata }) })
  const requireAccount = async (id: string) => {
    const account = await service.store.get(id)
    if (!account) throw new Error(`No account ${JSON.stringify(id)}. Accounts: ${(await service.store.list()).map(item => item.id).join(", ") || "(none)"}`)
    return account
  }
  const signInText = (signIn: { userCode: string; verificationUri: string; expiresAt: number; status: string; error?: string }) => ({
    status: signIn.status,
    ...(signIn.status === "waiting" && {
      tellUser: `Open ${signIn.verificationUri} in a browser, sign in to GitHub (and your organization's single sign-on if asked), and enter the code ${signIn.userCode}. It expires at ${new Date(signIn.expiresAt).toLocaleTimeString()}.`,
    }),
    ...(signIn.error && { error: signIn.error }),
  })

  return [
    {
      name: "github_list",
      description: () => {
        const { accounts, discovery, settings } = service.store.cached()
        return `${inventory(accounts, discovery, settings.autoPick)}\n${USAGE}\nCall this tool for details and what you are allowed to do.`
      },
      input: { type: "object", properties: {}, additionalProperties: false },
      execute: async (_input, context) => {
        const settings = await service.store.settings()
        const accounts = await Promise.all((await service.store.list()).map(async account => {
          const discovery = await service.store.discovery(account.id)
          const signIn = service.signIns.get(account.id)
          return {
            id: account.id, ...(account.label && { label: account.label }), host: account.host, git: account.transport, login: account.auth,
            signedInAs: discovery?.login ?? null,
            orgs: (discovery?.orgs ?? []).map(org => ({ org: org.login, sso: org.sso, ...(org.role && { role: org.role }) })),
            ...(account.owners?.length && { alsoHandles: account.owners }),
            secrets: await service.secretStatus(account),
            ...(signIn?.status === "waiting" && { signIn: signInText(signIn) }),
            ...(discovery?.error && { lastError: discovery.error }),
            youMay: Object.fromEntries(await Promise.all(["read", "push", "pr", "pr-merge", "force-push", "repo-delete"].map(async capability =>
              [capability, (await service.bridge.effect({ ...caller(context), capability, entity: account.id })).effect] as const))),
          }
        }))
        return json({ accounts, autoPick: settings.autoPick, usage: USAGE })
      },
    },
    {
      name: "github_account_get",
      description: () => "One account in full: settings, who it is signed in as, its orgs (with SSO status) and what you may do (allow = just works, ask = the user is prompted, deny = not available), per org where it differs.",
      input: { type: "object", properties: { id: ACCOUNT_ID }, required: ["id"], additionalProperties: false },
      execute: async (input: { id: string }, context) => {
        const account = await requireAccount(input.id)
        const discovery = await service.store.discovery(account.id)
        const effects = async (entity: string) => Object.fromEntries(await Promise.all(CAPABILITIES.map(async capability =>
          [capability, (await service.bridge.effect({ ...caller(context), capability, entity })).effect] as const)))
        const base = await effects(account.id)
        const perOrg: Record<string, Record<string, string>> = {}
        for (const org of discovery?.orgs ?? []) {
          const own = await effects(orgEntity(account.id, org.login))
          const diff = Object.fromEntries(Object.entries(own).filter(([capability, effect]) => base[capability] !== effect))
          if (Object.keys(diff).length) perOrg[org.login] = diff
        }
        return json({
          account, signedInAs: discovery?.login ?? null, orgs: discovery?.orgs ?? [], scopes: discovery?.scopes,
          secrets: await service.secretStatus(account), permissions: base, ...(Object.keys(perOrg).length && { permissionsPerOrg: perOrg }),
          note: "The user changes permissions in the GitHub table; tools cannot.",
        })
      },
    },
    {
      name: "github_account_upsert",
      description: () => "Create or update a GitHub account (fields merge; null clears). transport: how git connects (https, ssh, none). auth: where the login comes from (browser = github_signin, token = the user enters one, none). ownerTransport overrides git transport per owner. Never pass tokens or keys here.",
      input: {
        type: "object",
        properties: {
          id: ACCOUNT_ID, rename: ACCOUNT_ID,
          label: { type: ["string", "null"] },
          host: { type: "string", description: "github.com (default) or a GitHub Enterprise Server host" },
          transport: { type: "string", enum: ["https", "ssh", "none"] },
          auth: { type: "string", enum: ["browser", "token", "none"] },
          clientId: { type: ["string", "null"], description: "OAuth app client ID for browser sign-in, if the org approved a different app than GitHub CLI's" },
          scopes: { type: ["array", "null"], items: { type: "string" } },
          sshKeyFile: { type: ["string", "null"], description: "Use an existing private key file instead of a generated one" },
          owners: { type: ["array", "null"], items: { type: "string" }, description: "Extra users/orgs this account handles" },
          ownerTransport: { type: ["object", "null"], additionalProperties: { enum: ["https", "ssh"] } },
          name: { type: ["string", "null"], description: "Commit author name (default: GitHub profile)" },
          email: { type: ["string", "null"], description: "Commit email (default: the private noreply address)" },
          useSystemGitConfig: { type: "boolean", description: "Layer the user's own git config under the account's (default false)" },
          notes: { type: ["string", "null"] },
        },
        required: ["id"],
        additionalProperties: false,
      },
      execute: async (input: Record<string, unknown> & { id: string; rename?: string }, context) => {
        const { id, rename, ...patch } = input
        validAccountId(id)
        const existing = await service.store.get(id)
        await check(context, "manage", id, { operation: existing ? "update" : "create" })
        if (rename !== undefined && !existing) throw new Error(`Cannot rename: no account ${id}`)
        const target = rename ?? id
        if (target !== id) await check(context, "manage", validAccountId(target), { operation: "rename", from: id })
        const saved = await service.store.put(normalizeAccount({ ...mergeAccount(existing, patch), id: target }), existing && target !== id ? id : undefined)
        if (existing && target !== id) {
          await service.vault.renameEntity(id, target)
          await service.policy.renameEntity(id, target)
          for (const entity of Object.keys((await service.policy.reload()).entities)) {
            if (entity.startsWith(`${id}@`)) await service.policy.renameEntity(entity, `${target}@${entity.slice(id.length + 1)}`)
          }
        }
        const secrets = await service.secretStatus(saved)
        const next: string[] = []
        if (secrets[TOKEN] === "unset") next.push(saved.auth === "browser" ? `sign in: github_signin id=${saved.id}` : `ask the user for a token: github_request_token id=${saved.id}`)
        if (secrets[SSH_KEY] === "unset") next.push(`create its SSH key: github_ssh_keygen id=${saved.id}`)
        return json({ saved, secrets, ...(next.length && { next: next.join("; then ") }) })
      },
    },
    {
      name: "github_account_remove",
      description: () => "Delete an account with its stored login, key and permission settings. Asks the user by default. Does not touch GitHub itself.",
      input: { type: "object", properties: { id: ACCOUNT_ID }, required: ["id"], additionalProperties: false },
      execute: async (input: { id: string }, context) => {
        const account = await requireAccount(input.id)
        await check(context, "remove", account.id)
        service.signIns.get(account.id)?.controller.abort()
        service.signIns.delete(account.id)
        await service.store.remove(account.id)
        await service.vault.deleteEntity(account.id)
        for (const entity of Object.keys((await service.policy.reload()).entities)) {
          if (entity === account.id || entity.startsWith(`${account.id}@`)) await service.policy.removeEntity(entity)
        }
        await service.requests.remove({ entity: account.id })
        return json({ removed: account.id })
      },
    },
    {
      name: "github_signin",
      description: () => "Start the browser sign-in for an account (auth=browser). Returns a code and a URL to give the user; it finishes in the background once the user approves (including any organization single sign-on). Use wait to block up to that many seconds for it.",
      input: { type: "object", properties: { id: ACCOUNT_ID, wait: { type: "integer", minimum: 0, maximum: 600 } }, required: ["id"], additionalProperties: false },
      execute: async (input: { id: string; wait?: number }, context) => {
        const account = await requireAccount(input.id)
        await check(context, "manage", account.id, { operation: "sign in" })
        const signIn = await service.startSignIn(account)
        const deadline = Date.now() + (input.wait ?? 0) * 1000
        while (signIn.status === "waiting" && Date.now() < deadline) {
          context.signal?.throwIfAborted()
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
        const discovery = signIn.status === "done" ? await service.store.discovery(account.id) : undefined
        return json({
          account: account.id, ...signInText(signIn),
          ...(discovery && { signedInAs: discovery.login, orgs: discovery.orgs }),
          ...(discovery?.orgs.some(org => org.sso === "authorize") && { next: "Some orgs need single sign-on authorization: give the user their authorizeUrl, then call github_refresh." }),
        })
      },
    },
    {
      name: "github_refresh",
      description: () => "Ask GitHub again who an account is and which orgs it reaches (after the user authorized single sign-on, joined an org, or changed scopes).",
      input: { type: "object", properties: { id: ACCOUNT_ID }, required: ["id"], additionalProperties: false },
      execute: async (input: { id: string }) => {
        const account = await requireAccount(input.id)
        const discovery = await service.rediscover(account)
        return json({ account: account.id, signedInAs: discovery.login ?? null, orgs: discovery.orgs, scopes: discovery.scopes, ...(discovery.error && { error: discovery.error }) })
      },
    },
    {
      name: "github_ssh_keygen",
      description: () => "Create a dedicated ed25519 SSH key for an account (stored encrypted; you never see the private key) and add it to the GitHub account (upload=true, needs a signed-in login with admin:public_key), or return the public key for the user to add.",
      input: { type: "object", properties: { id: ACCOUNT_ID, upload: { type: "boolean" } }, required: ["id"], additionalProperties: false },
      execute: async (input: { id: string; upload?: boolean }, context) => {
        const account = await requireAccount(input.id)
        await check(context, "manage", account.id, { operation: "generate SSH key" })
        const scratch = await RunDir.create(service.runBase)
        let privateKey: string, publicKey: string
        try {
          const result = await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `oc-github:${account.id}`, "-f", scratch.file("key")])
          if (result.code !== 0) throw new Error(`ssh-keygen failed: ${result.stderr.trim()}`)
          privateKey = await readFile(scratch.file("key"), "utf8")
          publicKey = (await readFile(scratch.file("key.pub"), "utf8")).trim()
        } finally { await scratch.remove() }
        let uploaded = false
        let uploadError: string | undefined
        if (input.upload ?? true) {
          const token = await service.token(account)
          if (!token) uploadError = "not signed in"
          else {
            try { await check(context, "account-settings", account.id, { operation: "add SSH key" }); await addSshKey(service.endpoints(account), token, `oc-github ${account.id} ${new Date().toISOString().slice(0, 10)}`, publicKey); uploaded = true }
            catch (error) { uploadError = (error as Error).message }
          }
        }
        await service.vault.set(account.id, SSH_KEY, privateKey)
        await service.refreshRedactor()
        return json({
          account: account.id, publicKey, uploaded,
          ...(!uploaded && { tellUser: `Add this public key to the GitHub account at https://${account.host}/settings/ssh/new${uploadError ? ` (automatic upload failed: ${uploadError})` : ""}: ${publicKey}` }),
          ...(account.transport !== "ssh" && !Object.values(account.ownerTransport ?? {}).includes("ssh") && { note: "This account does not use ssh yet; set transport=ssh or ownerTransport to use the key." }),
        })
      },
    },
    {
      name: "github_request_token",
      description: () => "Ask the user to enter a token for an account (auth=token), e.g. a fine-grained personal access token. The user enters it outside the chat; you only learn whether it is set.",
      input: { type: "object", properties: { id: ACCOUNT_ID, purpose: { type: "string", maxLength: 300 } }, required: ["id"], additionalProperties: false },
      execute: async (input: { id: string; purpose?: string }, context) => {
        const account = await requireAccount(input.id)
        await service.requests.add({ entity: account.id, name: TOKEN, purpose: input.purpose ?? "", sessionID: context.sessionID })
        return json({
          status: (await service.vault.has(account.id, TOKEN)) ? "set (the user may replace it)" : "unset",
          tellUser: `Please enter a GitHub token for ${account.id} in the GitHub view, or in a terminal in the oc-github folder: pixi run token-set ${account.id}`,
        })
      },
    },
  ]
}
