// Enter a token for an account (auth=token) from a terminal. The value is read with echo off, or from stdin when piped.
//   pixi run token-set <account>
import { createInterface } from "node:readline"
import { pluginDataDir } from "oc-secure-kit"
import { GitHubService } from "../plugin/service.ts"

const [id] = process.argv.slice(2)
if (!id) { console.error("Usage: pixi run token-set <account>"); process.exit(2) }
const service = await GitHubService.open(pluginDataDir("oc-github", process.env.OC_GITHUB_DATA_DIR || undefined))
const account = await service.store.get(id)
if (!account) { console.error(`No account ${id}. Accounts: ${(await service.store.list()).map(a => a.id).join(", ") || "(none)"}`); process.exit(1) }

function readHidden(prompt) {
  if (!process.stdin.isTTY) return new Promise(resolve => { let data = ""; process.stdin.on("data", c => { data += c }); process.stdin.on("end", () => resolve(data.trim())) })
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    let muted = false
    rl._writeToOutput = text => { if (!muted) process.stdout.write(text) }
    rl.question(prompt, answer => { rl.close(); process.stdout.write("\n"); resolve(answer.trim()) })
    muted = true
  })
}
const token = await readHidden(`Token for ${id} (${account.host}): `)
if (!token) { console.error("Empty; nothing stored."); process.exit(1) }
const discovery = await service.saveGrant(account, { token })
console.log(discovery.error ? `Stored, but GitHub said: ${discovery.error}` : `Stored. Signed in as ${discovery.login}; orgs: ${discovery.orgs.map(o => o.login).join(", ") || "none"}.`)
service.dispose()
