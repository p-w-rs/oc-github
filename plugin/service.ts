import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { access } from "node:fs/promises"
import { PolicyStore, Redactor, RunDir, SecretRequests, Vault, type PermissionBridge, type ShellCaller, type Supply } from "oc-secure-kit"
import { ghNeed, gitNeed, invocations, parseRemote, type Invocation, type RepoRef } from "./commands.js"
import { discover, endpoints, pollDeviceFlow, refreshToken, startDeviceFlow, type DeviceCode, type Endpoints } from "./github.js"
import {
  DEFAULT_CLIENT_ID, DEFAULT_SCOPES, orgEntity, REFRESH, secretSlots, SSH_KEY, TOKEN, transportFor, type Account, type Discovery,
} from "./model.js"
import { readRepo } from "./repo.js"
import { AccountStore } from "./store.js"

export const PLUGIN_ID = "oc-github"

export interface SignIn {
  readonly account: string
  readonly userCode: string
  readonly verificationUri: string
  readonly expiresAt: number
  status: "waiting" | "done" | "failed"
  error?: string
  readonly controller: AbortController
}

/** One account matched to a command, with the permission entities and capabilities it needs. */
interface Plan {
  readonly account: Account
  readonly checks: { entity: string; capability: string }[]
  readonly network: boolean
  readonly gh: boolean
  readonly owner?: string
}
type Choice = { account: Account; owner?: string } | { ambiguous: string } | { none: true }

const gitQuote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

/** Accounts, vault, permission table and sign-in state of one plugin data directory. */
export class GitHubService {
  readonly redactor = new Redactor()
  readonly runBase: string
  readonly knownHosts: string
  readonly signIns = new Map<string, SignIn>()
  #bridge?: PermissionBridge
  #redactorStale = false

  private constructor(
    readonly dir: string,
    readonly store: AccountStore,
    readonly vault: Vault,
    readonly policy: PolicyStore,
    readonly requests: SecretRequests,
    readonly endpointOverride?: (host: string) => Endpoints | undefined,
  ) {
    this.runBase = join(dir, "run")
    this.knownHosts = join(dir, "known_hosts")
  }

