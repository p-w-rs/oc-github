import { validName } from "oc-secure-kit"

export const ACCOUNTS_FORMAT = "oc-github-accounts/1"

export type Transport = "https" | "ssh" | "none"
export type Auth = "browser" | "token" | "none"

/** The GitHub CLI's public OAuth app. Many SSO orgs already allow it; replace per account if yours approved another. */
export const DEFAULT_CLIENT_ID = "178c6fc778ccc68e1d6a"
export const DEFAULT_SCOPES = ["repo", "workflow", "read:org", "gist", "delete_repo", "admin:public_key", "read:packages", "write:packages", "project", "user:email"]

/** A GitHub identity the plugin signs in as. Everything here is non-secret; tokens and keys live in the vault. */
export interface Account {
  readonly id: string
  readonly label?: string
  /** github.com or a GitHub Enterprise Server host. */
  readonly host: string
  /** How git talks to the host. */
  readonly transport: Transport
  /** Where the API / HTTPS login comes from. */
  readonly auth: Auth
  /** OAuth app for browser sign-in (default: GitHub CLI's). */
  readonly clientId?: string
  readonly scopes?: readonly string[]
  /** For ssh: a key file instead of a plugin-generated key. */
  readonly sshKeyFile?: string
  /** Extra owners (users/orgs) this account handles, beyond its own login and the orgs GitHub reports. */
  readonly owners?: readonly string[]
  /** Per-owner transport overrides, e.g. { "p-w-rs": "ssh" }. */
  readonly ownerTransport?: Readonly<Record<string, "https" | "ssh">>
  /** Commit identity; defaults come from the GitHub profile after sign-in. */
  readonly name?: string
  readonly email?: string
  /** Layer the user's own git config under the account's settings. Off: the plugin ignores system/global git config. */
  readonly useSystemGitConfig?: boolean
  readonly notes?: string
  readonly updatedAt: string
}

/** What the plugin learned from GitHub. Rediscovered; never exported. */
export interface Discovery {
  readonly login?: string
  readonly userId?: number
  readonly name?: string
  readonly noreplyEmail?: string
  readonly scopes?: readonly string[]
  readonly orgs: readonly OrgInfo[]
  readonly checkedAt?: string
  readonly error?: string
  /** When the stored token expires (expiring GitHub App tokens only). */
  readonly tokenExpiresAt?: number
}
export interface OrgInfo {
  readonly login: string
  readonly id?: number
  /** ok: usable; authorize: the token needs SSO authorization for this org (see authorizeUrl); none: no SSO. */
  readonly sso: "ok" | "authorize" | "none"
  readonly authorizeUrl?: string
  readonly role?: string
}

export const CAPABILITIES = [
  "read", "push", "push-default-branch", "force-push", "delete-branch", "pr", "pr-merge", "review", "issues", "releases",
  "actions", "repo-create", "repo-delete", "repo-settings", "secrets", "org-admin", "account-settings", "gists", "packages", "api-other",
  "manage", "remove",
] as const
export type Capability = (typeof CAPABILITIES)[number]
const RISKY = new Set<string>(["force-push", "repo-delete", "repo-settings", "secrets", "org-admin", "api-other", "remove"])
/** Starting point only; users change it in the table (the Any agent row). */
export function defaultEffect(capability: string): "allow" | "ask" {
  return RISKY.has(capability) ? "ask" : "allow"
}

/** Permission entities: an account, or `account@org` whose unset cells inherit from the account. */
export const orgEntity = (account: string, org: string) => `${account}@${org.toLowerCase()}`
export const parentEntity = (entity: string) => entity.includes("@") ? entity.slice(0, entity.indexOf("@")) : undefined

/** Vault secret names (entity = account id). */
export const TOKEN = "token"
export const REFRESH = "refresh-token"
export const SSH_KEY = "ssh-key"

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+(?::\d{1,5})?$/
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const CONTROL = /[\u0000-\u001f\u007f]/
const fail = (message: string): never => { throw new Error(message) }
const text = (value: unknown, field: string, max: number): string | undefined => {
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string" || value.length > max || CONTROL.test(value)) fail(`${field} must be a single-line string up to ${max} characters`)
  return value as string
}

export function validAccountId(id: unknown): string {
  if (typeof id !== "string" || !ID.test(id)) return fail(`account id ${JSON.stringify(id)} must be 1-64 letters, digits, '.', '_' or '-'`)
  if (id === "none") fail(`"none" is reserved (OCG_ACCOUNT=none means: use the system git)`)
  return validName("account", id)
}

