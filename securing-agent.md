# Securing a Personal Agent

Claws won’t reach the mainstream until security is solved. Despite the value that OpenClaw and similar tools offer, people are rightfully nervous about handing their private lives to an LLM with few restrictions.

OpenClaw's security has improved via sandboxes, malware scans, and human approval. However, these measures don’t resolve the fundamental issue. Simon Willison calls it the [**lethal trifecta**](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/): give an LLM private info, untrusted input, and arbitrary network access, and you’ve created the perfect recipe for data exfiltration. A prompt injection attack could have your agent emailing every secret to `pwned@hacker.com`, or fetching `hacker.com/my-ssn-is-123-45-6789`. A separate Mac Mini won't save you.

Modern models resist attacks better than you’d expect \-- for example, nobody ever cracked the [HackMyClaw challenge](https://hackmyclaw.com/). But when the downside is [deleting](https://alexeyondata.substack.com/p/how-i-dropped-our-production-database) [production data](https://x.com/lifeof_jer/status/2048103471019434248) or `rm -rf /`, hope is not a strategy.

Is it possible to solve security for agents? I've been experimenting with another approach in my personal Claw tool, [Clawmini](http://github.com/tbuckley/clawmini). The takeaway: deny network access by default with your primary agent; and use a subagent for any task that requires network, with you as the firewall between them.

# Denying network by default

A truly useful personal agent *must* combine private info and untrusted input (for example, reading your email). Therefore the only safe leg of the trifecta to remove is network access.

Clawmini siloes its agents inside a restricted sandbox behind a network proxy. Agents can run shell commands, but anything touching the network fails. When it needs more, it can escalate to a human for approval to:

* Run a specific one-off command outside the sandbox (`run-host`)  
* Permanently allowlist a specific domain (`allowlist-domain`)  
* Register a script to execute outside the sandbox, so it's easier for the user to understand the request (`manage-policies`)  
* Auto-approve a specific command in the future (`manage-policies`)  
* Update/delete commands (`manage-policies`)

While it may appear limited at first, this occasional approval step is all it takes to create complex workflows.

Let's start by applying this to Google Workspace. A personal assistant needs your email, calendar, and documents. CLIs exist for this: Google’s (unofficial?) [Workspace CLI](https://github.com/googleworkspace/cli) and the OpenClaw-linked [gog CLI](https://gogcli.sh/). But blanket access to your Google account is [dangerous](https://www.businessinsider.com/meta-ai-alignment-director-openclaw-email-deletion-2026-2).

Clawmini's model establishes clear boundaries:

* **Read-only:** auto-approved. Reading your calendar or emails can’t exfiltrate anything[^1].  
* **Private writes:** auto-approved. Email drafts and private Google Docs stay private within my Workspace, which already has my personal data anyway[^2].  
* **Destructive / Outbound actions:** human approval. A sent email or a calendar invite could exfiltrate data, so these are blocked by default.

I had Clawmini build wrappers around the Workspace CLI: `google-workspace-readonly` for all `get`/`list`/`query`/`export` commands; `google-workspace-drafts` for an allowlist of private-write commands; and `google-workspace-full` for the raw `gws` CLI blocked on human approval. Skills instruct the agent to use the first two whenever possible, then fall back to the full policy only when necessary.

# Siloed Subagents: The Web Development Problem

Web development breaks the no-network security model. It is notoriously difficult to lock down a modern web application: a web page can fetch, load remote resources, and navigate anywhere; a pull request on Github can execute arbitrary code. Until browsers catch up, assume any agent building web apps has full network access.

That means cutting off a different leg of the lethal trifecta: personal data or untrusted input. Which one depends on the project – a personal finance dashboard requires personal info, so you should restrict untrusted input. A research dashboard needs to read untrusted webpages, so you should restrict personal data. And an email triage helper is especially tricky since it can receive both.

Architecturally, this means using an isolated subagent for web development:

* You can communicate with it directly  
* Your main agent can read what the web dev subagent creates, but can only send it messages *you* approve, because they could contain personal data or untrusted input

You are the firewall. When your main agent decides you need a web app, it drafts a spec; you review the spec for private keys or PII; then you let it through to the web dev agent.

## Web Browsing

Arbitrary web browsing is a harder case. Creating a wrapper for reading Reddit, Twitter, or your Readwise RSS articles is easy, while letting the agent read arbitrary URLs risks accessing `hacker.com/my-ssn-is-123-45-6789`.

Two mitigations to consider:

* a siloed Research subagent, with you reviewing any requests from the main agent to ensure they avoid personal information.  
* prevent construction of arbitrary URLs, so the agent can only read articles returned in search results or explicitly mentioned by the user. Even then, you need limits to avoid encoding sensitive data over multiple requests (ex. [hacker.com/0](http://hacker.com/0) and [hacker.com/1](http://hacker.com/1) to encode binary).

# Mitigating Friction and Alert Fatigue

After a few months living with the system, the biggest remaining problem is friction for both humans and agents.

Agents can get tangled up with similar-sounding policies and fire off accidental policy requests while exploring; while humans suffer from alert fatigue. Reviewing these requests is daunting, and I certainly don't trust myself to get it right 100% of the time, and we shouldn’t expect everyone to internalize the lethal trifecta to use an assistant.

A better approach is providing a single `google-workspace` command, where `autoApprove` is a script that operates on the arguments. The [Rego policy language](https://www.openpolicyagent.org/docs/policy-language) is one way to deterministically check that command arguments are valid. Policy scripts that can never violate the security model (`readonly`, `private-write`) could be auto-approved, while riskier scripts (`public-write`) are flagged for human review if there’s any risk of data exfiltration.

The agent should also be told before running a command that it will require human approval, so it can avoid spurious requests and batch them together when needed. This may require some cooldown so it can't brute-force approval checks.

When a human must review a request, it should be explained in sufficient detail. For example, when sending an email the request should highlight any personal information or attachments that may encode data, and verify that the user trusts the recipient.

# Next Steps

Clawmini isn’t for everyone, but hopefully this exploration hints at how security can be solved by other tools. As I was writing this post, [OpenAI shipped Lockdown Mode](https://simonwillison.net/2026/Jun/5/openai-help-lockdown-mode/) for ChatGPT, blocking all outbound network traffic. While extreme, it’s a logical baseline to ensure security, and it can be relaxed over time through exactly the kind of human-in-the-loop policies that Clawmini uses.

A one-size-fits-all security model also won’t be sufficient. Different trade-offs are required for different services, like Google Workspace vs web development vs web browsing. I would feel comfortable developing apps with Codex/Claude apps today, assuming they were sandboxed from any personal data. But to go broader, we will need tools that can support each trade-off as well as patterns for them to safely communicate.

Agents will need to learn our personal security preferences. I might treat unshared files in Google Drive as “private”, you might not. Which raises a final question: will agent security end up accelerating lock-in to a single ecosystem?  


[^1]:  For auto-approved requests, you likely still want to include checks that flag potential abuse, in case there’s a vulnerability in your scripts.

[^2]:  There are always edge cases to consider in security. Arguably, inserting a specific tracking link or 1x1 pixel image into a Google Doc or draft email could theoretically exfiltrate data if Google auto-loads the resource on the backend, which is why defense-in-depth is critical. Perhaps you want a wrapper that will block links or remote images in requests.