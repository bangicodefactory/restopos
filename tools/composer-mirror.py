#!/usr/bin/env python3
"""
composer-mirror.py -- build a local "mini-packagist" for this container.

Why: the outbound proxy blocks packagist.org / repo.packagist.org / codeload.github.com,
but plain `git` over https://github.com and https://raw.githubusercontent.com both work.

What it does:
  resolve : walk the dependency tree of the root composer.json. For each package it
            maps `vendor/name` -> a GitHub repo, lists tags with `git ls-remote`,
            picks the highest stable tag satisfying the accumulated constraints, and
            fetches that tag's composer.json from raw.githubusercontent.com.
  clone   : `git clone --depth 1 --branch <tag>` every resolved package into
            tools/mirror/src/<vendor>/<name>
  emit    : write tools/mirror/packages.json (composer v1 repository format). Every
            version entry carries BOTH a `dist` of type `path` (pointing at the local
            clone) and a `source` of type `git` (pointing at the same local clone), so
            `composer install` works with or without --prefer-source.
  all     : resolve + clone + emit

Usage: python3 tools/composer-mirror.py all [--no-dev]
"""

import concurrent.futures
import json
import os
import re
import subprocess
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MIRROR = os.path.join(ROOT, "tools", "mirror")
CACHE = os.path.join(MIRROR, "cache")
SRC = os.path.join(MIRROR, "src")
DIST = os.path.join(MIRROR, "dist")
RESOLVED = os.path.join(MIRROR, "resolved.json")
PACKAGES_JSON = os.path.join(MIRROR, "packages.json")

# ---------------------------------------------------------------- repo mapping

# exact package-name -> github "owner/repo"
OVERRIDES = {
    "nesbot/carbon": "briannesbitt/Carbon",
    "monolog/monolog": "Seldaek/monolog",
    "phpoption/phpoption": "schmittjoh/php-option",
    "psy/psysh": "bobthecow/psysh",
    "nikic/php-parser": "nikic/PHP-Parser",
    "egulias/email-validator": "egulias/EmailValidator",
    "tijsverkoyen/css-to-inline-styles": "tijsverkoyen/CssToInlineStyles",
    "carbonphp/carbon-doctrine-types": "CarbonPHP/carbon-doctrine-types",
    "tightenco/ziggy": "tighten/ziggy",
    "fakerphp/faker": "FakerPHP/Faker",
    "pusher/pusher-php-server": "pusher/pusher-http-php",
    "evenement/evenement": "igorw/evenement",
    "ratchet/rfc6455": "ratchetphp/RFC6455",
    "phpunit/phpunit": "sebastianbergmann/phpunit",
    "phpunit/php-code-coverage": "sebastianbergmann/php-code-coverage",
    "phpunit/php-file-iterator": "sebastianbergmann/php-file-iterator",
    "phpunit/php-invoker": "sebastianbergmann/php-invoker",
    "phpunit/php-text-template": "sebastianbergmann/php-text-template",
    "phpunit/php-timer": "sebastianbergmann/php-timer",
    "myclabs/deep-copy": "myclabs/DeepCopy",
    "theseer/tokenizer": "theseer/tokenizer",
    "brianium/paratest": "paratestphp/paratest",
    "jean85/pretty-package-versions": "Jean85/pretty-package-versions",
    "ta-tikoma/phpunit-architecture-test": "ta-tikoma/phpunit-architecture-test",
    "clue/ndjson-react": "clue/reactphp-ndjson",
    "clue/redis-protocol": "clue/redis-protocol",
    "clue/socket-raw": "clue/socket-raw",
    "clue/stdio-react": "clue/reactphp-stdio",
    "clue/term-react": "clue/reactphp-term",
    "clue/utf8-react": "clue/reactphp-utf8",
    "fig/http-message-util": "php-fig/http-message-util",
    "webmozart/assert": "webmozarts/assert",
    "hamcrest/hamcrest-php": "hamcrest/hamcrest-php",
    "sebastian/version": "sebastianbergmann/version",
    "phpstan/phpstan": "phpstan/phpstan",
    "symfony/polyfill-php83": "symfony/polyfill-php83",
    "spatie/error-solutions": "spatie/error-solutions",
    "spatie/ignition": "spatie/ignition",
    "spatie/laravel-ignition": "spatie/laravel-ignition",
    "spatie/backtrace": "spatie/backtrace",
    "spatie/flare-client-php": "spatie/flare-client-php",
    "filp/whoops": "filp/whoops",
    "staabm/side-effects-detector": "staabm/side-effects-detector",
    "phpdocumentor/reflection-docblock": "phpDocumentor/ReflectionDocBlock",
    "phpdocumentor/reflection-common": "phpDocumentor/ReflectionCommon",
    "phpdocumentor/type-resolver": "phpDocumentor/TypeResolver",
    "phpstan/phpdoc-parser": "phpstan/phpdoc-parser",
    "psr/log": "php-fig/log",
    "openspout/openspout": "openspout/openspout",
    "composer/pcre": "composer/pcre",
    "composer/semver": "composer/semver",
    "composer/class-map-generator": "composer/class-map-generator",
    "composer/xdebug-handler": "composer/xdebug-handler",
    "seld/jsonlint": "Seldaek/jsonlint",
    "seld/phar-utils": "Seldaek/phar-utils",
    "seld/signal-handler": "Seldaek/signal-handler",
    "nunomaduro/termwind": "nunomaduro/termwind",
    "termwind/termwind": "nunomaduro/termwind",
    "dnoegel/php-xdg-base-dir": "dnoegel/php-xdg-base-dir",
    "wikimedia/less.php": "wikimedia/less.php",
    "guzzlehttp/uri-template": "guzzle/uri-template",
    "laravel/serializable-closure": "laravel/serializable-closure",
    "league/uri": "thephpleague/uri",
    "league/uri-interfaces": "thephpleague/uri-interfaces",
    "dflydev/dot-access-data": "dflydev/dflydev-dot-access-data",
    "fidry/cpu-core-counter": "theofidry/cpu-core-counter",
    "graham-campbell/result-type": "GrahamCampbell/Result-Type",
}

