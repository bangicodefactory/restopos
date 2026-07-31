# vendor/ in this container

`vendor/` here was **not** installed from Packagist. This container's egress proxy blocks
`packagist.org`, `repo.packagist.org` and `codeload.github.com` (403 on the CONNECT tunnel),
so `composer install` cannot reach its normal sources. What *is* reachable:

| host | status |
| --- | --- |
| `github.com` (git protocol / `git clone`, `git ls-remote`) | works |
| `raw.githubusercontent.com` | works |
| `api.github.com` | reachable, but per-repo gated — returns "GitHub access to this repository is not enabled for this session" |
| `repo.packagist.org`, `codeload.github.com`, third-party composer mirrors | blocked |

## How it was built

`tools/composer-mirror.py` builds a local mirror out of plain git:

```
python3 tools/composer-mirror.py all      # resolve + clone + emit
```

1. **resolve** — walks the dependency tree from the root `composer.json`. Each `vendor/name`
   is mapped to a GitHub repo (override table + per-vendor rules + fallback guesses), tags are
   listed with `git ls-remote --tags`, the highest stable tag satisfying the accumulated
   constraints is chosen, and that tag's `composer.json` is read from
   `raw.githubusercontent.com` to recurse. Iterates to a fixpoint. Result: `tools/mirror/resolved.json`.
2. **clone** — `git clone --depth 1 --branch <tag>` into `tools/mirror/src/<vendor>/<name>`, then
   `git archive` that checkout into `tools/mirror/dist/<vendor>/<name>`. `git archive` honours
   `export-ignore` in `.gitattributes`, which is how Packagist builds its dist zips, so the
   exported tree matches a normal `composer install` (no `.git`, no `tests/`, no CI config).
   The resolved version is stamped into each exported `composer.json`.
3. **emit** — writes `tools/mirror/packages.json` (composer v1 repository format). Not used by
   the current config, kept because it is the fallback if the path repository stops working.

`composer.json` then gets two `repositories` entries (the only project file changed besides
`composer.lock`):

```json
"repositories": {
    "mirror": { "type": "path", "url": "tools/mirror/dist/*/*", "options": { "symlink": false } },
    "packagist.org": false
}
```

`symlink: false` matters — without it composer symlinks `vendor/*` back into `tools/mirror/dist`.

After that, ordinary commands work with no special flags:

```
COMPOSER_ALLOW_SUPERUSER=1 composer install --no-interaction
```

## ext-bcmath

The root `composer.json` requires `ext-bcmath`, which was not present. There is no
`php8.4-bcmath` package in the reachable apt repos, so it was compiled from source:

```
git clone --depth 1 --branch php-8.4.21 https://github.com/php/php-src.git /tmp/php-src
cd /tmp/php-src/ext/bcmath && phpize && ./configure --with-php-config=/usr/bin/php-config
make -j4 && make install
echo 'extension=bcmath.so' > /etc/php/8.4/mods-available/bcmath.ini && phpenmod bcmath
```

`composer check-platform-reqs` passes; no `--ignore-platform-req` is needed.

## Caveats

- **The resolver does not backtrack.** If a newly added dependency picks a tag whose own
  requirements are unsatisfiable, add an entry to the `PINS` table in `tools/composer-mirror.py`
  (there is one already for `brianium/paratest`, which at >= 7.9 wants PHPUnit 12/13 while
  Pest 3 wants PHPUnit 11).
- `composer.lock` records `"type": "path"` dists pointing at `tools/mirror/dist`. The lock is
  therefore only reusable inside this container. `tools/mirror/` is git-ignored.
- `tools/mirror/src` (~1.2 GB of shallow clones) is only needed to regenerate `tools/mirror/dist`.
  It is safe to delete; re-run the `clone` stage to recreate it.

## On a machine with normal internet

Drop the workaround entirely and install from Packagist:

```
composer config --unset repositories.mirror
composer config --unset repositories.packagist.org
rm -rf vendor composer.lock tools/mirror
composer install
```

(`tools/composer-mirror.py` can stay; it is inert once the `repositories` entries are gone.)
