# Onboarding

> **PROTOTYPE — throwaway (wayfinder [#93](https://github.com/allisonmahmood/PatchPage/issues/93)).**
> Draft of the future `references/onboarding.md`, written to react to — not wired into
> `SKILL.md`. Sample transcripts at the bottom show how it should feel.

Agent-led first-time setup: capture the user's default style and deployment choice, then
publish their welcome page. Onboarding is always optional — it makes later publishing
nicer, it is never required for publishing to work.

## When to run

- **Primary trigger**: the install snippet the user pasted asks you to walk them through
  onboarding. Do it immediately after `npx skills add` succeeds.
- **Lazy fallback**: a `patchpage upload` just printed a mint announcement and onboarding
  has never run. Suggest it once — "Want me to spend two minutes setting up how your
  pages look?" — and drop it if declined. Never require it, never nag.
- **Re-run on request**: "redo my patchpage setup" re-runs the conversation. Overwrite
  `style.md` with the new answers; never touch credentials.

There is no per-session first-run check. If neither trigger fires, onboarding simply
never happens, and that is fine.

## Before asking anything

Run the local probe:

```bash
npx --yes patchpage status --json
```

It reports the resolved instance URL (and what set it), whether a token is stored for it,
the state-dir path, and whether `style.md` exists. Use it to skip questions that are
already answered:

- `style.md` exists → say what the current default style is and ask keep-or-redo.
- A token is already stored → skip every deployment question; they already publish somewhere.
- Instance is non-official (env/flag/config) → they self-host; confirm rather than ask.

## The conversation

One question at a time. Plain words throughout — the user is not technical. Never say
*token*, *instance*, *mint*, or *API* unless the user takes the own-server path. Refer to
the token, when it must be mentioned at all, as their **publishing key**.

### 1. Style — how should your pages look?

Offer exactly two options:

1. **The PatchPage look** (default): warm paper, bold ink, hand-built and friendly.
   Describe it in one sentence; do not make them read a style guide.
2. **Match my website**: ask for the URL, fetch it, and pull out what defines it —
   palette, type feel, and tone of voice. Play the read back in one line before saving
   ("deep forest green, cream, serif headings, plain-spoken — sound right?") and adjust
   until they nod.

Either way, write the result to `style.md` in the state dir (find the path in
`status --json`). The file records the *choice*, so no future session re-asks. Format:
see the style-file reference. A project's own house style always overrides this default.

### 2. Where your pages live

Most users want the free official service, which needs no setup at all. Ask only:

> "Your pages will be published on PatchPage's free service — each page gets its own
> link you can share. Or, if you have your own PatchPage server, I can point at that
> instead. Free service?"

- **Free service** (almost everyone): nothing to do. Move on.
- **Own server**: now, and only now, drop into operator vocabulary. Get the server URL,
  then set the operator-issued token with
  `npx --yes patchpage auth set --api-url '<url>'` (hidden prompt, or `--token-stdin`
  in automation). Verify with `npx --yes patchpage whoami` before continuing.

### 3. Publish the welcome page

Generate `welcome.html` in the chosen style — content per the welcome-draft reference —
then:

```bash
npx --yes patchpage validate welcome.html && npx --yes patchpage upload welcome.html
```

On the free-service path this first upload is what creates their publishing key: the CLI
prints a mint announcement naming the save location. Relay it in plain words:

> "That created your publishing key — it's saved on this machine and it's what lets you
> update or delete your pages later. To publish from another computer with the same
> rights, copy that file across; I can help when the time comes."

Then give them the page URL and say the one thing that matters: **anyone with the link
can see it, and it isn't listed anywhere.**

### 4. Sign-off

Close with what to say next time, in their words: "make this a patch page",
"publish this plan", "update my page", "take that page down". One line, not a manual.

## Sample transcripts

### Fast path — defaults all the way (four exchanges)

> **Agent**: Skill installed. Two quick questions and I'll publish your first page.
> First — looks. Pages can use the PatchPage look (warm paper, bold ink, friendly), or I
> can match your own website's style. Which would you like?
> **User**: default is fine
> **Agent**: Done. And your pages will live on PatchPage's free service — each one gets
> its own shareable link. That work, or do you run your own server?
> **User**: free is fine
> **Agent**: Publishing your welcome page now… Here it is:
> `https://post.patchyhq.com/d/a1b2c3` — anyone with that link can see it; it isn't
> listed anywhere. That first publish also created your publishing key, saved on this
> machine — it's what lets you edit or delete your pages later. Next time you want a
> page, just say "make this a patch page."

### Custom path — style from website, own server

> **Agent**: First — looks. The PatchPage look, or match your website?
> **User**: match my site, it's greenfieldpottery.com
> **Agent**: Reading it… I see deep forest green on cream, serif headings, generous
> space, and plain-spoken copy. I'll use that as your default look — sound right?
> **User**: yes but the green should be darker, like the footer
> **Agent**: Got it — footer green it is. Saved. Second: pages normally go to
> PatchPage's free service, or I can point at your own server.
> **User**: we run our own, it's at pages.greenfield.internal — I have a token from IT
> **Agent**: I'll set that up — I'll ask for the token in a hidden prompt so it never
> lands in the chat… Verified. Publishing your welcome page there now…

## Open item checked for this design

The `skills` CLI (`npx skills add`, v1.5.x) has **no install-time hook** — nothing runs
automatically after install. The snippet sentence is therefore the only primary trigger,
as #92 assumed.