# Extra constraints applied on top of whatever the tree asks for. This resolver does
# not backtrack, so a handful of packages have to be pinned by hand where a newer tag
# that satisfies its parent pulls in an incompatible transitive requirement.
#   brianium/paratest >= 7.9 requires phpunit ^12/^13, but pest 3.x requires phpunit ^11.
PINS = {
    "brianium/paratest": "<7.9",
}

# vendor prefix -> github owner
VENDOR_MAP = {
    "psr": "php-fig",
    "guzzlehttp": "guzzle",
    "league": "thephpleague",
    "react": "reactphp",
    "sebastian": "sebastianbergmann",
    "phar-io": "phar-io",
    "doctrine": "doctrine",
    "symfony": "symfony",
    "laravel": "laravel",
    "illuminate": "illuminate",
}

# packages that never exist as real repos
SKIP_PREFIXES = ("php", "ext-", "lib-", "composer-plugin-api", "composer-runtime-api", "composer-api")


def is_virtual(name):
    if name in ("php", "php-64bit", "php-ipv6", "hhvm", "composer", "composer-plugin-api",
                "composer-runtime-api"):
        return True
    if name.startswith(("ext-", "lib-")):
        return True
    if name.endswith("-implementation"):
        return True
    if "/" not in name:
        return True
    return False


def candidate_repos(name):
    """Ordered guesses for the github repo backing a composer package name."""
    if name in OVERRIDES:
        yield OVERRIDES[name]
    vendor, short = name.split("/", 1)
    if vendor in VENDOR_MAP:
        yield "%s/%s" % (VENDOR_MAP[vendor], short)
    yield name
    yield "%s/%s" % (vendor, short.replace("-", ""))
    yield "%s/php-%s" % (vendor, short)
    yield "%s/%s-php" % (vendor, short)
    yield "%s/%s" % (vendor, "".join(p.capitalize() for p in short.split("-")))
    yield "%s/php-%s" % (vendor, short.replace("-", ""))


