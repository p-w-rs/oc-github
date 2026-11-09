import { isAbsolute, join, resolve } from "node:path"

/** One `git` or `gh` invocation inside a shell command. */
export interface Invocation {
  readonly tool: "git" | "gh"
  /** Directory it runs in (after `cd` and `git -C`). */
  readonly cwd: string
  /** `OCG_ACCOUNT=<name>` given for this invocation (or earlier with `export`). */
  readonly account?: string
  /** Arguments after global options, starting with the subcommand. */
  readonly args: string[]
}

const OPERATORS = new Set([";", "&&", "||", "|", "&", "\n", "(", ")"])

/** A small shell lexer: words (with quotes removed) and control operators. Unknown syntax degrades to words. */
export function tokenize(command: string): string[] {
  const tokens: string[] = []
  let word = "", quoted = false, i = 0
  const push = () => { if (word !== "" || quoted) tokens.push(word); word = ""; quoted = false }
  while (i < command.length) {
    const c = command[i]!
    if (c === "'") { const end = command.indexOf("'", i + 1); word += command.slice(i + 1, end < 0 ? undefined : end); quoted = true; i = end < 0 ? command.length : end + 1; continue }
    if (c === '"') {
      i++; quoted = true
      while (i < command.length && command[i] !== '"') { if (command[i] === "\\" && i + 1 < command.length) i++; word += command[i]; i++ }
      i++; continue
    }
    if (c === "\\" && i + 1 < command.length) { word += command[i + 1] === "\n" ? "" : command[i + 1]; i += 2; continue }
    if (c === "#" && word === "" && !quoted) { while (i < command.length && command[i] !== "\n") i++; continue }
    if (c === "\n" || c === ";" || c === "(" || c === ")") { push(); tokens.push(c); i++; continue }
    if (c === "&" || c === "|") { push(); const two = command[i + 1] === c; tokens.push(two ? c + c : c); i += two ? 2 : 1; continue }
    if (c === " " || c === "\t") { push(); i++; continue }
    word += c; i++
  }
  push()
  return tokens
}

const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s
const expandHome = (path: string, home: string) => path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path
const at = (cwd: string, path: string, home: string) => { const p = expandHome(path, home); return isAbsolute(p) ? p : resolve(cwd, p) }

/** Finds git/gh invocations, following `cd`, `pushd`, `git -C`, `export OCG_ACCOUNT=...` and `VAR=... git ...`. */
export function invocations(command: string, cwd: string, home: string): Invocation[] {
  const tokens = tokenize(command)
  const result: Invocation[] = []
  let dir = cwd
  let exported: string | undefined
  let segment: string[] = []
  const flush = () => {
    const words = segment
    segment = []
    let index = 0
    let account = exported
    while (index < words.length && ASSIGN.test(words[index]!)) {
      const [, name, value] = ASSIGN.exec(words[index]!)!
      if (name === "OCG_ACCOUNT") account = value
      index++
    }
    while (["env", "command", "exec", "time", "nohup", "sudo"].includes(words[index] ?? "")) {
      index++
      while (index < words.length && (words[index]!.startsWith("-") || ASSIGN.test(words[index]!))) {
        const match = ASSIGN.exec(words[index]!)
        if (match?.[1] === "OCG_ACCOUNT") account = match[2]
        index++
      }
    }
    const program = words[index]
    if (!program) return
    const base = program.split("/").pop()!
    if ((base === "cd" || base === "pushd") && words[index + 1] && words[index + 1] !== "-") { dir = at(dir, words[index + 1]!, home); return }
    if (base === "export") {
      for (const word of words.slice(index + 1)) { const match = ASSIGN.exec(word); if (match?.[1] === "OCG_ACCOUNT") exported = match[2] }
      return
    }
    if (base !== "git" && base !== "gh") return
    const args = words.slice(index + 1)
    let where = dir
    if (base === "git") {
      // Global options before the subcommand.
      while (args.length && args[0]!.startsWith("-")) {
        const option = args.shift()!
        if (option === "-C" && args.length) where = at(where, args.shift()!, home)
        else if (["-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"].includes(option) && args.length) args.shift()
      }
    }
    result.push({ tool: base, cwd: where, ...(account !== undefined && { account }), args })
  }
  for (const token of tokens) {
    if (OPERATORS.has(token) || token === "&&" || token === "||") flush()
    else segment.push(token)
  }
  flush()
  return result
}

export interface RepoRef { readonly host: string; readonly owner: string; readonly repo?: string }

