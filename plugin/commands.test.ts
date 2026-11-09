import { test } from "node:test"
import assert from "node:assert/strict"
import { ghNeed, gitNeed, invocations, parseRemote, parseRepoArg, tokenize } from "./commands.js"

test("tokenizer handles quotes, escapes and operators", () => {
  assert.deepEqual(tokenize(`cd "my dir" && git commit -m 'a; b' | cat; echo x\\ y`), ["cd", "my dir", "&&", "git", "commit", "-m", "a; b", "|", "cat", ";", "echo", "x y"])
  assert.deepEqual(tokenize("a&b||c # comment"), ["a", "&", "b", "||", "c"])
})

test("finds git/gh invocations with their directory and account", () => {
  const found = invocations("cd repo && OCG_ACCOUNT=work git -C sub push origin main; gh pr list -R a/b && export OCG_ACCOUNT=personal; git pull", "/w", "/home/me")
  assert.deepEqual(found, [
    { tool: "git", cwd: "/w/repo/sub", account: "work", args: ["push", "origin", "main"] },
    { tool: "gh", cwd: "/w/repo", args: ["pr", "list", "-R", "a/b"] },
    { tool: "git", cwd: "/w/repo", account: "personal", args: ["pull"] },
  ])
  assert.deepEqual(invocations("echo git; ls ~/gh", "/w", "/h"), [])
  assert.deepEqual(invocations("env FOO=1 OCG_ACCOUNT=none /usr/bin/git fetch", "/w", "/h"), [{ tool: "git", cwd: "/w", account: "none", args: ["fetch"] }])
  assert.equal(invocations("cd ~/code && git push", "/w", "/h")[0]!.cwd, "/h/code")
})

test("parses GitHub remotes", () => {
  assert.deepEqual(parseRemote("https://github.com/Acme/app.git"), { host: "github.com", owner: "Acme", repo: "app" })
  assert.deepEqual(parseRemote("git@github.com:p-w-rs/open-claude.git"), { host: "github.com", owner: "p-w-rs", repo: "open-claude" })
  assert.deepEqual(parseRemote("ssh://git@ghe.corp.example:2222/team/x"), { host: "ghe.corp.example", owner: "team", repo: "x" })
  assert.deepEqual(parseRemote("https://user@github.com/acme"), { host: "github.com", owner: "acme" })
  assert.equal(parseRemote("../local/repo"), undefined)
  assert.deepEqual(parseRepoArg("acme/app", "github.com"), { host: "github.com", owner: "acme", repo: "app" })
  assert.deepEqual(parseRepoArg("ghe.example/acme/app", undefined), { host: "ghe.example", owner: "acme", repo: "app" })
})

test("classifies git commands", () => {
  assert.deepEqual(gitNeed(["status"]), undefined)
  assert.deepEqual(gitNeed(["commit", "-m", "x"]), { network: false, identity: true, capabilities: [] })
  assert.deepEqual(gitNeed(["clone", "--depth", "1", "https://github.com/a/b"]), { network: true, identity: false, target: "url:https://github.com/a/b", capabilities: ["read"] })
  assert.deepEqual(gitNeed(["pull", "--rebase"])?.capabilities, ["read"])
  assert.deepEqual(gitNeed(["push"]), { network: true, identity: false, target: "remote:", capabilities: ["push"], pushTo: ["HEAD"] })
  assert.deepEqual(gitNeed(["push", "-u", "origin", "feature"])?.pushTo, ["feature"])
  assert.deepEqual(gitNeed(["push", "--force-with-lease", "origin", "x"])?.capabilities, ["push", "force-push"])
  assert.deepEqual(gitNeed(["push", "-fu", "origin", "x"])?.capabilities, ["push", "force-push"])
  assert.deepEqual(gitNeed(["push", "origin", "+main"])?.capabilities, ["push", "force-push"])
  assert.deepEqual(gitNeed(["push", "origin", ":old"]), { network: true, identity: false, target: "remote:origin", capabilities: ["push", "delete-branch"], pushTo: ["old"] })
  assert.deepEqual(gitNeed(["push", "origin", "--delete", "old"])?.capabilities, ["push", "delete-branch"])
  assert.deepEqual(gitNeed(["push", "origin", "HEAD:refs/heads/main"])?.pushTo, ["main"])
  assert.deepEqual(gitNeed(["push", "--mirror", "origin"])?.capabilities, ["push", "force-push"])
})

test("classifies gh commands", () => {
  const cap = (...args: string[]) => ghNeed(args).capability
  assert.equal(cap("pr", "list"), "read")
  assert.equal(cap("pr", "create", "--fill"), "pr")
  assert.equal(cap("pr", "merge", "12", "--squash"), "pr-merge")
  assert.equal(cap("pr", "review", "12", "--approve"), "review")
  assert.equal(cap("issue", "create"), "issues")
  assert.equal(cap("issue", "view", "3"), "read")
  assert.equal(cap("repo", "delete", "a/b", "--yes"), "repo-delete")
  assert.equal(cap("repo", "create", "a/new", "--private"), "repo-create")
  assert.equal(cap("repo", "edit", "--visibility", "public"), "repo-settings")
  assert.equal(cap("repo", "view"), "read")
  assert.equal(cap("secret", "list"), "secrets")
  assert.equal(cap("run", "rerun", "1"), "actions")
  assert.equal(cap("run", "list"), "read")
  assert.equal(cap("gist", "create", "f"), "gists")
  assert.equal(cap("ssh-key", "add", "k.pub"), "account-settings")
  assert.equal(cap("api", "repos/a/b/pulls"), "read")
  assert.equal(cap("api", "-X", "DELETE", "repos/a/b"), "repo-delete")
  assert.equal(cap("api", "repos/a/b/pulls/3/merge", "-X", "PUT"), "pr-merge")
  assert.equal(cap("api", "repos/a/b/issues", "-f", "title=x"), "issues")
  assert.equal(cap("api", "orgs/acme/members/u", "-X", "PUT"), "org-admin")
  assert.equal(cap("api", "-X", "POST", "some/unknown"), "api-other")
  assert.equal(cap("api", "graphql", "-f", "query=mutation { x }"), "api-other")
  assert.equal(cap("api", "graphql", "-f", "query=query { viewer { login } }"), "read")
  assert.equal(cap("frobnicate"), "api-other")
  assert.equal(ghNeed(["auth", "status"]).skip, true)
})

test("gh targets: -R, repo arguments, --org, api paths, current repo", () => {
  assert.deepEqual(ghNeed(["pr", "list", "-R", "acme/app"]).target, { owner: "acme", repo: "app" })
  assert.deepEqual(ghNeed(["repo", "clone", "acme/app"]).target, { owner: "acme", repo: "app" })
  assert.deepEqual(ghNeed(["repo", "create", "new-thing", "--org", "acme"]).target, { owner: "acme" })
  assert.deepEqual(ghNeed(["api", "orgs/acme/teams"]).target, { owner: "acme" })
  assert.equal(ghNeed(["pr", "list"]).usesRepo, true)
  assert.equal(ghNeed(["repo", "create", "solo"]).usesRepo, false)
  assert.equal(ghNeed(["gist", "list"]).usesRepo, false)
})