# ------------------------------------------------------------------- versions

STABILITY_RANK = {"dev": 0, "alpha": 1, "a": 1, "beta": 2, "b": 2, "rc": 3, "stable": 4,
                  "pl": 5, "p": 5, "patch": 5}

VERSION_RE = re.compile(
    r"^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?"
    r"(?:[-._+]?(dev|alpha|a|beta|b|rc|pl|p|patch)[-._]?(\d*))?"
    r"(?:\+[0-9A-Za-z.\-]+)?$", re.I)


def parse_version(text):
    """-> (major, minor, patch, extra, stability_rank, stability_num) or None."""
    if text is None:
        return None
    m = VERSION_RE.match(text.strip())
    if not m:
        return None
    nums = [int(m.group(i)) if m.group(i) else 0 for i in range(1, 5)]
    suffix = (m.group(5) or "").lower()
    if suffix:
        rank = STABILITY_RANK.get(suffix, 4)
        snum = int(m.group(6)) if m.group(6) else 0
    else:
        rank, snum = 4, 0
    return tuple(nums) + (rank, snum)


def is_stable(v):
    return v[4] >= 4


def bump(v, index):
    """Next significant release boundary at position `index` (0=major,1=minor,...)."""
    out = list(v[:4])
    out[index] += 1
    for i in range(index + 1, 4):
        out[i] = 0
    return tuple(out) + (0, 0)  # dev-rank so prereleases of the boundary are excluded


def pad(text):
    """Constraint operand -> version tuple, remembering how many parts were given."""
    m = VERSION_RE.match(text.strip())
    if not m:
        return None, 0
    given = sum(1 for i in range(1, 5) if m.group(i) is not None)
    return parse_version(text), max(given, 1)


def cmp_v(a, b):
    return (a > b) - (a < b)


def _term_ok(v, term):
    term = term.strip()
    if not term or term in ("*", "@stable", "@dev"):
        return True
    term = term.split("@")[0].strip() or "*"
    if term == "*":
        return True
    if term.startswith("dev-") or term.endswith("-dev") or term.endswith(".x-dev"):
        return False

    m = re.match(r"^(\^|~|>=|<=|!=|<>|==|=|>|<)?\s*(.+)$", term)
    op = m.group(1) or "="
    operand = m.group(2).strip()

    # 1.2.* / 1.*
    if operand.endswith(".*") or operand.endswith(".x"):
        base = operand[:-2]
        bv, given = pad(base)
        if bv is None:
            return True
        lo = tuple(bv[:4]) + (0, 0)
        hi = bump(bv, given - 1)
        return lo <= v < hi
    if operand in ("*", "x"):
        return True

    ov, given = pad(operand)
    if ov is None:
        return True

    if op == "^":
        # first non-zero part is the significant one
        idx = 0
        for i in range(4):
            if ov[i] != 0:
                idx = i
                break
        else:
            idx = max(given - 1, 0)
        return ov <= v < bump(ov, idx)
    if op == "~":
        if given == 1:
            return ov <= v < bump(ov, 0)
        return ov <= v < bump(ov, given - 2)
    if op in (">=",):
        return v >= ov
    if op in (">",):
        return v > ov
    if op in ("<=",):
        return v <= ov
    if op in ("<",):
        return v < ov
    if op in ("!=", "<>"):
        return v[:given] != ov[:given]
    # exact / partial equality
    return v[:given] == ov[:given] and (given >= 4 or v[given:4] == (0,) * (4 - given))


