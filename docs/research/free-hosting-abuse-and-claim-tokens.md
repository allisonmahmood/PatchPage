# How free anonymous-publishing services handle abuse and page-claim tokens

Research for [#89](https://github.com/allisonmahmood/PatchPage/issues/89), part of the
[#87 wayfinder](https://github.com/allisonmahmood/PatchPage/issues/87) toward PatchPage as a
free, signup-less, first-party-hosted service. Researched 2026-08-06 against primary sources
(official API docs, ToS/abuse pages, official blog posts, first-party source code); security-vendor
reports are used only to document abuse pressure. Each claim carries its source.

Two questions from the ticket:

- **(a)** How does an anonymous client mint or receive a credential that controls its own uploads?
- **(b)** How do free HTML hosts survive phishing/malware/spam — quotas, retention, takedowns, ToS?

---

## Part A — Anonymous credential / claim-token models

### Telegraph (telegra.ph) — the closest analog

- **Mint:** server-generated, zero signup. `createAccount(short_name, author_name?, author_url?)`
  needs no email or verification and returns an Account object "with the regular fields and an
  additional `access_token` field". ([telegra.ph/api](https://telegra.ph/api))
- **Scope:** the token is the sole controller of everything the account creates — `createPage`,
  `editPage`, `editAccountInfo`, `getPageList` all require it. The Page object's `can_edit` is
  "only returned if access_token passed": the token is what makes a page yours. (same source)
- **Lifecycle:** rotation exists because the token maps to a server-side account object —
  `revokeAccessToken` will "revoke access_token and generate a new one … if the user would like to
  reset all connected sessions", returning a new `access_token` plus a short-lived `auth_url`
  (valid ~5 minutes) that logs a browser into the account — the device-handoff path. No content
  expiry; no recovery for a lost token. (same source)
- **Web-editor variant:** anonymous authorship is bound to the browser; logging in via the
  @Telegraph Telegram bot merges "all posts you've previously written in that device's browser"
  into a durable identity. ([telegram.org/blog/telegraph](https://telegram.org/blog/telegraph))
- **Limits:** page content up to 64 KB; `getPageList` pages 0–200 per request. ([telegra.ph/api](https://telegra.ph/api))

### surge.sh — first-run account creation in the CLI

- Login and signup are the same operation: "Signing in with an email address that has no account
  yet creates the account". The first `surge` run prompts for email+password in the terminal;
  `sdk.token()` exchanges them for a long-lived token — "the only call that needs a password —
  everything after it uses the token". ([surge.sh/docs/sdk/client](https://surge.sh/docs/sdk/client))
- **Storage:** "The Surge CLI writes it to the user's `~/.netrc` file (keyed by API host, with
  `0600` permissions)". (same source)
- **Lifecycle:** real token management because tokens map to an account: `surge tokens
  list/add/rem`, domain-scoped tokens that "can only publish to their designated domain", tokens
  "shown once, at mint time", and `surge logout` expires the netrc token server-side.
  ([surge.sh/docs/cli/account](https://surge.sh/docs/cli/account))
- **Namespace:** first publish binds a `*.surge.sh` subdomain to the account; later publishers hit
  `Aborted - you do not have permission to publish to <name>.surge.sh` (CLI behavior documented
  secondhand in [can-i-take-over-xyz#198](https://github.com/EdOverflow/can-i-take-over-xyz/issues/198)).

### 0x0.st (The Null Pointer) — per-file management token

- **Mint:** server-generated, delivered once as a response header: "Whenever a file that does not
  already exist or has expired is uploaded, the HTTP response header includes an X-Token field."
  Content-addressed dedup means only the *first* uploader of given bytes ever holds the token.
- **Scope:** delete-only plus expiry change: `curl -Ftoken=… -Fdelete=` / `curl -Ftoken=… -Fexpires=3`.
- **Retention as policy:** "File URLs are valid for at least 30 days and up to a year" via
  `retention = min_age + (-max_age + min_age) * pow((file_size / max_size - 1), 3)` with
  min_age 30 d, max_age 1 y, max_size 512 MiB — bigger files expire sooner, automatically.
- Sourcing caveat: 0x0.st and git.0x0.st were unreachable during research; quotes are from the
  official front-page template preserved verbatim in a source mirror
  ([stevalkr/0x0 templates/index.html](https://github.com/stevalkr/0x0/blob/master/templates/index.html)).

### transfer.sh — delete-URL-as-token

- Upload response carries `x-url-delete: https://transfer.sh/hello.txt/BAYh0/hello.txt/PDw0NHPcqU`;
  the random trailing segment is the delete token, used via `curl -X DELETE <url>`. Retention is
  set only at upload time (`Max-Downloads`, `Max-Days`); operators configure `purge-days` and can
  enable ClamAV prescan of every upload. ([dutchcoders/transfer.sh README](https://github.com/dutchcoders/transfer.sh))

### PrivateBin / Pastebin — delete tokens vs no token at all

- **PrivateBin:** "the delete token is returned only on creation of a paste and can be used to
  delete it and its comments" — creation response `{"status":0,"id":…,"url":…,"deletetoken":…}`;
  pastes are immutable so the token is delete-only; expiry set at creation.
  ([PrivateBin wiki/API](https://github.com/PrivateBin/PrivateBin/wiki/API))
- **Pastebin guests (anti-pattern baseline):** no token at all — "If you pasted something as a
  guest, there is no quick delete option"; guests get 10 pastes/day and 512 KB max (Pro: 250/day,
  10 MB), and only accounts get "full control … at any point in the future".
  ([pastebin.com/faq](https://pastebin.com/faq))

### Glitch — anonymous identity object + claim-by-token merge

- Official Glitch frontend code shows the mechanism: `const { persistentToken } = await
  api.post('/users/anon')`, with the comment that sign-in/sign-up "associates any projects created
  while anonymous with your email address so it needs a persistentToken" — anonymous users are
  real server-side user rows keyed by a token, and account signup merges anonymous projects by
  presenting it. ([glitchdotcom/Pupdates-CMS current-user.js](https://github.com/glitchdotcom/Pupdates-CMS/blob/master/frontend/current-user.js))
- Retention penalty for staying anonymous: "Projects created by anonymous users expire after
  5 days (login … to keep your projects around)".
  ([glitchdotcom/glitch-about-and-marketing faq.jade](https://github.com/glitchdotcom/glitch-about-and-marketing/blob/master/views/faq.jade))

### Netlify Drop / `--allow-anonymous` — claim window, not a controller token

- "To deploy without logging in or creating a Netlify account, use `netlify deploy
  --allow-anonymous`. This creates a temporary project with a live URL that you can claim within
  one hour." When claimed, the project adopts the claiming team's settings; unclaimed deploys are
  removed. The secret here is the claim URL itself — an upgrade voucher, not a long-lived
  credential. ([docs.netlify.com/deploy/create-deploys](https://docs.netlify.com/deploy/create-deploys/))

### rentry.co, catbox.moe, tiiny.host — edit codes, userhash, keepalive

- **rentry.co:** client-chosen edit code at creation — "Without this code you have no control over
  your entry"; a scoped secondary "modify code … can only be used to edit the Rentry's text";
  support-mediated recovery exists (owner verification). ([rentry.co/what](https://rentry.co/what))
- **catbox.moe:** account-derived `userhash` passed to the API; "for anonymous uploads, simply
  don't supply a userhash" — but then "Albums created anonymously CANNOT be edited or deleted".
  Anonymous files are pruned after 2 years of no hits; account uploads are permanent.
  ([catbox.moe/tools.php](https://catbox.moe/tools.php), [catbox.moe/faq.php](https://catbox.moe/faq.php))
- **tiiny.host:** free tier is account-bound with an activity TTL — free users must "login at
  least once every three months" or the account and links may be terminated; deleted content is
  restorable from operator backups via support.
  ([helpdesk.tiiny.host](https://helpdesk.tiiny.host/en/article/why-has-my-project-been-deleted-1pjvdkr/))

### Cross-service token patterns

1. **Capability token = ownership; loss is unrecoverable by design.** Telegraph access_token,
   0x0 X-Token, transfer.sh delete URL, PrivateBin deletetoken: possession is the entire authz
   model. Recovery exists only where a human identity sits behind the token (surge email accounts,
   rentry support verification, tiiny.host backups).
2. **Server mints once, shows once.** Every server-generated secret is delivered exactly once at
   creation (PrivateBin "returned only on creation"; 0x0 only when the file "does not already
   exist"; surge tokens "shown once, at mint time"). A first-run CLI must persist immediately or
   the artifact is orphaned.
3. **Delete-scope vs edit-scope follows content mutability.** Immutable-content services issue
   delete-only tokens (0x0, transfer.sh, PrivateBin); mutable-content services issue edit tokens
   (Telegraph, rentry). A second axis is full-control vs shareable reduced-scope secrets (rentry's
   modify code, surge's domain-scoped tokens).
4. **Rotation/revocation exists only where the token maps to a server-side account object.**
   Telegraph (`revokeAccessToken`), surge (`tokens rem`, logout), Glitch (persistentToken → user
   row). Pure per-object tokens (0x0, transfer.sh, PrivateBin) can never rotate — the token *is*
   the object's ACL.
5. **Anonymous content gets a short TTL unless claimed — or the token is a first-class owner.**
   Glitch: 5 days unless logged in; Netlify: 1-hour claim window; tiiny.host: quarterly-login
   keepalive; catbox: 2-year inactivity pruning. Telegraph and rentry instead keep anonymous
   content indefinitely because the token/edit code is real ownership. This is the key design fork.
6. **First-writer-wins namespace claiming.** Surge subdomains bind on first publish; 0x0's dedup
   gives the first uploader of identical bytes the only management token ever issued.
7. **Anonymous→account upgrade = presenting the anonymous token.** Glitch's login email carries
   the persistentToken so projects attach to the new account; Telegraph's bot login absorbs the
   browser's posts; Netlify's claim link binds the deploy to whoever authenticates first.

---

## Part B — Abuse handling for free HTML hosting

### The pressure is real and specifically targets low-friction HTML hosts

- **Telegraph** — the closest analog — is the cautionary tale for shipping tokens without
  guardrails: INKY documented a steep rise in phishing hosted on telegra.ph ("over 90% of all
  detections occurred this year" as of mid-2022); coverage notes that as "an anonymous publishing
  platform, without a way to report abuse, it's become a haven for spammers and phishing attacks",
  used for credential-harvesting pages and crypto scams.
  ([BleepingComputer on the INKY report](https://www.bleepingcomputer.com/news/security/telegram-s-blogging-platform-abused-in-phishing-attacks/),
  [Security Boulevard/INKY](https://securityboulevard.com/2022/06/inky-identifies-telegraph-as-platform-for-phishing-campaigns/))
- **Cloudflare pages.dev/workers.dev:** phishing incidents on Cloudflare Pages nearly tripled
  year-over-year (460 in 2023 → 1,370 by mid-Oct 2024, ~257%); attackers choose these domains for
  the trusted branding and free TLS.
  ([Fortra](https://www.fortra.com/blog/cloudflare-pages-workers-domains-increasingly-abused-for-phishing))
- The pattern generalizes: any free host whose URLs inherit a trusted domain's reputation becomes
  a phishing distribution channel; email filters won't block the domain, so the host must police
  content itself.

### Cautionary tales (official statements)

- **Heroku free tier (2022):** "Our product, engineering, and security teams are spending an
  extraordinary amount of effort to manage fraud and abuse of the Heroku free product plans" —
  free dynos/Postgres/Redis discontinued Nov 28, 2022, inactive accounts deleted.
  ([heroku.com/blog/next-chapter](https://www.heroku.com/blog/next-chapter))
- **Glitch (2025):** ended app hosting July 8, 2025 — "It takes a lot of time and money to run
  millions of apps, and that has increased as bad actors try to misuse the platform."
  ([blog.glitch.com](https://blog.glitch.com/post/changes-are-coming-to-glitch/))
- **Netlify (2024):** a free-tier static site hit by a DDoS ran up 190 TB of traffic and a
  $104,500 bill; Netlify's CEO waived it and stated the policy is to waive attack-driven overages
  rather than hard-stop free sites — i.e. even bandwidth is an abuse surface, and billing policy
  is part of trust. ([Netlify support forum thread](https://answers.netlify.com/t/netlify-billing-horror-story/113392),
  [Cybernews summary](https://cybernews.com/news/ddos-attack-104k-bill-from-hosting-provider/))
- **transfer.sh:** the public instance is gone; the repo explicitly disclaims responsibility for
  public installs. Pure-anonymous file hosts tend to die or rotate operators.
  ([dutchcoders/transfer.sh](https://github.com/dutchcoders/transfer.sh))
- **Pastebin (2020):** removed built-in search and discontinued its Scraping API "due to active
  abuse by third parties for commercial purposes" — feature removal as an abuse response.
  ([pastebin.com/doc_scraping_api](https://pastebin.com/doc_scraping_api))
- Abuse pressure is documented on essentially every free host with public URLs: Firebase
  `*.web.app` phishing waves ([Group-IB](https://www.group-ib.com/blog/gtfire-phishing-scheme/)),
  Vercel `*.vercel.app` campaigns ([Kaseya](https://www.kaseya.com/blog/phishing-campaigns-abusing-vercels-free-hosting-platform/)),
  GitHub/raw.githubusercontent credential-theft and payload staging with ~2-week takedown lag
  ([Cofense](https://cofense.com/blog/the-growing-abuse-of-github-and-gitlab-in-phishing-campaigns)),
  and recurring auto-generated phishing on `*.surge.sh`.
- The distilled lesson: **free anonymous hosting attracts industrialized abuse, and the only
  levers that have worked are friction, expiry, or money.** Heroku chose money, Glitch chose
  shutdown, Netlify chose claim-windows + waivers, 0x0/catbox chose expiry + content rules.

### Guardrail mechanics observed

**Quotas and size limits (every survivor has them):**

| Service | Anonymous/free limits | Source |
|---|---|---|
| Pastebin guest | 512 KB/paste, 10 pastes per 24 h, no private pastes | [faq](https://pastebin.com/faq) |
| Telegraph | 64 KB page content | [api](https://telegra.ph/api) |
| GitHub Pages | 1 GB site, soft 100 GB/mo bandwidth, soft 10 builds/h; no commercial use | [docs](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) |
| 0x0.st | 512 MiB, retention shrinks with size | [source template](https://github.com/stevalkr/0x0/blob/master/templates/index.html) |
| tiiny.host free | 1 live site, small upload cap, quarterly-login keepalive | [helpdesk](https://helpdesk.tiiny.host/en/article/why-has-my-project-been-deleted-1pjvdkr/) |

**Retention/expiry as the primary abuse control:** 0x0's size-scaled 30–365 day TTL; Glitch's
5-day anonymous expiry; Netlify's 1-hour claim window; catbox's 2-year inactivity pruning;
transfer.sh's operator-set purge-days. Expiry caps the damage of anything that slips through and
keeps storage costs bounded without human review.

**The best single case study — Netlify's Drop ratchet:** Netlify's own retrospective, "The
13-year story of Netlify Drop", documents the whole arc on one product: a 2020 internal memo
titled "Let's Sunset Netlify Drop" (abused for phishing, fraud, junk sites); Jan 2022 cut the
anonymous claim window from 24 h to 1 h and capped anonymous drops at **3 per IP**; after a 2024
fraud wave ("most reported scam sites turned out to be drops") drops became **password-protected
until claimed** — public only after an identity attaches; and a 2025 cleanup found ~14 million
unclaimed drops, leading to suspend-then-delete-after-one-week. Each ratchet is friction, expiry,
or identity. ([netlify.com/blog/thirteen-years-of-netlify-drop](https://www.netlify.com/blog/thirteen-years-of-netlify-drop/))

**Takedown / report flows:** Pastebin pairs its ToS with a dedicated
[report-abuse page](https://pastebin.com/report-abuse) and abuse email, and reserves "the right
(though not the obligation) to refuse or remove any User-Generated Content that, in our sole
discretion, violates any Pastebin terms" plus termination "with or without cause, with or without
notice" ([ToS](https://pastebin.com/doc_terms_of_service)). tiiny.host takes reports at a support
address and states "Content violating these policies will be removed without notice, and repeated
violations will result in permanent account termination" — and notably refuses whole content
classes **on the free plan specifically**, citing "a large volume of spam and malicious content";
hosting them requires a paid plan, making identity+payment the accountability gate
([tiiny.host helpdesk](https://helpdesk.tiiny.host/en/article/were-unable-to-host-this-type-of-content-on-our-free-plan-1l9v94w/)).
Val Town's ToS reserves the right to "remove any Content from the Services at any time, for any
reason" and bans fraudulent/deceptive content, spam, and circumventing rate limits
([val.town/termsofuse](https://www.val.town/termsofuse)). Vercel runs a dedicated abuse form
([vercel.com/abuse](https://vercel.com/abuse)). Telegraph's *lack* of a report channel is
explicitly cited in the phishing coverage. A visible report path is table stakes.

**ToS that names the abuse:** Pastebin bans content that "contains or installs any active malware
or exploits, or uses our platform for exploit delivery", spam relays, and posting others' personal
information ([ToS](https://pastebin.com/doc_terms_of_service)); GitHub Pages bans commercial
hosting outright ([limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits));
catbox bans malware and specific file types (.exe, .scr, .cpl, .doc*, .jar)
([faq](https://catbox.moe/faq.php)).

**Technical mitigations:**

- **Content-type neutralization:** catbox serves would-be-active content as plain text "because
  that's called security" ([faq](https://catbox.moe/faq.php)); GitHub serves raw repo content as
  `text/plain` with `X-Content-Type-Options: nosniff` so it can't render as a web page
  ([github.blog 2013](https://github.blog/2013-04-24-heads-up-nosniff-header-support-coming-to-chrome-and-firefox/)).
  Not fully available to PatchPage (rendered HTML is the product) — which is exactly why the
  other layers matter more for us.
- **Separate user-content origin:** GitHub's 2013 move of Pages from `*.github.com` to
  `*.github.io` is the canonical citation — done explicitly to stop related-domain cookie attacks
  and phishing that borrows the trusted domain: "any website hosted under the github.com domain
  may be assumed to be an official GitHub product".
  ([github.blog: New GitHub Pages domain](https://github.blog/news-insights/the-library/new-github-pages-domain-github-io/))
- **Public Suffix List:** the PSL private section exists for operators who "issue subdomains to
  mutually-untrusting parties" — cookie isolation and per-site reputation. But submissions require
  proof of domain control, registration extending 2+ years, and the PSL rejects "small projects or
  experimental / lab requests or short-term entries" — so plan the user-content domain early, and
  expect PSL listing only once the service has real scale.
  ([PSL guidelines](https://github.com/publicsuffix/list/wiki/Guidelines), [publicsuffix.org/submit](https://publicsuffix.org/submit/))
- **Scanning:** transfer.sh ships optional ClamAV prescan of every upload
  ([README](https://github.com/dutchcoders/transfer.sh)); larger hosts rely on Safe Browsing-style
  feeds. Cheap first pass: hash/URL blocklists and phishing-keyword heuristics at upload time.
- **Rate limits on anonymous creation:** Pastebin's per-day guest caps; PatchPage already has
  `PATCHPAGE_ANONYMOUS_CREATE_RATE_LIMIT_PER_MINUTE` in `packages/config` — same family.

---

## Recommendations for PatchPage

1. **Adopt the Telegraph shape, deliberately.** Server-mints a token on first `npx patchpage` run
   with zero signup; the token maps to a server-side "publisher" object (not per-draft tokens) so
   listing, rotation (`revokeAccessToken`-style), and revocation are possible. Store it in
   `~/.patchpage` with 0600 perms, surge-style. Avoid the 0x0/transfer.sh per-object token model —
   no rotation, no listing, unrecoverable.
2. **Be honest that token loss = ownership loss**, and blunt it with expiry: orphaned drafts age
   out on their own (answers the "my laptop died" open question in #87 — recovery is "republish",
   not support tickets, at least at first).
3. **Expiry-by-default with activity/claim-to-extend.** Free anonymous drafts get a bounded TTL
   (0x0's size-scaled formula and Glitch's claim-to-keep are both good shapes); republishing or
   token-authenticated touch extends. This is the single highest-leverage guardrail: it bounds
   storage cost and limits phishing shelf life without any moderation staffing.
4. **Consider not-public-until-claimed for anonymous drafts** (Netlify's 2024 move:
   password-protected until an identity attaches). Drafts reachable only via an unguessable URL —
   or gated until the minting token touches them — kill the phishing use case (phishers need
   stable public URLs) while preserving "share a draft for review". Alongside it: unguessable
   subdomains/paths and `noindex` on anonymous drafts.
5. **Keep hard quotas from day one:** per-draft size cap (Telegraph survives on 64 KB; PatchPage
   drafts are single HTML files, so a small cap is natural), drafts-per-token cap, per-IP creation
   caps (Netlify: 3 anonymous drops per IP), and the existing anonymous-create rate limit
   tightened for the public instance.
6. **Serve drafts from a dedicated user-content domain from day one** (the github.io precedent),
   never from the product/API origin. Plan for PSL private-section listing, but expect it only
   once the service has scale — the PSL rejects small/experimental entries and wants 2+ years of
   domain registration.
7. **Ship a report-abuse path at launch, not later.** A visible report link on every draft page +
   an abuse contact + operator kill-switch (delete draft, revoke token, ban IP), plus free
   Safe Browsing/URLhaus lookups on reports — and expect the whole domain to get flagged if
   takedowns are slow. Telegraph's missing report channel is the documented failure mode. Write
   ToS that names phishing, malware, and spam and reserves sole-discretion removal (Pastebin's
   and tiiny.host's wording are good templates).
8. **Plan the abuse budget, not just the infra budget.** Heroku and Glitch both cited abuse-fight
   cost, not hosting cost, as the free-tier killer. Cheap-for-one-operator layers: quotas, TTLs,
   rate limits, blocklists, report+kill-switch. Staffing-heavy layers to defer: proactive
   scanning, appeals. Bound the bandwidth exposure too: behind a CDN with hard caps, hard-fail
   beyond quota rather than absorb unbounded egress (the Netlify $104k lesson). If abuse outruns
   the cheap layers, the historical outcomes are friction (claim windows), expiry (shorter TTLs),
   or money (tiiny.host's "risky content is paid-only") — decide in advance which lever PatchPage
   pulls first.

## Source index

Primary: [telegra.ph/api](https://telegra.ph/api) · [telegram.org/blog/telegraph](https://telegram.org/blog/telegraph) ·
[surge.sh/docs/sdk/client](https://surge.sh/docs/sdk/client) · [surge.sh/docs/cli/account](https://surge.sh/docs/cli/account) ·
[0x0 source template](https://github.com/stevalkr/0x0/blob/master/templates/index.html) ·
[dutchcoders/transfer.sh](https://github.com/dutchcoders/transfer.sh) ·
[PrivateBin API wiki](https://github.com/PrivateBin/PrivateBin/wiki/API) ·
[pastebin.com/faq](https://pastebin.com/faq) · [pastebin ToS](https://pastebin.com/doc_terms_of_service) ·
[Glitch Pupdates-CMS source](https://github.com/glitchdotcom/Pupdates-CMS/blob/master/frontend/current-user.js) ·
[Glitch FAQ source](https://github.com/glitchdotcom/glitch-about-and-marketing/blob/master/views/faq.jade) ·
[blog.glitch.com shutdown](https://blog.glitch.com/post/changes-are-coming-to-glitch/) ·
[heroku.com/blog/next-chapter](https://www.heroku.com/blog/next-chapter) ·
[docs.netlify.com create-deploys](https://docs.netlify.com/deploy/create-deploys/) ·
[Netlify Drop retrospective](https://www.netlify.com/blog/thirteen-years-of-netlify-drop/) ·
[github.io domain move](https://github.blog/news-insights/the-library/new-github-pages-domain-github-io/) ·
[val.town/termsofuse](https://www.val.town/termsofuse) ·
[tiiny.host free-plan content policy](https://helpdesk.tiiny.host/en/article/were-unable-to-host-this-type-of-content-on-our-free-plan-1l9v94w/) ·
[publicsuffix.org/submit](https://publicsuffix.org/submit/) ·
[pastebin scraping API notice](https://pastebin.com/doc_scraping_api) ·
[rentry.co/what](https://rentry.co/what) · [catbox.moe/faq.php](https://catbox.moe/faq.php) ·
[catbox.moe/tools.php](https://catbox.moe/tools.php) ·
[tiiny.host helpdesk](https://helpdesk.tiiny.host/en/article/why-has-my-project-been-deleted-1pjvdkr/) ·
[GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) ·
[PSL guidelines](https://github.com/publicsuffix/list/wiki/Guidelines).
Abuse-pressure reporting: [BleepingComputer/INKY on Telegraph phishing](https://www.bleepingcomputer.com/news/security/telegram-s-blogging-platform-abused-in-phishing-attacks/) ·
[Fortra on pages.dev/workers.dev](https://www.fortra.com/blog/cloudflare-pages-workers-domains-increasingly-abused-for-phishing) ·
[Netlify billing thread](https://answers.netlify.com/t/netlify-billing-horror-story/113392) ·
[surge takeover-behavior issue](https://github.com/EdOverflow/can-i-take-over-xyz/issues/198) (secondhand).
