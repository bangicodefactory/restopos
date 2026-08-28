"""Sabotage each guard, confirm a test fails, restore from a snapshot (never `git checkout --`)."""
import io
import os
import shutil
import subprocess
import tempfile

SVC = 'app/Services/Pos/SequenceService.php'
REQ = 'app/Http/Requests/Backoffice/PosConfigRequest.php'
CTL = 'app/Http/Controllers/Backoffice/PosConfigController.php'
DOM = 'packages/domain/src/barcode/nomenclature.ts'
PAT = 'packages/domain/src/barcode/pattern.ts'

PHP_FILES = {SVC, REQ, CTL}
TS_FILES = {DOM, PAT}

PHP_SABOTAGES = [
    ('the register prefix is ignored', SVC,
     "        if ($chosen !== '') {\n            return substr($chosen, 0, 8);\n        }",
     "        if (false) {\n            return substr($chosen, 0, 8);\n        }"),
    ('an emptied prefix is stored rather than cleared', REQ,
     "        if ($this->has('sequence_prefix') && trim((string) $this->input('sequence_prefix')) === '') {",
     "        if (false) {"),
    ('a prefix may carry a slash', REQ,
     "            'sequence_prefix' => ['sometimes', 'nullable', 'string', 'max:8', 'regex:/^[A-Za-z0-9]+$/'],",
     "            'sequence_prefix' => ['sometimes', 'nullable', 'string', 'max:8'],"),
    ('the issued numbers are not shipped', CTL,
     "                'sequences' => Sequence::query()\n                    ->where('pos_config_id', $config->getKey())",
     "                'sequences' => Sequence::query()\n                    ->whereRaw('0 = 1')\n                    ->where('pos_config_id', $config->getKey())"),
    ('the issued numbers leak from other registers', CTL,
     "                    ->where('pos_config_id', $config->getKey())\n                    ->orderBy('purpose')",
     "                    ->orderBy('purpose')"),
]

TS_SABOTAGES = [
    ('the encoding gate is dropped', DOM,
     "            if (!encodingMatches(candidate, rule)) continue;",
     "            if (false) continue;"),
    ('an alias reports the scanned code', DOM,
     "                const aliased = rule.alias ?? candidate;",
     "                const aliased = candidate;"),
    ('a weighed item is looked up by the scanned code', DOM,
     "            const code = embedded ? match.baseCode : candidate;",
     "            const code = candidate;"),
    ('an unmatched GTIN stops being a product', DOM,
     "    if (checksumOk(trimmed) && /^\\d{8,14}$/.test(trimmed)) {",
     "    if (false) {"),
    ('the embedded decimal point moves', PAT,
     "const FIELD_RE = /\\{(N*)(D*)\\}/;",
     "const FIELD_RE = /\\{(N*)(D*?)\\}/;"),
]

snapshot = tempfile.mkdtemp()
for f in PHP_FILES | TS_FILES:
    shutil.copy(f, os.path.join(snapshot, os.path.basename(f)))


def restore():
    for f in PHP_FILES | TS_FILES:
        shutil.copy(os.path.join(snapshot, os.path.basename(f)), f)


results = []


def run(name, path, old, new, cmd):
    s = io.open(path, encoding='utf-8', newline='').read()
    if old not in s:
        results.append((name, 'ANCHOR MISSING'))
        print(f'{"ANCHOR MISSING":16} {name}', flush=True)
        return

    io.open(path, 'w', encoding='utf-8', newline='').write(s.replace(old, new, 1))
    r = subprocess.run(cmd, capture_output=True, text=True, errors='replace',
                       shell=isinstance(cmd, str))
    restore()

    verdict = 'CAUGHT' if r.returncode != 0 else 'MISSED'
    results.append((name, verdict))
    print(f'{verdict:16} {name}', flush=True)


for name, path, old, new in TS_SABOTAGES:
    run(name, path, old, new,
        'npx vitest run packages/domain/test/barcode --reporter=dot')

shutil.rmtree(snapshot)
print()
print('NOT CAUGHT:', [n for n, v in results if v != 'CAUGHT'] or 'none')
