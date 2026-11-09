import { readFile, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"

export interface RepoInfo {
  readonly root: string
  readonly gitDir: string
  readonly remotes: Record<string, string>
  /** Current branch, or undefined when detached. */
  readonly branch?: string
  /** Remote of the current branch's upstream. */
  readonly upstreamRemote?: string
  /** Default branch per remote, from `refs/remotes/<remote>/HEAD`. */
  defaultBranch(remote: string): Promise<string | undefined>
}

const read = (path: string) => readFile(path, "utf8").catch(() => undefined)

/** Minimal git config parsing: `[section "sub"]` and `key = value` lines. Good enough for remotes and branches. */
export function parseConfig(text: string): Map<string, string> {
  const values = new Map<string, string>()
  let section = ""
  for (const raw of text.split("\n")) {
    const line = raw.replace(/(^|\s)[#;].*$/, "").trim()
    if (!line) continue
    const header = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]$/.exec(line)
    if (header) { section = header[2] !== undefined ? `${header[1]!.toLowerCase()}.${header[2].replace(/\\(.)/g, "$1")}` : header[1]!.toLowerCase(); continue }
    const pair = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line)
    if (pair && section) values.set(`${section}.${pair[1]!.toLowerCase()}`, (pair[2] ?? "true").replace(/^"(.*)"$/, "$1"))
  }
  return values
}

/** Finds the repo containing `dir` by walking up to a `.git` directory or file. */
export async function readRepo(dir: string): Promise<RepoInfo | undefined> {
  let current = resolve(dir)
  for (let depth = 0; depth < 64; depth++) {
    const dotGit = join(current, ".git")
    const info = await stat(dotGit).catch(() => undefined)
    if (info) {
      let gitDir = dotGit
      if (info.isFile()) {
        const pointer = /^gitdir:\s*(.+)$/m.exec(await read(dotGit) ?? "")?.[1]?.trim()
        if (!pointer) return undefined
        gitDir = isAbsolute(pointer) ? pointer : resolve(current, pointer)
      }
      const common = (await read(join(gitDir, "commondir")))?.trim()
      const commonDir = common ? resolve(gitDir, common) : gitDir
      const config = parseConfig(await read(join(commonDir, "config")) ?? "")
      const remotes: Record<string, string> = {}
      for (const [key, value] of config) {
        const match = /^remote\.(.+)\.url$/.exec(key)
        if (match) remotes[match[1]!] = value
      }
      const head = (await read(join(gitDir, "HEAD")))?.trim()
      const branch = head?.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : undefined
      const upstreamRemote = branch ? config.get(`branch.${branch}.remote`) : undefined
      return {
        root: current, gitDir, remotes, ...(branch && { branch }), ...(upstreamRemote && { upstreamRemote }),
        defaultBranch: async remote => {
          const ref = (await read(join(commonDir, "refs", "remotes", remote, "HEAD")))?.trim()
          return ref?.startsWith(`ref: refs/remotes/${remote}/`) ? ref.slice(`ref: refs/remotes/${remote}/`.length) : undefined
        },
      }
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}