/** Parses GitHub-style URLs: https://host/owner/repo(.git), git@host:owner/repo, ssh://git@host[:port]/owner/repo. */
export function parseRemote(url: string): RepoRef | undefined {
  // For http(s) the port is part of the host's identity (Enterprise on a custom port); for ssh it is only the ssh port.
  let match = /^(?:https?|git):\/\/(?:[^@/]+@)?([^/:]+(?::\d+)?)\/([^/]+)(?:\/([^/?#]+?))?(?:\.git)?\/?(?:[?#].*)?$/.exec(url)
  if (!match) match = /^ssh:\/\/[^@/]+@([^/:]+)(?::\d+)?\/([^/]+)(?:\/([^/]+?))?(?:\.git)?\/?$/.exec(url)
  if (!match) match = /^[A-Za-z0-9._-]+@([^:/]+):\/?([^/]+)(?:\/([^/]+?))?(?:\.git)?\/?$/.exec(url)
  if (!match) return undefined
  return { host: match[1]!.toLowerCase(), owner: match[2]!, ...(match[3] && { repo: match[3] }) }
}

/** `owner/repo` or `HOST/owner/repo` as gh accepts them. */
export function parseRepoArg(value: string, defaultHost: string | undefined): RepoRef | undefined {
  if (/^[a-z]+:\/\/|@/.test(value)) return parseRemote(value)
  const parts = value.split("/")
  if (parts.length === 2 && parts[0] && parts[1]) return { ...(defaultHost && { host: defaultHost }), owner: parts[0], repo: parts[1].replace(/\.git$/, "") } as RepoRef
  if (parts.length === 3 && parts.every(Boolean)) return { host: parts[0]!.toLowerCase(), owner: parts[1]!, repo: parts[2]!.replace(/\.git$/, "") }
  return undefined
}

const value = (args: readonly string[], ...names: string[]) => {
  for (const [index, arg] of args.entries()) {
    for (const name of names) {
      if (arg === name && index + 1 < args.length) return args[index + 1]
      if (name.startsWith("--") && arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
    }
  }
  return undefined
}
/** Positional arguments, skipping options (and the values of options known to take one). */
function positionals(args: readonly string[], valued: readonly string[] = []): string[] {
  const result: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "--") { result.push(...args.slice(index + 1)); break }
    if (arg.startsWith("-")) { if (valued.includes(arg)) index++; continue }
    result.push(arg)
  }
  return result
}

export const GIT_NETWORK = new Set(["clone", "fetch", "pull", "push", "ls-remote", "submodule", "remote"])
export const GIT_IDENTITY = new Set(["commit", "merge", "rebase", "cherry-pick", "revert", "am", "tag", "stash", "notes", "pull"])

/** What a git invocation needs: which remote (or URL) it talks to, and the capabilities. */
export interface GitNeed {
  readonly network: boolean
  readonly identity: boolean
  /** `remote:<name>` to look up in the repo, or `url:<url>`. */
  readonly target?: string
  readonly capabilities: string[]
  /** Branches pushed to (to compare with the default branch). `HEAD` means the current branch. */
  readonly pushTo?: string[]
}

export function gitNeed(args: readonly string[]): GitNeed | undefined {
  const sub = args[0]
  if (!sub) return undefined
  const rest = args.slice(1)
  const network = GIT_NETWORK.has(sub)
  const identity = GIT_IDENTITY.has(sub)
  if (!network && !identity) return undefined
  switch (sub) {
    case "clone": {
      const [url] = positionals(rest, ["-o", "--origin", "-b", "--branch", "--depth", "-c", "--config", "--reference", "-j", "--jobs", "--filter", "-u", "--upload-pack", "--template", "--separate-git-dir", "--shallow-since", "--shallow-exclude"])
      return { network, identity, ...(url && { target: `url:${url}` }), capabilities: ["read"] }
    }
    case "fetch": case "pull": case "ls-remote": {
      const [remote] = positionals(rest, ["--depth", "-j", "--jobs", "--upload-pack", "-o", "--server-option", "--shallow-since", "--shallow-exclude", "--refmap", "--recurse-submodules-default", "-s", "--strategy", "-X", "--strategy-option"])
      return { network, identity, target: remote ? (remote.includes(":") || remote.includes("/") ? `url:${remote}` : `remote:${remote}`) : "remote:", capabilities: ["read"] }
    }
    case "push": {
      const pos = positionals(rest, ["-o", "--push-option", "--repo", "--receive-pack", "--exec"])
      const repo = value(rest, "--repo")
      const remote = repo ?? pos[0]
      const refspecs = repo ? pos : pos.slice(1)
      const capabilities = new Set<string>(["push"])
      if (rest.some(arg => /^(-f|--force|--force-with-lease(=.*)?|--force-if-includes|--mirror)$/.test(arg) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(arg) && !arg.startsWith("--"))) capabilities.add("force-push")
      const deleting = rest.includes("--delete") || rest.includes("-d")
      const pushTo: string[] = []
      if (!refspecs.length && !rest.some(arg => ["--all", "--mirror", "--tags", "--branches"].includes(arg))) pushTo.push("HEAD")
      for (const spec of refspecs) {
        if (spec.startsWith("+")) capabilities.add("force-push")
        const clean = spec.replace(/^\+/, "")
        const dst = clean.includes(":") ? clean.slice(clean.indexOf(":") + 1) : clean
        if ((clean.startsWith(":") || deleting) && dst) { capabilities.add("delete-branch"); pushTo.push(dst); continue }
        pushTo.push(dst === "HEAD" || dst === "" ? "HEAD" : dst.replace(/^refs\/heads\//, ""))
      }
      if (rest.includes("--all") || rest.includes("--mirror") || rest.includes("--branches")) pushTo.push("*")
      return { network, identity, target: remote ? (remote.includes(":") || remote.includes("/") ? `url:${remote}` : `remote:${remote}`) : "remote:", capabilities: [...capabilities], pushTo }
    }
    case "submodule": return rest[0] === "update" || rest[0] === "sync" || rest.includes("--remote") ? { network, identity: false, target: "remote:", capabilities: ["read"] } : undefined
    case "remote": return rest[0] === "update" || rest[0] === "show" || rest[0] === "prune" ? { network, identity: false, target: rest[1] && rest[0] !== "update" ? `remote:${rest[1]}` : "remote:", capabilities: ["read"] } : undefined
    default: return { network: false, identity: true, capabilities: [] }
  }
}

/** What a gh invocation needs. */
export interface GhNeed {
  readonly capability: string
  /** Explicit repo/owner from the arguments; otherwise gh uses the current repo. */
  readonly target?: { repo?: string; owner?: string; host?: string }
  /** Uses the current directory's repo when no target is given. */
  readonly usesRepo: boolean
  /** gh commands the plugin leaves alone (e.g. `gh auth`). */
  readonly skip?: boolean
}

const READ_SUBS = new Set(["list", "view", "status", "diff", "checks", "download", "watch", "browse", "ls"])
const GROUPS: Record<string, Record<string, string> & { "*": string }> = {
  pr: { "*": "pr", merge: "pr-merge", review: "review", checkout: "read" },
  issue: { "*": "issues" },
  label: { "*": "issues" },
  project: { "*": "issues" },
  release: { "*": "releases" },
  run: { "*": "actions" },
  workflow: { "*": "actions" },
  cache: { "*": "actions" },
  repo: { "*": "repo-settings", create: "repo-create", fork: "repo-create", delete: "repo-delete", clone: "read", sync: "push", "set-default": "read" },
  secret: { "*": "secrets", list: "secrets" },
  variable: { "*": "secrets", list: "secrets" },
  gist: { "*": "gists" },
  "ssh-key": { "*": "account-settings" },
  "gpg-key": { "*": "account-settings" },
  org: { "*": "org-admin" },
  ruleset: { "*": "repo-settings" },
  attestation: { "*": "read" },
  search: { "*": "read" },
  status: { "*": "read" },
  browse: { "*": "read" },
  codespace: { "*": "api-other" },
  extension: { "*": "api-other" },
}
const NO_REPO = new Set(["gist", "ssh-key", "gpg-key", "search", "status", "org", "codespace", "extension", "api"])

export function ghNeed(args: readonly string[], defaultHost?: string): GhNeed {
  const [group, sub] = args
  if (!group || ["auth", "config", "alias", "completion", "help", "version", "--version", "-v"].includes(group)) return { capability: "read", usesRepo: false, skip: true }
  const repoFlag = value(args, "-R", "--repo")
  const hostname = value(args, "--hostname")
  const target = repoFlag ? parseRepoArg(repoFlag, defaultHost) : undefined
  if (group === "api") return apiNeed(args.slice(1), hostname ?? defaultHost)
  const table = GROUPS[group]
  let capability = table ? (sub && table[sub]) ?? (sub && READ_SUBS.has(sub) && group !== "secret" && group !== "variable" ? "read" : table["*"]) : "api-other"
  if (group === "repo" && sub === "view") capability = "read"
  if (group === "repo" && (sub === "list" || sub === "view")) capability = "read"
  let explicit: GhNeed["target"]
  if (target) explicit = { owner: target.owner, ...(target.repo && { repo: target.repo }), ...(target.host && { host: target.host }) }
  if (group === "repo" && sub && ["clone", "view", "delete", "fork", "edit", "rename", "archive", "unarchive", "sync", "deploy-key", "create", "set-default"].includes(sub)) {
    const [first] = positionals(args.slice(2), ["--source", "-s", "--remote", "-r", "--template", "-p", "--description", "-d", "--homepage", "-h", "--team", "-t", "--gitignore", "-g", "--license", "-l", "--org", "--clone", "--fork-name", "--yes", "-c", "--repo", "-R", "-b", "--branch", "--default-branch"])
    if (first && first.includes("/")) {
      const ref = parseRepoArg(first, defaultHost)
      if (ref) explicit = { owner: ref.owner, ...(ref.repo && { repo: ref.repo }), ...(ref.host && { host: ref.host }) }
    }
    const org = value(args, "--org")
    if (org) explicit = { owner: org }
  }
  if (group === "org" && sub === "list") capability = "read"
  if (["secret", "variable"].includes(group)) { const org = value(args, "-o", "--org"); if (org) explicit = { owner: org } }
  return { capability, ...(explicit && { target: explicit }), usesRepo: !explicit && !NO_REPO.has(group) && !(group === "repo" && (sub === "create" || sub === "list")) }
}

function apiNeed(args: readonly string[], host?: string): GhNeed {
  const method = (value(args, "-X", "--method") ?? (args.some(arg => /^(-f|-F|--field|--raw-field|--input)$/.test(arg) || /^--(raw-)?field=/.test(arg)) ? "POST" : "GET")).toUpperCase()
  const [endpoint = ""] = positionals(args, ["-X", "--method", "-f", "-F", "--field", "--raw-field", "-H", "--header", "--input", "-q", "--jq", "-t", "--template", "--hostname", "--cache", "-p", "--preview"])
  const path = endpoint.replace(/^\/+/, "").replace(/^https?:\/\/[^/]+\/(api\/v3\/)?/, "")
  const parts = path.split(/[/?]/)
  let target: GhNeed["target"]
  if (parts[0] === "repos" && parts[1] && parts[2]) target = { owner: parts[1], repo: parts[2] }
  else if ((parts[0] === "orgs" || parts[0] === "users") && parts[1]) target = { owner: parts[1] }
  if (target && host) target = { ...target, host }
  if (path === "graphql") {
    const query = args.join(" ")
    return { capability: /\bmutation\b/.test(query) ? "api-other" : "read", usesRepo: false }
  }
  if (method === "GET" || method === "HEAD") return { capability: /\/(secrets|variables)\b/.test(path) ? "secrets" : "read", ...(target && { target }), usesRepo: /\{owner\}|\{repo\}/.test(path) }
  let capability = "api-other"
  if (/\/(secrets|variables)\b/.test(path)) capability = "secrets"
  else if (method === "DELETE" && parts[0] === "repos" && parts.length === 3) capability = "repo-delete"
  else if (/\/pulls\/\d+\/merge$/.test(path)) capability = "pr-merge"
  else if (/\/pulls\/\d+\/reviews/.test(path)) capability = "review"
  else if (/\/pulls(\/|$)/.test(path)) capability = "pr"
  else if (/\/(issues|labels|milestones)(\/|$)/.test(path)) capability = "issues"
  else if (/\/releases(\/|$)/.test(path)) capability = "releases"
  else if (/\/actions\//.test(path)) capability = "actions"
  else if (/^orgs\/[^/]+\/(members|teams|invitations|memberships|outside_collaborators|settings)/.test(path) || (parts[0] === "orgs" && parts.length === 2)) capability = "org-admin"
  else if (/^(user\/repos|orgs\/[^/]+\/repos)$/.test(path) && method === "POST") capability = "repo-create"
  else if (parts[0] === "repos" && (parts.length === 3 || /\/(collaborators|branches\/[^/]+\/protection|rulesets|hooks|keys|topics|pages)/.test(path))) capability = "repo-settings"
  else if (/^gists/.test(path)) capability = "gists"
  else if (/^user\/(keys|gpg_keys|emails)/.test(path)) capability = "account-settings"
  return { capability, ...(target && { target }), usesRepo: /\{owner\}|\{repo\}/.test(path) }
}