  static async open(dir: string, endpointOverride?: (host: string) => Endpoints | undefined): Promise<GitHubService> {
    const [store, vault, policy, requests] = await Promise.all([AccountStore.open(dir), Vault.open({ dir, plugin: PLUGIN_ID }), PolicyStore.open(dir), SecretRequests.open(dir)])
    const service = new GitHubService(dir, store, vault, policy, requests, endpointOverride)
    await service.refreshRedactor()
    vault.onChange(() => { service.#redactorStale = true })
    await RunDir.sweep(service.runBase)
    return service
  }

  attach(bridge: PermissionBridge): void { this.#bridge = bridge }
  get bridge(): PermissionBridge {
    if (!this.#bridge) throw new Error(`${PLUGIN_ID}: permissions are not set up`)
    return this.#bridge
  }
  endpoints(account: Account): Endpoints { return endpoints(account.host, this.endpointOverride) }

  // ---------------------------------------------------------------- accounts and orgs

  /** Owners (lowercase) an account handles: its login, discovered orgs, and configured extra owners. */
  ownersOf(account: Account, discovery: Discovery | undefined): Set<string> {
    return new Set([discovery?.login, ...(discovery?.orgs ?? []).map(org => org.login), ...(account.owners ?? [])].filter(Boolean).map(owner => owner!.toLowerCase()))
  }

  /** Picks the account for a target. Explicit `OCG_ACCOUNT` wins; `none` means the system git. */
  async choose(explicit: string | undefined, ref: Partial<RepoRef> | undefined): Promise<Choice> {
    const accounts = await this.store.list()
    if (explicit === "none") return { none: true }
    if (explicit) {
      const account = accounts.find(item => item.id === explicit)
      return account ? { account, ...(ref?.owner && { owner: ref.owner }) } : { ambiguous: `OCG_ACCOUNT=${explicit} is not an account. Accounts: ${accounts.map(item => item.id).join(", ") || "(none)"}.` }
    }
    if (!(await this.store.settings()).autoPick) return { none: true }
    const host = ref?.host ?? "github.com"
    const onHost = accounts.filter(account => account.host === host)
    if (ref?.owner) {
      const owner = ref.owner.toLowerCase()
      const matches: { account: Account; own: boolean }[] = []
      for (const account of onHost) {
        const discovery = await this.store.discovery(account.id)
        if (this.ownersOf(account, discovery).has(owner)) matches.push({ account, own: discovery?.login?.toLowerCase() === owner })
      }
      if (matches.length === 1) return { account: matches[0]!.account, owner: ref.owner }
      const own = matches.filter(match => match.own)
      if (own.length === 1) return { account: own[0]!.account, owner: ref.owner }
      if (matches.length > 1) return { ambiguous: `${ref.owner} is reachable from several accounts (${matches.map(match => match.account.id).join(", ")}).` }
      return { none: true }
    }
    const usable = onHost.filter(account => account.auth !== "none")
    if (usable.length === 1) return { account: usable[0]! }
    if (usable.length > 1) return { ambiguous: `The command does not say which account (${usable.map(account => account.id).join(", ")}).` }
    return { none: true }
  }

  async #refFor(invocation: Invocation, target: string | undefined): Promise<{ ref?: RepoRef; remote?: string; repo?: Awaited<ReturnType<typeof readRepo>> }> {
    if (target?.startsWith("url:")) { const ref = parseRemote(target.slice(4)); return ref ? { ref } : {} }
    const repo = await readRepo(invocation.cwd)
    if (!repo) return {}
    const wanted = target?.startsWith("remote:") ? target.slice(7) : ""
    const name = wanted || repo.upstreamRemote || (repo.remotes.origin ? "origin" : Object.keys(repo.remotes)[0])
    const url = name ? repo.remotes[name] : undefined
    const ref = url ? parseRemote(url) : undefined
    return { ...(ref && { ref }), ...(name && { remote: name }), repo }
  }

  /** Decides account and permission checks for every git/gh invocation in a command. */
  async plan(command: string, cwd: string): Promise<{ plan?: Plan; note?: string; isolate?: boolean } | undefined> {
    const found = invocations(command, cwd, homedir())
    if (!found.length) return undefined
    const plans: Plan[] = []
    for (const invocation of found) {
      let choice: Choice
      const checks: { capability: string; owner?: string }[] = []
      let network = false, gh = false
      if (invocation.tool === "git") {
        const need = gitNeed(invocation.args)
        if (!need) continue
        const { ref, remote, repo } = await this.#refFor(invocation, need.target)
        // Purely local identity commands outside a known repo stay with the system git.
        if (!ref && !invocation.account) continue
        choice = await this.choose(invocation.account, ref)
        network = need.network
        if ("account" in choice) {
          for (const capability of need.capabilities) checks.push({ capability, ...(ref?.owner && { owner: ref.owner }) })
          if (need.pushTo?.length && repo && remote) {
            const defaultBranch = await repo.defaultBranch(remote)
            const targets = need.pushTo.map(branch => branch === "HEAD" ? repo.branch : branch)
            const isDefault = (branch?: string) => branch === "*" || (defaultBranch ? branch === defaultBranch : branch === "main" || branch === "master")
            if (targets.some(isDefault)) checks.push({ capability: "push-default-branch", ...(ref?.owner && { owner: ref.owner }) })
          }
        }
      } else {
        const host = undefined
        const need = ghNeed(invocation.args, host)
        if (need.skip) continue
        gh = true
        network = true
        let ref: Partial<RepoRef> | undefined = need.target
        if (!ref && need.usesRepo) ref = (await this.#refFor(invocation, undefined)).ref
        choice = await this.choose(invocation.account, ref)
        checks.push({ capability: need.capability, ...(ref?.owner && { owner: ref.owner }) })
      }
      if ("none" in choice) continue
      if ("ambiguous" in choice) return { note: `${choice.ambiguous} Nothing was supplied. Use the conversation to decide, or ask the user, then rerun with OCG_ACCOUNT=<account> (or OCG_ACCOUNT=none for the system git).`, isolate: true }
      const discovery = await this.store.discovery(choice.account.id)
      const orgs = new Set((discovery?.orgs ?? []).map(org => org.login.toLowerCase()))
      plans.push({
        account: choice.account, network, gh, ...(choice.owner && { owner: choice.owner }),
        checks: checks.map(check => ({ capability: check.capability, entity: check.owner && orgs.has(check.owner.toLowerCase()) ? orgEntity(choice.account.id, check.owner) : choice.account.id })),
      })
    }
    if (!plans.length) return undefined
    const ids = new Set(plans.map(plan => plan.account.id))
    if (ids.size > 1) return { note: `This command uses several accounts (${[...ids].join(", ")}). Use one account per command (OCG_ACCOUNT=<account>).`, isolate: true }
    return {
      plan: {
        account: plans[0]!.account, network: plans.some(plan => plan.network), gh: plans.some(plan => plan.gh),
        ...(plans.find(plan => plan.owner)?.owner && { owner: plans.find(plan => plan.owner)!.owner }),
        checks: plans.flatMap(plan => plan.checks).filter((check, index, all) => all.findIndex(other => other.entity === check.entity && other.capability === check.capability) === index),
      },
    }
  }

  // ---------------------------------------------------------------- per-command supply

  async prepareCommand(command: string, caller: ShellCaller & { cwd: string }): Promise<Supply | undefined> {
    const decided = await this.plan(command, caller.cwd)
    if (!decided) return undefined
    if (!decided.plan) return this.#isolated([decided.note!])
    const { plan } = decided
    const notes: string[] = []
    const metadata = { command: command.length > 500 ? `${command.slice(0, 500)}…` : command, account: plan.account.id }
    // One prompt for everything that asks; denied cells are reported without asking.
    const effects = await Promise.all(plan.checks.map(async check => ({ ...check, effect: (await this.bridge.effect({ sessionID: caller.sessionID, agent: caller.agent, capability: check.capability, entity: check.entity })).effect })))
    const denied = effects.filter(check => check.effect === "deny")
    if (denied.length) {
      return this.#isolated([`${denied.map(check => `${check.capability} on ${check.entity}`).join(", ")}: denied by the GitHub permissions table. The command ran without GitHub credentials. The user can change the table; to use their own system git login instead they must ask for OCG_ACCOUNT=none.`])
    }
    for (const effect of ["allow", "ask"] as const) {
      const group = effects.filter(check => check.effect === effect)
      for (const capability of new Set(group.map(check => check.capability))) {
        const entities = [...new Set(group.filter(check => check.capability === capability).map(check => check.entity))]
        try { await this.bridge.check({ sessionID: caller.sessionID, ...(caller.agent && { agent: caller.agent }), ...(caller.source && { source: caller.source }), capability, entities, metadata }) }
        catch (error) {
          return this.#isolated([`${capability} on ${entities.join(", ")}: not granted (${(error as Error).message.split("\n")[0]}). The command ran without GitHub credentials.`])
        }
      }
    }
    return this.#supply(plan, notes)
  }

  /** Credentials removed for this command: no git/gh login, no prompts. Used when denied or the account is unclear. */
  async #isolated(notes: string[]): Promise<Supply> {
    const runDir = await RunDir.create(this.runBase)
    const config = await runDir.write("gitconfig", "[credential]\n\thelper =\n")
    await runDir.write("gh/config.yml", "prompt: disabled\n")
    return {
      env: {
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: config, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never",
        GIT_SSH_COMMAND: "ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none -o IdentityFile=/dev/null",
        GH_TOKEN: "", GH_ENTERPRISE_TOKEN: "", GH_CONFIG_DIR: runDir.file("gh"), GH_PROMPT_DISABLED: "1", SSH_AUTH_SOCK: "",
      },
      notes, secrets: false, runDir,
    }
  }

  async #supply(plan: Plan, notes: string[]): Promise<Supply> {
    const { account } = plan
    const discovery = await this.store.discovery(account.id)
    const runDir = await RunDir.create(this.runBase)
    const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }
    let secrets = false
    try {
      const transport = transportFor(account, plan.owner)
      const usesSsh = account.transport === "ssh" || Object.values(account.ownerTransport ?? {}).includes("ssh")
      let token: string | undefined
      if (account.auth !== "none" && (plan.network || plan.gh)) {
        token = await this.token(account)
        if (!token) notes.push(`${account.id} is not signed in yet: call github_signin account=${account.id}${account.auth === "token" ? ` (or ask the user to enter a token: github_request_token)` : ""}.`)
      }
      // git settings: the account's own file. The system/global git config is ignored unless the account layers it.
      const lines: string[] = []
      if (account.useSystemGitConfig) {
        const home = homedir()
        for (const path of [join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "git", "config"), join(home, ".gitconfig")]) {
          if (await access(path).then(() => true, () => false)) lines.push("[include]", `\tpath = ${gitQuote(path)}`)
        }
      } else env.GIT_CONFIG_NOSYSTEM = "1"
      const name = account.name ?? discovery?.name ?? discovery?.login
      const email = account.email ?? discovery?.noreplyEmail
      if (name || email) lines.push("[user]", ...(name ? [`\tname = ${gitQuote(name)}`] : []), ...(email ? [`\temail = ${gitQuote(email)}`] : []))
      const host = account.host
      // Keyed on the host's web origin (https://github.com, or an Enterprise/test origin).
      lines.push(`[credential ${gitQuote(new URL(this.endpoints(account).web).origin)}]`, "\thelper =")
      if (token) {
        await runDir.write("token", token)
        await runDir.write("login", discovery?.login ?? "x-access-token")
        const helper = await runDir.write("credential-helper", `#!/bin/sh\n[ "$1" = get ] || exit 0\nd=$(dirname -- "$0")\nprintf 'username=%s\\npassword=%s\\n' "$(cat "$d/login")" "$(cat "$d/token")"\n`, 0o700)
        lines.push(`\thelper = ${gitQuote(`!${shellQuote(helper)}`)}`)
        secrets = true
      }
      // URL rewrites so the account's transport is used whatever the remote URL says.
      const rewrite = (to: "https" | "ssh", prefix = "") => to === "ssh"
        ? [`[url ${gitQuote(`git@${host}:${prefix}`)}]`, `\tinsteadOf = ${gitQuote(`https://${host}/${prefix}`)}`]
        : [`[url ${gitQuote(`https://${host}/${prefix}`)}]`, `\tinsteadOf = ${gitQuote(`git@${host}:${prefix}`)}`, `\tinsteadOf = ${gitQuote(`ssh://git@${host}/${prefix}`)}`]
      if (account.transport !== "none") lines.push(...rewrite(account.transport))
      for (const [owner, to] of Object.entries(account.ownerTransport ?? {})) lines.push(...rewrite(to, `${owner}/`))
      env.GIT_CONFIG_GLOBAL = await runDir.write("gitconfig", lines.join("\n") + "\n")

      if (usesSsh && plan.network) {
        let key = account.sshKeyFile ? resolve(homedir(), account.sshKeyFile.replace(/^~\//, "")) : undefined
        if (!key) {
          const stored = await this.vault.get(account.id, SSH_KEY)
          if (stored) { key = await runDir.write("ssh-key", stored.endsWith("\n") ? stored : `${stored}\n`); secrets = true }
          else if (transport === "ssh") notes.push(`${account.id} has no SSH key yet: call github_ssh_keygen account=${account.id}.`)
        }
        if (key && !isAbsolute(key)) key = resolve(key)
        env.GIT_SSH_COMMAND = ["ssh", "-F", "/dev/null", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", ...(key ? ["-i", shellQuote(key)] : ["-o", "IdentityFile=/dev/null"]),
          "-o", `UserKnownHostsFile=${shellQuote(this.knownHosts)}`, "-o", "StrictHostKeyChecking=accept-new", "-o", "BatchMode=yes"].join(" ")
        env.SSH_AUTH_SOCK = ""
      }
      if (plan.gh) {
        env.GH_CONFIG_DIR = runDir.file("gh")
        await runDir.write("gh/config.yml", `git_protocol: ${transport === "ssh" ? "ssh" : "https"}\nprompt: disabled\n`)
        env.GH_PROMPT_DISABLED = "1"
        env.GH_NO_UPDATE_NOTIFIER = "1"
        env.GH_HOST = host
        if (host === "github.com") { env.GH_TOKEN = token ?? ""; env.GH_ENTERPRISE_TOKEN = "" }
        else { env.GH_ENTERPRISE_TOKEN = token ?? ""; env.GH_TOKEN = "" }
      }
      if (secrets) await this.syncRedactor()
      return { env, notes, secrets, runDir }
    } catch (error) {
      await runDir.remove().catch(() => {})
      throw error
    }
  }

  // ---------------------------------------------------------------- tokens and sign-in

  /** The account's token, refreshed first if it is about to expire. */
  async token(account: Account): Promise<string | undefined> {
    const token = await this.vault.get(account.id, TOKEN)
    const discovery = await this.store.discovery(account.id)
    if (token && discovery?.tokenExpiresAt && discovery.tokenExpiresAt - Date.now() < 5 * 60_000) {
      const refresh = await this.vault.get(account.id, REFRESH)
      if (refresh) {
        try {
          const grant = await refreshToken(this.endpoints(account), account.clientId ?? DEFAULT_CLIENT_ID, refresh)
          await this.saveGrant(account, grant)
          return grant.token
        } catch { return token }
      }
    }
    return token
  }

  async saveGrant(account: Account, grant: { token: string; refreshToken?: string; expiresAt?: number }): Promise<Discovery> {
    await this.vault.set(account.id, TOKEN, grant.token)
    if (grant.refreshToken) await this.vault.set(account.id, REFRESH, grant.refreshToken)
    else await this.vault.delete(account.id, REFRESH)
    await this.requests.remove({ entity: account.id, name: TOKEN })
    await this.refreshRedactor()
    return this.rediscover(account, grant.expiresAt)
  }

  /** Asks GitHub who the token is and which orgs it reaches (with SSO status). */
  async rediscover(account: Account, tokenExpiresAt?: number): Promise<Discovery> {
    const token = await this.token(account)
    const previous = await this.store.discovery(account.id)
    let discovery: Discovery
    if (!token) discovery = { orgs: [], error: "not signed in" }
    else {
      try { discovery = await discover(this.endpoints(account), token) }
      catch (error) { discovery = { ...(previous ?? { orgs: [] }), error: (error as Error).message, checkedAt: new Date().toISOString() } }
    }
    const expires = tokenExpiresAt ?? previous?.tokenExpiresAt
    discovery = { ...discovery, ...(expires && { tokenExpiresAt: expires }) }
    await this.store.setDiscovery(account.id, discovery)
    return discovery
  }

  /** Starts (or returns the running) browser sign-in. It completes in the background. */
  async startSignIn(account: Account): Promise<SignIn> {
    const running = this.signIns.get(account.id)
    if (running?.status === "waiting" && running.expiresAt > Date.now()) return running
    running?.controller.abort()
    if (account.auth !== "browser") throw new Error(`${account.id} uses auth=${account.auth}; browser sign-in is for auth=browser (change it with github_account_upsert)`)
    const ep = this.endpoints(account)
    const clientId = account.clientId ?? DEFAULT_CLIENT_ID
    const controller = new AbortController()
    const code: DeviceCode = await startDeviceFlow(ep, clientId, account.scopes ?? DEFAULT_SCOPES, controller.signal)
    const signIn: SignIn = { account: account.id, userCode: code.userCode, verificationUri: code.verificationUri, expiresAt: code.expiresAt, status: "waiting", controller }
    this.signIns.set(account.id, signIn)
    void pollDeviceFlow(ep, clientId, code, controller.signal)
      .then(async grant => { await this.saveGrant(account, grant); signIn.status = "done" })
      .catch(error => { if (!controller.signal.aborted) { signIn.status = "failed"; signIn.error = (error as Error).message } })
    return signIn
  }

  async secretStatus(account: Account): Promise<Record<string, "set" | "unset">> {
    const stored = new Set((await this.vault.list(account.id)).map(item => item.name))
    return Object.fromEntries(secretSlots(account).map(slot => [slot, stored.has(slot) ? "set" : "unset"]))
  }

  async syncRedactor(): Promise<void> {
    await this.vault.list()
    if (this.#redactorStale) { this.#redactorStale = false; await this.refreshRedactor() }
  }
  async refreshRedactor(): Promise<void> {
    this.redactor.replaceAll((await this.vault.values()).map(item => [`${item.entity}/${item.name}`, item.value] as const))
  }

  dispose(): void { for (const signIn of this.signIns.values()) signIn.controller.abort() }
}
