# Acceptable Use Policy

**This policy governs the official PatchPage instance** — the free hosted service at
`post.patchyhq.com`, operated by Patchy. It does not apply to self-hosted PatchPage
instances, whose operators set their own rules.

This file is the source copy. The published location is
`https://patchyhq.com/acceptable-use`, exported from `@patchpage/config` as the single
constant `ACCEPTABLE_USE_URL`. Every consumer that links this policy — the self-service
mint response, the served-draft footer, and the README — reads that one constant rather
than repeating the literal, so the URL changes in exactly one place.

The companion [PatchPage privacy notice](https://patchyhq.com/patchpage/privacy) has no
source copy here: it is maintained in the website repo, and it is where every claim
about what the service records lives. When the server changes what it stores, what it
sends to analytics, or how long it keeps any of it, that notice is the file to change.

By publishing a page to the official instance you accept this policy. There is no
signup and nothing to sign: publishing is acceptance.

## The service

PatchPage publishes single-file static HTML pages behind unlisted, link-viewable URLs.
It is free, with no account and no card. On first publish the tool obtains a
**publishing key** for you and saves it on your machine; that key controls the pages it
creates. Keep it safe — a lost key cannot be recovered, and we cannot prove a page is
yours without it.

## What you may not publish

Use PatchPage for documents: plans, briefs, reports, notes, write-ups. Do not publish:

- **Illegal content**, or content that facilitates illegal activity.
- **Phishing or impersonation** — pages that imitate another company's login, brand, or
  identity, or that are designed to deceive readers about who published them.
- **Malware or exploits** — content that attempts to escape the page sandbox, exploit
  viewers' browsers, or distribute malicious code in any form.
- **Spam and SEO abuse** — bulk-published pages, link farms, or content published
  primarily to manipulate search ranking or redirect traffic.
- **Harassment or hate** — content that targets, threatens, or demeans a person or
  group.
- **Other people's private information** — doxxing, leaked credentials, or personal
  data published without consent.
- **Content that infringes** someone else's copyright, trademark, or other rights.
- **Sexual content involving minors** — in any form, without exception. This is
  reported to the relevant authorities.

Pages are static documents by design: they cannot run scripts, set cookies, or collect
data. One thing they can do is load images from other sites, which tells the site
hosting an image the reader's IP address and browser — publishing remote content in
order to profile the people who read your page counts as tracking, and is a violation of
this policy. So is attempting to work around any of these restrictions.

## Fair-use limits

The service is free for everyone, which only works with limits. Currently:

- **Page size**: up to 512 KiB per page.
- **New publishing keys**: up to 5 per network address per day.
- **Live pages**: up to 1,000 per publishing key.
- **Publish rate**: up to 10 new pages per minute per key.

These numbers may change as the service grows. Automated or scripted publishing within
the limits is fine; engineering around the limits is not.

## How long pages stay up

Pages are long-lived, not permanent. A page stays up for at least 90 days after it was
last published or updated, and every visit keeps it alive for at least another 30 days.
A page that nobody reads for months eventually expires and is **permanently deleted** —
expired pages cannot be restored. Republishing the same document before it expires
resets the clock and keeps the link you already shared working.

## Unlisted, not private

Links are long, unguessable, and never listed anywhere by us, and we ask search engines
not to index pages. But anyone with the link can open or reshare it, and a link posted
publicly can still end up in search results. Do not publish secrets, credentials, or
anything you would not hand to a stranger holding the link.

Published pages are served plain: no banners, no cookies, no login, and no tracking by
us. What the service records when you publish a page, what it deliberately does not
record when someone reads one, and the one thing a page itself can still reveal about
its readers, are all set out in the [PatchPage privacy
notice](https://patchyhq.com/patchpage/privacy).

## Reports and takedowns

Every published page carries a report link in its footer. Reports go to a human: we
review them and remove content that violates this policy. Rights holders and anyone
affected by a page can use the same channel. You can also email us — the contact link is
on the [published policy](https://patchyhq.com/acceptable-use).

## Enforcement

We may remove any page, revoke any publishing key, or block any network address, at our
discretion and without prior notice, to enforce this policy or protect the service and
its users. Revoking a key stops it from publishing or updating; content that violates
this policy is removed.

## No warranty

This is a free service provided as-is, with no uptime or availability guarantee. Keep
your own copy of anything you publish — the HTML file on your machine is always the
original. We may change or discontinue the service; self-hosting remains available
regardless (see [SELF_HOSTING.md](SELF_HOSTING.md)).

## Changes

We may update this policy. The current version lives at this address and on
[patchyhq.com](https://patchyhq.com/acceptable-use), which carries the date it last
changed; continued publishing after a change is acceptance of the updated policy.

## Contact us

Questions about this policy? Email us — the contact link is on the [published
policy](https://patchyhq.com/acceptable-use).
