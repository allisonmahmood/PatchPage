# Onboarding

Agent-led first-time setup: capture how the user's pages should look, then publish their
welcome draft. One question, then a live link.

The user's own words for it are "my welcome page" — that is the setup prompt's phrasing and
it is what to say out loud. *Welcome draft* is the term for it here.

Onboarding is always optional. It makes later publishing nicer; publishing works fine
without it.

## When to run

**Primary trigger — the setup prompt.** The user pasted PatchPage's setup prompt, whose
second step reads, verbatim:

> Then walk me through PatchPage's onboarding: set up how my pages should look and publish
> my welcome page.

Run onboarding as soon as the skill is installed. This sentence is the only primary
trigger: `npx skills add` runs nothing by itself.

**Lazy fallback — after a mint announcement.** An `upload` just printed a mint
announcement and onboarding has never run. Offer it once — "Want me to spend two minutes
setting up how your pages look?" — and drop it if declined.

**On request.** "Redo my PatchPage setup" re-runs the conversation. It overwrites
`style.md` with the new answers and leaves the publishing key untouched.

Those are the only three. There is no per-session first-run check: if none of them fires,
onboarding never happens, and that is the correct outcome.

## Probe before asking

Run the onboarding probe once, at the start:

```bash
npx --yes patchpage status --json
```

It is local-only and answers rather than passes or fails. All seven keys, and what each one
settles:

| Key | Values | Use it to |
| --- | --- | --- |
| `instanceUrl` | the resolved instance URL | Know where the welcome draft will go. Anything other than `https://post.patchyhq.com` means they already run their own — confirm it, do not ask. |
| `instanceSource` | `flag` \| `env` \| `config` \| `default` | Know what pointed the CLI there, so you can say it back: `config` is a saved choice, `env` and `flag` came from this session's environment and will not persist. |
| `hasToken` | boolean | `true` → they already publish. The welcome upload reuses that key, so nothing is minted and there is no announcement to relay. |
| `tokenSource` | `mint` \| `auth-set` \| `null` | Tell a key this machine minted (`mint`) from one saved by hand for their own instance (`auth-set`). `null` with `hasToken: true` means the key comes from the environment, not the state dir — say so rather than promising the saved-file story. |
| `stateDir` | absolute path | Locate `style.md` — it goes in this directory. |
| `hasDefaultStyle` | boolean | `true` → onboarding already ran. Say what the current default look is and ask keep-or-redo instead of asking cold. |
| `cliVersion` | version string | Only worth mentioning if something later misbehaves. |

## The conversation

One question at a time. The user is not technical. *Token*, *instance*, *mint*, and *API*
never reach them outside the own-instance path; the credential is their **publishing key**.

### 1. Style — the only question

Offer exactly two options:

1. **The PatchPage look** (the default): warm paper, bold ink, hand-built and friendly.
   Describe it in one sentence.
2. **Match my website**: ask for the URL, then capture it by the method in
   `style-file.md`. Play the read back in one line before saving ("deep forest green,
   cream, serif headings, plain-spoken — sound right?") and fold in corrections until
   they agree.

Either answer writes `style.md` into the state dir, in the shape `style-file.md`
specifies. Writing it for the default answer too is what stops every later session from
re-asking. A project's own house style still overrides it.

### 2. Where pages live — assumed, never asked

Pages go to PatchPage's free service. Mention it in passing — "your pages will be
published on PatchPage's free service, each with its own shareable link" — which gives a
self-hoster their cue to speak up, and ask nothing. Anyone running their own PatchPage
knows they are; everyone else would only be confused by the question.

Switch to the own-instance path the moment the user asserts their own deployment — "we
host our own", "use our server at …", any phrasing, at any point in the conversation.
There, operator vocabulary is correct: take their instance's API URL, save the token their
operator issued through a hidden prompt with `patchpage auth set --api-url`, and confirm it
with `patchpage whoami` before continuing. See the own-instance section of `SKILL.md`. If
the probe already showed a non-default instance, confirm rather than re-ask.

### 3. Publish the welcome draft

Write `welcome.html` from `welcome-draft.html` in this directory, restyled to the chosen
look — the structure and copy are the deliverable, the styling is theirs — then:

```bash
npx --yes patchpage validate './welcome.html' && npx --yes patchpage upload './welcome.html'
```

That upload is what creates their publishing key. Onboarding has no separate key step:
the CLI mints on the first upload, prints the mint announcement, and continues. Relay the
announcement in plain words rather than pasting it:

> "That created your publishing key — it's saved on this machine, and it's what lets you
> update or delete your pages later. To publish from another computer with the same
> rights, copy that file across; I can help when the time comes."

If the probe reported `hasToken: true`, nothing is minted and there is nothing to relay —
and check `tokenSource` before describing what they hold: `mint` or `auth-set` means the key
is a file in the state dir, `null` means it came from the environment, so the copy-the-file
story does not apply.

Then hand over the URL with the one fact that matters: **anyone with the link can see it,
and it isn't listed anywhere.**

### 4. Sign-off

Close with what to say next time, in their words: "make this a patch page", "publish this
plan", "update my page", "take that page down". One line, not a manual.

## Sample transcripts

### Fast path — default all the way

> **Agent**: Skill installed. One quick question and I'll publish your first page. Looks:
> pages can use the PatchPage look — warm paper, bold ink, friendly — or I can match your
> own website's style. Which would you like?
>
> **User**: default is fine
>
> **Agent**: Done. Publishing your welcome page to PatchPage's free service now… Here it
> is: `https://post.patchyhq.com/d/a1b2c3` — anyone with that link can see it, and it
> isn't listed anywhere. That first publish also created your publishing key, saved on
> this machine; it's what lets you edit or delete your pages later. Next time you want a
> page, just say "make this a patch page".

### Custom path — style from a website, user asserts their own instance

> **Agent**: One quick question — looks. The PatchPage look, or match your website?
>
> **User**: match my site, it's greenfieldpottery.com — and we run our own patchpage at
> pages.greenfield.internal, I have a token from IT
>
> **Agent**: Reading your site… I see deep forest green on cream, serif headings, generous
> space, and plain-spoken copy. I'll use that as your default look — sound right?
>
> **User**: yes but the green should be darker, like the footer
>
> **Agent**: Got it — footer green it is. Saved. Now your instance: I'll take the token in
> a hidden prompt so it never lands in the chat… Verified against
> pages.greenfield.internal. Publishing your welcome page there now…
