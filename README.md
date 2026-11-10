# oc-github

GitHub accounts for OpenCode agents. Any number of accounts, each with its own
login and (optionally) SSH key held by the plugin; the agent uses normal `git`
and `gh` commands in its own shell and the right account's credentials are
supplied to that one command after a permission check. macOS and Linux;
OpenCode 2.2.6+ and Pixi.

**Status:** accounts, browser sign-in (device flow), tokens,
org/SSO discovery, generated SSH keys, per-command credentials, command
classification, permissions, the GUI (Review pane via `/github` or the + menu,
and Settings → GitHub) and encrypted export/import work. Tested against real
github.com with an SSO organization (sign-in, API, HTTPS git) and against real
OpenCode 2.2.6 with a fake GitHub: CLI smoke from checkout and snapshot on
macOS and Ubuntu 24.04 arm64, Desktop GUI on macOS.

## The GitHub view (you)

- **Add account** (name, host, git transport, login type) and **Sign in**:
  shows the code with **Copy and open GitHub**; it completes on its own.
- Per account: who it is signed in as, **Refresh orgs**, **Sign out**,
  **Enter token** (token accounts), remove; its orgs with role and SSO status
  (**Authorize** opens GitHub's SSO page when needed).
- **Permissions for** the whole account or one org/owner, grouped (Git, Pull
  requests, Issues & releases, Repo admin, Org & account); rows Any agent,
  agents with their own settings (or all), This session.
- **Pick account from repo** on/off; **Export/Import** (accounts, permissions,
  logins and SSH keys in a passphrase-encrypted file; orgs are re-discovered).

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

## Install

Requires [OpenCode](https://opencode.ai) 2.2.6+ (CLI or Desktop) and [Pixi](https://pixi.sh); macOS or Linux.

```sh
git clone https://github.com/p-w-rs/oc-github.git && cd oc-github
pixi run --locked install          # runs the tests, then installs a verified snapshot into your OpenCode config
```

Restart OpenCode (or `/reload`). Then open **Settings → GitHub** (or `/github` in a session) and add an account, or from a terminal: `pixi run signin work`.
Agents can also set things up for you when you ask.

```sh
pixi run --locked install-status   # what is installed, and whether its files are intact
pixi run --locked rollback         # back to the previous snapshot
pixi run --locked uninstall        # removes only this plugin's entry; your data stays
```

Updating: `git pull && pixi run --locked install`. Accounts, sign-ins and permissions live in
`~/.local/share/oc-github` and survive updates; move them between computers with **Export** / **Import** in the view.

## Signing in from a terminal

```sh
pixi run signin work                     # creates the account if needed (https), prints a code, waits
pixi run signin personal --transport ssh # an account that uses SSH for git
pixi run signin work --client-id <id>    # if your org approved a different OAuth app
pixi run token-set personal              # paste a token for an auth=token account
```

If an org needs single sign-on authorization, sign-in prints its authorize link.
If an org is missing entirely, its owners may restrict which OAuth apps can see
it; ask them to approve the app, or use another app's `clientId`.

## Development

```sh
pixi run --locked test            # fake GitHub (device flow, API, SSO headers, git http-backend) + a real local sshd
pixi run --locked smoke-host      # real OpenCode 2.2.6 CLI, scripted model, fake GitHub
pixi run --locked smoke-snapshot  # same, from an installed snapshot
pixi run desktop-dev start        # isolated OpenCode Desktop with a fake GitHub (approve: curl http://<host>/__approve)
```
