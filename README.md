# oc-github

GitHub accounts for OpenCode agents. Any number of accounts, each with its own
login and (optionally) SSH key held by the plugin; the agent uses normal `git`
and `gh` commands in its own shell and the right account's credentials are
supplied to that one command after a permission check. macOS and Linux;
OpenCode 2.2.6+ and Pixi.

**Status: milestone 1.** Accounts, browser sign-in (device flow), tokens,
org/SSO discovery, generated SSH keys, per-command credentials, command
classification and permissions work. The Review-pane GUI, export/import and a
real-OpenCode smoke test come next.

## Accounts vs orgs

An **account** is an identity the plugin signs in as (you name it: `work`,
`personal`, ...). An **org** is an organization that account can reach; the
plugin asks GitHub which, and whether an org's single sign-on still needs to
authorize the login. The agent sees both in the `github_list` description.

Each account sets: `host` (github.com or Enterprise), `transport` (https, ssh,
none), `auth` (browser sign-in, a pasted token, none), optional `clientId` of
the OAuth app to sign in with (default: GitHub CLI's), `scopes`, `sshKeyFile`
(instead of a generated key), extra `owners`, per-owner `ownerTransport`,
commit `name`/`email`, and `useSystemGitConfig`.

## How commands are handled

| Command | What happens |
|---|---|
| `git clone/fetch/pull/push/ls-remote`, or `gh ...`, for an owner one account reaches | that account's login (and key) for this command only; the user's git config, keychain and `~/.ssh` are ignored |
| `git commit` etc. in such a repo | the account's commit name/email |
| the owner matches several accounts, or none can be told | no credentials; the result tells the agent to decide from context or ask, then use `OCG_ACCOUNT=<account>` |
| owner matches no account, `OCG_ACCOUNT=none`, any other command | untouched: plain OpenCode with your own git and `gh` |
| a permission is denied or declined | the command runs without GitHub credentials, with a note |

## Permissions

One table per account, with optional per-org rows (`account@org`) that
inherit unset cells from the account. Capabilities: read, push,
push-default-branch, force-push, delete-branch, pr, pr-merge, review, issues,
releases, actions, repo-create, repo-delete, repo-settings, secrets, org-admin,
account-settings, gists, packages, api-other, manage, remove. Defaults allow
everything except force-push, repo-delete, repo-settings, secrets, org-admin,
api-other and remove, which ask. All of it is editable (GUI next milestone);
**Allow always** on a prompt writes allow.

## Signing in from a terminal

```sh
pixi run signin work                     # creates the account if needed, prints a code, waits
pixi run signin work --client-id <id>    # if your org approved a different OAuth app
pixi run token-set personal              # paste a token for an auth=token account
```

If an org needs single sign-on authorization, sign-in prints its authorize link.
If an org is missing entirely, its owners may restrict which OAuth apps can see
it; ask them to approve the app, or use another app's `clientId`.

## Development

```sh
pixi run --locked test   # fake GitHub (device flow, API, SSO headers, git http-backend) + a real local sshd
```
