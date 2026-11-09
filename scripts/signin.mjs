// Browser sign-in for an account from a terminal (the agent's github_signin and the GUI do the same).
//   pixi run signin <account> [--client-id <id>] [--host <host>]
// Creates the account (https + browser sign-in on github.com) if it does not exist yet. Never prints the token.
import { pluginDataDir, PermissionBridge } from "oc-secure-kit"
import { defaultEffect, normalizeAccount } from "../plugin/model.ts"
import { GitHubService } from "../plugin/service.ts"

const args = process.argv.slice(2)
const id = args.find(arg => !arg.startsWith("--") && args[args.indexOf(arg) - 1]?.startsWith("--") !== true)
const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined }
if (!id) { console.error("Usage: pixi run signin <account> [--transport https|ssh|none] [--client-id <id>] [--host <host>]"); process.exit(2) }

const service = await GitHubService.open(pluginDataDir("oc-github", process.env.OC_GITHUB_DATA_DIR || undefined))
service.attach(new PermissionBridge({ plugin: "oc-github", policy: service.policy, fallback: defaultEffect, root: async s => s }))
let account = await service.store.get(id)
if (!account || option("--client-id") || option("--host") || option("--transport")) {
  account = await service.store.put(normalizeAccount({
    ...(account ?? { id, transport: "https", auth: "browser" }),
    ...(option("--transport") && { transport: option("--transport") }),
    ...(option("--client-id") && { clientId: option("--client-id") }), ...(option("--host") && { host: option("--host") }),
  }))
  console.log(`Account ${id}: ${account.host}, git over ${account.transport}, ${account.auth} sign-in${account.clientId ? `, app ${account.clientId}` : ""}`)
}
const signIn = await service.startSignIn(account)
console.log(`\nOpen ${signIn.verificationUri} and enter the code:\n\n    ${signIn.userCode}\n\nSign in to GitHub (and your organization's single sign-on if asked). Waiting…`)
while (signIn.status === "waiting" && Date.now() < signIn.expiresAt) await new Promise(resolve => setTimeout(resolve, 1000))
if (signIn.status !== "done") { console.error(`Sign-in did not finish: ${signIn.error ?? "expired"}`); process.exit(1) }
const discovery = await service.store.discovery(id)
console.log(`\nSigned in as ${discovery?.login}. Scopes: ${discovery?.scopes?.join(", ") || "(not reported)"}`)
for (const org of discovery?.orgs ?? []) {
  console.log(`  org ${org.login}: ${org.sso === "authorize" ? `needs single sign-on authorization → ${org.authorizeUrl ?? "(open the org on GitHub)"}` : org.sso === "ok" ? "SSO ok" : "ok"}${org.role ? ` (${org.role})` : ""}`)
}
if (!discovery?.orgs?.length) console.log("  no orgs visible (if you expected one, its owners may restrict this sign-in app; see the README)")
service.dispose()
process.exit(0)