def satisfies(v, constraint):
    """v is a parsed version tuple; constraint is a composer constraint string."""
    if v is None:
        return False
    constraint = (constraint or "*").strip()
    if not constraint or constraint == "*":
        return True
    for group in re.split(r"\s*\|\|?\s*", constraint):
        group = group.strip()
        if not group:
            continue
        # hyphen range "1.0 - 2.0"
        hy = re.match(r"^(\S+)\s+-\s+(\S+)$", group)
        if hy:
            lo, _ = pad(hy.group(1))
            hi, hgiven = pad(hy.group(2))
            if lo is None or hi is None:
                return True
            if lo <= v < bump(hi, hgiven - 1):
                return True
            continue
        terms = [t for t in re.split(r"\s*,\s*|\s+", group) if t]
        if all(_term_ok(v, t) for t in terms):
            return True
    return False


# ---------------------------------------------------------------------- io

def _cache_path(key):
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", key)
    return os.path.join(CACHE, safe)


def http_get(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": "composer-mirror/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def git_tags(repo):
    """List tags of https://github.com/<repo>; returns None if the repo is unreachable."""
    cp = _cache_path("tags__" + repo + ".json")
    if os.path.exists(cp):
        with open(cp) as f:
            return json.load(f)
    url = "https://github.com/%s.git" % repo
    try:
        out = subprocess.run(["git", "ls-remote", "--tags", "--refs", url],
                             capture_output=True, text=True, timeout=180)
    except subprocess.TimeoutExpired:
        return None
    if out.returncode != 0:
        return None
    tags = []
    for line in out.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) == 2 and parts[1].startswith("refs/tags/"):
            tags.append([parts[1][len("refs/tags/"):], parts[0]])
    with open(cp, "w") as f:
        json.dump(tags, f)
    return tags


def fetch_composer_json(repo, tag):
    cp = _cache_path("cj__%s__%s.json" % (repo, tag))
    if os.path.exists(cp):
        with open(cp) as f:
            return json.load(f)
    url = "https://raw.githubusercontent.com/%s/%s/composer.json" % (repo, tag)
    try:
        data = json.loads(http_get(url))
    except Exception:
        return None
    with open(cp, "w") as f:
        json.dump(data, f)
    return data


# ------------------------------------------------------------------ resolution

class Resolver:
    def __init__(self, include_dev=True):
        self.include_dev = include_dev
        self.repo_of = {}       # package -> "owner/repo"
        self.tags_of = {}       # package -> [[tag, sha], ...]
        self.chosen = {}        # package -> dict
        self.constraints = {}   # package -> {requirer: constraint}
        self.failed = {}
        self.replaced = set()

    def repo_for(self, name):
        if name in self.repo_of:
            return self.repo_of[name]
        for cand in candidate_repos(name):
            tags = git_tags(cand)
            if tags is not None:
                self.repo_of[name] = cand
                self.tags_of[name] = tags
                return cand
        self.repo_of[name] = None
        return None

    def best_tag(self, name):
        repo = self.repo_for(name)
        if repo is None:
            return None
        cons = list(self.constraints.get(name, {}).values())
        if name in PINS:
            cons.append(PINS[name])
        best = None
        for tag, sha in self.tags_of.get(name, []):
            v = parse_version(tag)
            if v is None or not is_stable(v):
                continue
            if not all(satisfies(v, c) for c in cons):
                continue
            if best is None or v > best[0]:
                best = (v, tag, sha)
        if best is None:
            # relax: allow the newest stable tag when nothing matched (better than nothing)
            for tag, sha in self.tags_of.get(name, []):
                v = parse_version(tag)
                if v is None or not is_stable(v):
                    continue
                if best is None or v > best[0]:
                    best = (v, tag, sha)
            if best is not None:
                self.failed[name] = "no tag satisfies %s; fell back to %s" % (cons, best[1])
        return best

    def add_constraint(self, name, requirer, constraint):
        self.constraints.setdefault(name, {})[requirer] = constraint

    def run(self, root_json):
        reqs = dict(root_json.get("require", {}))
        if self.include_dev:
            reqs.update(root_json.get("require-dev", {}))
        for n, c in reqs.items():
            if not is_virtual(n):
                self.add_constraint(n, "__root__", c)

        for round_no in range(1, 12):
            pending = [n for n in self.constraints
                       if n not in self.chosen or not self._still_ok(n)]
            pending = [n for n in pending if n not in self.replaced]
            if not pending:
                print("resolution converged after %d round(s)" % (round_no - 1))
                break
            print("round %d: resolving %d package(s)" % (round_no, len(pending)))
            with concurrent.futures.ThreadPoolExecutor(max_workers=12) as ex:
                list(ex.map(self.repo_for, pending))
            for name in pending:
                best = self.best_tag(name)
                if best is None:
                    self.failed.setdefault(name, "no github repo / no usable tag")
                    self.chosen.pop(name, None)
                    continue
                v, tag, sha = best
                cj = fetch_composer_json(self.repo_of[name], tag)
                if cj is None:
                    self.failed[name] = "composer.json missing at tag %s" % tag
                    continue
                self.chosen[name] = {
                    "name": name,
                    "repo": self.repo_of[name],
                    "tag": tag,
                    "sha": sha,
                    "version": tag if tag.startswith("v") else "v" + tag,
                    "version_normalized": ".".join(str(x) for x in v[:4]),
                    "composer": cj,
                }
                for rep in (cj.get("replace") or {}):
                    if rep != name:
                        self.replaced.add(rep)
                for dep, c in (cj.get("require") or {}).items():
                    if is_virtual(dep) or dep in self.replaced:
                        continue
                    self.add_constraint(dep, name, c)
        # drop anything provided by a chosen package
        for name in list(self.chosen):
            if name in self.replaced:
                del self.chosen[name]
        return self.chosen

    def _still_ok(self, name):
        entry = self.chosen.get(name)
        if not entry:
            return False
        v = parse_version(entry["tag"])
        return all(satisfies(v, c) for c in self.constraints.get(name, {}).values())