export function normalizeAccount(input: unknown, now = new Date()): Account {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("account must be an object")
  const raw = input as Record<string, unknown>
  const known = ["id", "label", "host", "transport", "auth", "clientId", "scopes", "sshKeyFile", "owners", "ownerTransport", "name", "email", "useSystemGitConfig", "notes", "updatedAt"]
  for (const key of Object.keys(raw)) if (!known.includes(key)) fail(`Unknown account field ${JSON.stringify(key)}`)
  const id = validAccountId(raw.id)
  const host = (text(raw.host, "host", 253) ?? "github.com").toLowerCase()
  if (!HOST.test(host)) fail(`host ${JSON.stringify(host)} is not a hostname`)
  const transport = (raw.transport ?? "https") as Transport
  if (!["https", "ssh", "none"].includes(transport)) fail("transport must be https, ssh or none")
  const auth = (raw.auth ?? "browser") as Auth
  if (!["browser", "token", "none"].includes(auth)) fail("auth must be browser, token or none")
  if (transport === "https" && auth === "none") fail("https needs a login: set auth to browser or token")
  const clientId = text(raw.clientId, "clientId", 100)
  if (clientId !== undefined && !/^[A-Za-z0-9._-]+$/.test(clientId)) fail("clientId is not an OAuth client ID")
  let scopes: string[] | undefined
  if (raw.scopes !== undefined && raw.scopes !== null) {
    if (!Array.isArray(raw.scopes) || raw.scopes.length > 40 || raw.scopes.some(scope => typeof scope !== "string" || !/^[a-z_:]+$/.test(scope))) fail("scopes must be a list of OAuth scope names")
    scopes = [...new Set(raw.scopes as string[])]
  }
  const sshKeyFile = text(raw.sshKeyFile, "sshKeyFile", 1024)
  if (sshKeyFile !== undefined && transport !== "ssh" && !raw.ownerTransport) fail("sshKeyFile only applies to ssh")
  let owners: string[] | undefined
  if (raw.owners !== undefined && raw.owners !== null) {
    if (!Array.isArray(raw.owners) || raw.owners.length > 100 || raw.owners.some(owner => typeof owner !== "string" || !OWNER.test(owner))) fail("owners must be a list of GitHub user/org names")
    owners = [...new Set((raw.owners as string[]).map(owner => owner.toLowerCase()))]
  }
  let ownerTransport: Record<string, "https" | "ssh"> | undefined
  if (raw.ownerTransport !== undefined && raw.ownerTransport !== null) {
    if (typeof raw.ownerTransport !== "object" || Array.isArray(raw.ownerTransport)) fail("ownerTransport must map owner -> https|ssh")
    ownerTransport = {}
    for (const [owner, value] of Object.entries(raw.ownerTransport as Record<string, unknown>)) {
      if (!OWNER.test(owner)) fail(`ownerTransport: ${JSON.stringify(owner)} is not a GitHub owner name`)
      if (value !== "https" && value !== "ssh") fail(`ownerTransport.${owner} must be https or ssh`)
      if (value === "https" && auth === "none") fail(`ownerTransport.${owner}: https needs a login`)
      ownerTransport[owner.toLowerCase()] = value as "https" | "ssh"
    }
  }
  const name = text(raw.name, "name", 200)
  const email = text(raw.email, "email", 254)
  if (email !== undefined && !/^[^\s@]+@[^\s@]+$/.test(email)) fail("email is not an email address")
  if (raw.useSystemGitConfig !== undefined && typeof raw.useSystemGitConfig !== "boolean") fail("useSystemGitConfig must be true or false")
  const label = text(raw.label, "label", 120)
  const notes = typeof raw.notes === "string" && raw.notes.length <= 4000 ? raw.notes : raw.notes == null ? undefined : fail("notes must be text up to 4000 characters")
  return {
    id, host, transport, auth,
    ...(label && { label }), ...(clientId && { clientId }), ...(scopes && { scopes }), ...(sshKeyFile && { sshKeyFile }),
    ...(owners?.length && { owners }), ...(ownerTransport && Object.keys(ownerTransport).length && { ownerTransport }),
    ...(name && { name }), ...(email && { email }), ...(raw.useSystemGitConfig === true && { useSystemGitConfig: true }),
    ...(notes && { notes }), updatedAt: now.toISOString(),
  }
}

/** Merges a partial update: fields merge, null clears. */
export function mergeAccount(existing: Account | undefined, patch: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = existing ? { ...existing } : {}
  delete base.updatedAt
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete base[key]
    else base[key] = value
  }
  return base
}

/** Which transport git uses for a repo owner on this account. */
export function transportFor(account: Account, owner: string | undefined): Transport {
  return (owner && account.ownerTransport?.[owner.toLowerCase()]) || account.transport
}

/** Secrets an account needs, for status display. */
export function secretSlots(account: Account): string[] {
  const slots: string[] = []
  if (account.auth !== "none") slots.push(TOKEN)
  const usesSsh = account.transport === "ssh" || Object.values(account.ownerTransport ?? {}).includes("ssh")
  if (usesSsh && !account.sshKeyFile) slots.push(SSH_KEY)
  return slots
}
