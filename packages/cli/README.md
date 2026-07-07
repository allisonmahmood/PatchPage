# patchpage

CLI for uploading static HTML drafts to PatchPage.

```sh
npx patchpage upload ./plan.html
```

By default the CLI targets `https://post.patchyhq.com`. Use `--api-url` or
`PATCHPAGE_API_URL` for a self-hosted PatchPage service.

This package includes an agent skill at `skills/patchpage/SKILL.md` for creating
safe static HTML drafts in the Patchy visual style. Upload tokens gate publishing;
draft URLs are public and unlisted by default.