# ------------------------------------------------------------------- stages

def stage_resolve(include_dev):
    with open(os.path.join(ROOT, "composer.json")) as f:
        root = json.load(f)
    r = Resolver(include_dev=include_dev)
    chosen = r.run(root)
    with open(RESOLVED, "w") as f:
        json.dump({"packages": chosen, "failed": r.failed,
                   "replaced": sorted(r.replaced)}, f, indent=1, sort_keys=True)
    print("\nresolved %d packages -> %s" % (len(chosen), RESOLVED))
    if r.failed:
        print("problems:")
        for k, v in sorted(r.failed.items()):
            print("  %-45s %s" % (k, v))
    return chosen


def _export(entry):
    """`git archive` the checkout into tools/mirror/dist/<vendor>/<name>.

    git archive honours `export-ignore` in .gitattributes, which is exactly how
    packagist builds its dist zips -- so the exported tree matches what composer
    would normally download (no .git, no tests/, no CI config)."""
    name = entry["name"]
    clone = os.path.join(SRC, *name.split("/"))
    dest = os.path.join(DIST, *name.split("/"))
    stamp = _cache_path("export__" + name.replace("/", "__") + ".ref")
    if os.path.exists(stamp) and open(stamp).read().strip() == entry["sha"]:
        return
    subprocess.run(["rm", "-rf", dest])
    os.makedirs(dest, exist_ok=True)
    p1 = subprocess.Popen(["git", "-C", clone, "archive", "--format=tar", "HEAD"],
                          stdout=subprocess.PIPE)
    subprocess.run(["tar", "-x", "-C", dest], stdin=p1.stdout)
    p1.wait()
    # A `path` repository takes the version from the package's own composer.json,
    # and these exports have no .git to infer one from -- so stamp it in.
    cjp = os.path.join(dest, "composer.json")
    if os.path.exists(cjp):
        with open(cjp) as f:
            cj = json.load(f)
        cj["version"] = entry["version"]
        with open(cjp, "w") as f:
            json.dump(cj, f, indent=4)
    with open(stamp, "w") as f:
        f.write(entry["sha"])


