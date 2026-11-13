# Public recorded workbench

The public site is a static publication of the two supported recorded cases.
It does not expose the local repair API, model calls, source compiler or Sandbox.
Fresh source checking and reviewer replay remain local, using the commands in
the case notes and the local interface documentation.

## Build

From a committed checkout with the normal project dependencies installed:

```sh
npm run build:public
npm run test:public
```

The command revalidates the recorded cases and builds `.local/public-site`.
It refuses uncommitted source changes and an existing output directory. Move a
previous generated output aside before rebuilding; keep it for rollback or
comparison when useful. The three generated workbench JSON/ZIP outputs may
change during regeneration; they are not execution results from a fresh run.

The package contains only the recorded workbench, its evidence downloads,
icons/share image, notices, static routing and a SHA-256 file inventory.
`release.json` identifies the exact source commit and labels execution as
recorded. Its inventory excludes `release.json` itself to avoid a circular hash.

## Local Pages preview

With Wrangler v4 installed:

```sh
wrangler pages dev .local/public-site --ip 127.0.0.1 --port 4296
```

The root redirects to `/consequences/`. The absolute base in the workbench is
preserved; deploy the entire generated directory, not just its child folder.
Unknown paths return the explicit 404 page rather than a successful app shell.

## Host and domain

The target is Cloudflare Pages project `near-rehearsal`, production branch
`main`, with public hostname `rehearsal.dolepee.com`.

```sh
wrangler pages deploy .local/public-site --project-name near-rehearsal --branch main
```

Associate the custom hostname in Cloudflare Pages before adding its external
DNS CNAME to `near-rehearsal.pages.dev`. Only the `rehearsal` record changes;
the domain's nameservers and other records remain untouched. Verify DNS, TLS,
redirects, both cases and archive checksums on the custom domain after cutover.

Use a prior verified Pages deployment to roll back an existing release. For
the initial release, removing only the newly created CNAME restores the
domain's previous wildcard behavior. Preserve the generated package and its
manifest as the release's byte-level reference.
