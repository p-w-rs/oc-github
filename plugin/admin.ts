import { createHash } from "node:crypto"
import { decryptBundle, diffRecords, encryptBundle, validName, type EntityPolicy, type SecretValue } from "oc-secure-kit"
import { CAPABILITIES, defaultEffect, normalizeAccount, orgEntity, REFRESH, SSH_KEY, TOKEN, validAccountId, type Account } from "./model.js"
import type { AccountView, Effect, ImportPreview, StateView } from "./rpc.js"
import { PLUGIN_ID, type GitHubService } from "./service.js"

export const BUNDLE_VERSION = 1
interface BundlePayload {
  accounts: Record<string, Account>
  settings: { autoPick: boolean }
  permissions: Record<string, EntityPolicy>
  secrets: SecretValue[]
}

/** Capability groups for the GUI's column picker. */
export const GROUPS: Record<string, readonly string[]> = {
  "Git": ["read", "push", "push-default-branch", "force-push", "delete-branch"],
  "Pull requests": ["pr", "pr-merge", "review"],
  "Issues & releases": ["issues", "releases", "actions", "packages", "gists"],
  "Repo admin": ["repo-create", "repo-delete", "repo-settings", "secrets"],
  "Org & account": ["org-admin", "account-settings", "api-other", "manage", "remove"],
}