def _clone_one(entry):
    name = entry["name"]
    dest = os.path.join(SRC, *name.split("/"))
    ok, msg = True, "cached"
    head = ""
    if os.path.isdir(os.path.join(dest, ".git")):
        head = subprocess.run(["git", "-C", dest, "rev-parse", "HEAD"],
                              capture_output=True, text=True).stdout.strip()
    if head != entry["sha"]:
        subprocess.run(["rm", "-rf", dest])
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        url = "https://github.com/%s.git" % entry["repo"]
        p = subprocess.run(["git", "clone", "--quiet", "--depth", "1", "--branch",
                            entry["tag"], url, dest],
                           capture_output=True, text=True, timeout=600)
        if p.returncode != 0:
            return (name, False, p.stderr.strip()[-200:])
        ok, msg = True, "cloned"
    _export(entry)
    return (name, ok, msg)


def stage_clone():
    with open(RESOLVED) as f:
        chosen = json.load(f)["packages"]
    entries = list(chosen.values())
    bad = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
        for i, (name, ok, msg) in enumerate(ex.map(_clone_one, entries), 1):
            if not ok:
                bad.append((name, msg))
            if i % 20 == 0:
                print("  cloned %d/%d" % (i, len(entries)))
    print("clone stage done (%d packages, %d failures)" % (len(entries), len(bad)))
    for n, m in bad:
        print("  FAIL %s: %s" % (n, m))


def stage_emit():
    with open(RESOLVED) as f:
        chosen = json.load(f)["packages"]
    packages = {}
    for name, e in chosen.items():
        cj = dict(e["composer"])
        cj.pop("$schema", None)
        clone = os.path.join(SRC, *name.split("/"))
        export = os.path.join(DIST, *name.split("/"))
        cj["name"] = name
        cj["version"] = e["version"]
        cj["version_normalized"] = e["version_normalized"]
        cj["dist"] = {"type": "path", "url": export, "reference": e["sha"]}
        cj["source"] = {"type": "git", "url": clone, "reference": e["sha"]}
        # copy instead of symlinking, so vendor/ survives independently of the mirror
        cj["transport-options"] = {"symlink": False}
        cj.pop("require-dev", None)   # transitive dev requirements are not mirrored
        packages[name] = {e["version"]: cj}
    with open(PACKAGES_JSON, "w") as f:
        json.dump({"packages": packages}, f, indent=1, sort_keys=True)
    print("wrote %s (%d packages)" % (PACKAGES_JSON, len(packages)))


def stage_materialize():
    """Replace the symlinks composer created in vendor/ with real directories.

    Composer's PathDownloader symlinks by default and its `symlink: false`
    transport option is only honoured for `path` repositories (ArrayLoader is
    constructed with loadOptions=false for `composer` repositories), so the
    dereferencing is done here instead. After this, vendor/ no longer depends on
    tools/mirror/ existing.
    """
    vendor = os.path.join(ROOT, "vendor")
    n = 0
    for dirpath, dirnames, _ in os.walk(vendor):
        for d in list(dirnames):
            full = os.path.join(dirpath, d)
            if not os.path.islink(full):
                continue
            target = os.path.realpath(full)
            if not os.path.isdir(target):
                continue
            tmp = full + ".materializing"
            subprocess.run(["rm", "-rf", tmp], check=False)
            subprocess.run(["cp", "-a", target + "/.", tmp], check=True)
            os.unlink(full)
            os.rename(tmp, full)
            n += 1
            dirnames.remove(d)
    print("materialized %d symlinked packages in vendor/" % n)


def main():
    args = sys.argv[1:] or ["all"]
    include_dev = "--no-dev" not in args
    stages = [a for a in args if not a.startswith("-")] or ["all"]
    for st in stages:
        if st in ("resolve", "all"):
            stage_resolve(include_dev)
        if st in ("clone", "all"):
            stage_clone()
        if st in ("emit", "all"):
            stage_emit()
        if st == "materialize":
            stage_materialize()


if __name__ == "__main__":
    main()