export interface AdminDeps {
  readonly service: GitHubService
  readonly agents: () => Promise<{ id: string; name: string; mode: string }[]>
  readonly root: (sessionID: string) => Promise<string>
  readonly cost?: { N: number; r: number; p: number }
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const accountOf = (entity: string) => entity.includes("@") ? entity.slice(0, entity.indexOf("@")) : entity

/** Server side of the GUI: everything the agent may not do (permissions, tokens, export/import). */
export function createAdmin(deps: AdminDeps) {
  const { service } = deps
  const requireAccount = async (id: string) => {
    const account = await service.store.get(id)
    if (!account) throw new Error(`No account ${id}`)
    return account
  }

  async function state(input: { sessionID?: string }): Promise<StateView> {
    const [accounts, settings, requests, agents] = await Promise.all([service.store.list(), service.store.settings(), service.requests.list(), deps.agents().catch(() => [])])
    const doc = await service.policy.reload()
    const views: AccountView[] = await Promise.all(accounts.map(async account => {
      const discovery = await service.store.discovery(account.id)
      const signIn = service.signIns.get(account.id)
      const orgs = (discovery?.orgs ?? []).map(org => ({ login: org.login, sso: org.sso, ...(org.authorizeUrl && { authorizeUrl: org.authorizeUrl }), ...(org.role && { role: org.role }) }))
      const known = new Set(orgs.map(org => org.login.toLowerCase()))
      const extraScopes = [...new Set([
        ...(account.owners ?? []),
        ...Object.keys(doc.entities).filter(entity => entity.startsWith(`${account.id}@`)).map(entity => entity.slice(account.id.length + 1)),
      ])].filter(owner => !known.has(owner) && owner !== discovery?.login?.toLowerCase()).sort()
      return {
        id: account.id, ...(account.label && { label: account.label }), host: account.host, transport: account.transport, auth: account.auth,
        ...(discovery?.login && { login: discovery.login }), ...(discovery?.scopes && { scopes: discovery.scopes }),
        ...(discovery?.error && discovery.error !== "not signed in" && { error: discovery.error }), ...(discovery?.checkedAt && { checkedAt: discovery.checkedAt }),
        secrets: await service.secretStatus(account), orgs, extraScopes, owners: account.owners ?? [],
        ...(signIn && signIn.status !== "done" && signIn.expiresAt > Date.now() - 60_000 && {
          signIn: { userCode: signIn.userCode, verificationUri: signIn.verificationUri, expiresAt: signIn.expiresAt, status: signIn.status, ...(signIn.error && { error: signIn.error }) },
        }),
      }
    }))
    let session: StateView["session"]
    if (input.sessionID) {
      const root = await deps.root(input.sessionID)
      session = { root, cells: (doc.sessions[root]?.entities ?? {}) as Record<string, Record<string, Effect>> }
    }
    const labels: Record<string, string> = { token: "login", "ssh-key": "SSH key" }
    const view = {
      revision: doc.revision, autoPick: settings.autoPick, accounts: views, agents, capabilities: [...CAPABILITIES], groups: GROUPS,
      defaults: Object.fromEntries(CAPABILITIES.map(capability => [capability, defaultEffect(capability)])),
      cells: Object.fromEntries(Object.entries(doc.entities).map(([entity, policy]) => [entity, policy.agents])) as StateView["cells"],
      ...(session && { session }),
      requests: requests.filter(request => accounts.some(account => account.id === request.entity)).map(request => ({
        id: request.id, entity: request.entity, name: request.name, purpose: request.purpose, label: `${labels[request.name] ?? request.name} for ${request.entity}`,
      })),
    }
    return { ...view, fingerprint: createHash("sha256").update(JSON.stringify(view)).digest("hex").slice(0, 16) }
  }

  async function setCells(input: { expectedRevision?: number; sessionID?: string; changes: { entity: string; capability: string; effect: Effect | null; agent?: string; session?: boolean }[] }) {
    const ids = new Set((await service.store.list()).map(account => account.id))
    let root: string | undefined
    const changes = []
    for (const change of input.changes) {
      const account = accountOf(change.entity)
      if (!ids.has(account)) throw new Error(`Unknown account ${account}`)
      if (change.entity !== account) {
        const owner = change.entity.slice(account.length + 1)
        if (!OWNER.test(owner) || owner !== owner.toLowerCase()) throw new Error(`Invalid org ${owner}`)
      }
      if (!(CAPABILITIES as readonly string[]).includes(change.capability)) throw new Error(`Unknown permission ${change.capability}`)
      if (change.session) {
        if (!input.sessionID) throw new Error("A session is needed for the This session row")
        root ??= await deps.root(input.sessionID)
        changes.push({ entity: change.entity, capability: change.capability, effect: change.effect, row: { session: root } })
      } else {
        if (!change.agent) throw new Error("agent is required")
        changes.push({ entity: change.entity, capability: change.capability, effect: change.effect, row: { agent: change.agent } })
      }
    }
    await service.policy.setCells(changes, input.expectedRevision)
    return state({ ...(input.sessionID && { sessionID: input.sessionID }) })
  }

  async function createAccount(input: { id: string; transport?: "https" | "ssh" | "none"; auth?: "browser" | "token" | "none"; host?: string }) {
    validAccountId(input.id)
    if (await service.store.get(input.id)) throw new Error(`Account ${input.id} already exists`)
    const account = await service.store.put(normalizeAccount({ id: input.id, ...(input.host && { host: input.host }), transport: input.transport ?? "https", auth: input.auth ?? "browser" }))
    return { created: account.id }
  }

  async function removeAccount(input: { id: string }) {
    const account = await requireAccount(input.id)
    service.signIns.get(account.id)?.controller.abort()
    service.signIns.delete(account.id)
    await service.store.remove(account.id)
    await service.vault.deleteEntity(account.id)
    for (const entity of Object.keys((await service.policy.reload()).entities)) if (accountOf(entity) === account.id) await service.policy.removeEntity(entity)
    await service.requests.remove({ entity: account.id })
    return { removed: account.id }
  }

  async function signIn(input: { id: string }) {
    const started = await service.startSignIn(await requireAccount(input.id))
    return { userCode: started.userCode, verificationUri: started.verificationUri, expiresAt: started.expiresAt }
  }

  async function cancelSignIn(input: { id: string }) {
    const running = service.signIns.get(input.id)
    running?.controller.abort()
    service.signIns.delete(input.id)
    return { cancelled: !!running }
  }

  async function refresh(input: { id: string }) {
    const discovery = await service.rediscover(await requireAccount(input.id))
    return { login: discovery.login ?? null, orgs: discovery.orgs.length, ...(discovery.error && { error: discovery.error }) }
  }

  async function setToken(input: { id: string; token: string }) {
    const account = await requireAccount(input.id)
    const discovery = await service.saveGrant(account, { token: input.token.trim() })
    return { login: discovery.login ?? null, ...(discovery.error && { error: discovery.error }) }
  }

  async function signOut(input: { id: string }) {
    const account = await requireAccount(input.id)
    await service.vault.delete(account.id, TOKEN)
    await service.vault.delete(account.id, REFRESH)
    await service.store.setDiscovery(account.id, undefined)
    await service.refreshRedactor()
    return { signedOut: account.id }
  }

  async function exportBundle(input: { passphrase: string }) {
    const { accounts, settings } = await service.store.exportAll()
    const ids = Object.keys(accounts)
    const entities = Object.keys((await service.policy.reload()).entities).filter(entity => ids.includes(accountOf(entity)))
    const payload: BundlePayload = {
      accounts, settings,
      permissions: await service.policy.exportEntities(entities),
      secrets: (await service.vault.values()).filter(item => ids.includes(item.entity)),
    }
    const content = await encryptBundle({ plugin: PLUGIN_ID, schemaVersion: BUNDLE_VERSION, payload }, input.passphrase, deps.cost ? { cost: deps.cost } : {})
    return { name: `oc-github-${new Date().toISOString().slice(0, 10)}.ocbundle`, content, counts: { accounts: ids.length, secrets: payload.secrets.length } }
  }

  async function open(content: string, passphrase: string) {
    const { payload: raw, header } = await decryptBundle<BundlePayload>(content, passphrase, { plugin: PLUGIN_ID, currentVersion: BUNDLE_VERSION })
    if (!raw || typeof raw !== "object" || !raw.accounts || typeof raw.accounts !== "object") throw new Error("Invalid bundle contents")
    const accounts = Object.fromEntries(Object.values(raw.accounts).map(item => { const account = normalizeAccount(item, new Date(item.updatedAt ?? Date.now())); return [account.id, account] }))
    const permissions = (raw.permissions ?? {}) as Record<string, EntityPolicy>
    for (const entity of Object.keys(permissions)) if (!accounts[accountOf(entity)]) throw new Error(`Bundle has permissions for unknown ${entity}`)
    if (!Array.isArray(raw.secrets)) throw new Error("Invalid secrets")
    const secrets = raw.secrets.map(item => {
      if (!accounts[item?.entity] || ![TOKEN, REFRESH, SSH_KEY].includes(item?.name) || typeof item.value !== "string" || !item.value) throw new Error(`Bundle has an unexpected secret for ${item?.entity}`)
      validName("account", item.entity)
      return { entity: item.entity, name: item.name, value: item.value }
    })
    return { payload: { accounts, settings: { autoPick: raw.settings?.autoPick !== false }, permissions, secrets }, createdAt: header.createdAt }
  }

  async function previewImport(input: { content: string; passphrase: string }): Promise<ImportPreview> {
    const { payload, createdAt } = await open(input.content, input.passphrase)
    const current = await service.store.exportAll()
    const strip = (items: Record<string, Account>) => Object.fromEntries(Object.entries(items).map(([id, { updatedAt: _, ...rest }]) => [id, rest]))
    return { createdAt, accounts: diffRecords(strip(current.accounts), strip(payload.accounts)), secrets: payload.secrets.length, permissionEntities: Object.keys(payload.permissions).length }
  }

  async function applyImport(input: { content: string; passphrase: string; mode: "merge" | "replace" }) {
    const { payload } = await open(input.content, input.passphrase)
    if (input.mode === "replace") {
      for (const account of await service.store.list()) {
        await service.vault.deleteEntity(account.id)
        for (const entity of Object.keys((await service.policy.reload()).entities)) if (accountOf(entity) === account.id) await service.policy.removeEntity(entity)
      }
    }
    await service.store.importAll({ accounts: payload.accounts, settings: payload.settings }, input.mode === "replace")
    await service.vault.importValues(payload.secrets, [...new Set(payload.secrets.map(item => item.entity))])
    await service.policy.importEntities(payload.permissions)
    await service.refreshRedactor()
    // Who each account is and its orgs are learned again on this install, in the background.
    for (const account of Object.values(payload.accounts)) if (payload.secrets.some(item => item.entity === account.id && item.name === TOKEN)) void service.rediscover(account).catch(() => {})
    return { imported: { accounts: Object.keys(payload.accounts).length, secrets: payload.secrets.length }, mode: input.mode }
  }

  return {
    state, setCells, createAccount, removeAccount, signIn, cancelSignIn, refresh, setToken, signOut, exportBundle, previewImport, applyImport,
    dismissRequest: async (input: { id: string }) => ({ dismissed: await service.requests.remove({ id: input.id }) }),
    setAutoPick: async (input: { autoPick: boolean }) => ({ autoPick: (await service.store.setSettings({ autoPick: input.autoPick })).autoPick }),
  }
}
export type Admin = ReturnType<typeof createAdmin>
export { orgEntity }
