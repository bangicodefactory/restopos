"""Sabotage each guard, confirm a test fails, restore from a snapshot (never `git checkout --`)."""
import io
import os
import shutil
import subprocess
import tempfile

SVC = 'app/Services/Import/CatalogImportService.php'
IMP = 'app/Support/Import/Importers.php'
CTL = 'app/Http/Controllers/Backoffice/CatalogImportController.php'

FILES = {SVC, IMP, CTL}

SABOTAGES = [
    ('a bad file commits the good rows', SVC,
     "        if (! $plan->isClean()) {\n            return $plan;\n        }",
     "        if (false) {\n            return $plan;\n        }"),
    ('blank keys match each other', SVC,
     "            if (blank($value)) {\n                continue;\n            }\n\n            // Through the scoped model",
     "            if (false) {\n                continue;\n            }\n\n            // Through the scoped model"),
    ('matching runs unscoped', SVC,
     "            $found = $model::query()->where($key, $value)->first();",
     "            $found = $model::query()->withoutGlobalScopes()->where($key, $value)->first();"),
    ('duplicate keys within a file allowed', SVC,
     "            if (isset($seen[$token])) {",
     "            if (false) {"),
    ('required columns unchecked', SVC,
     "            if ($missing !== []) {",
     "            if (false) {"),
    ('rows never validated', SVC,
     "            if ($validator->fails()) {",
     "            if (false) {"),
    ('cross-field rules skipped', SVC,
     "            Importers::applyCrossFieldRules($entity, $values, $validator);",
     "            // cross-field rules skipped"),
    ('empty cell stored as an empty string', SVC,
     "            if ($raw === '') {\n                $values[$column] = null;",
     "            if ($raw === '') {\n                $values[$column] = '';"),
    ('spreadsheet booleans read literally', SVC,
     "            $values[$column] = $this->isBooleanColumn($column)\n                ? in_array(mb_strtolower($raw), ['1', 'true', 'yes', 'y', 'oui', 'o', 'x', 'vrai'], true)\n                : $raw;",
     "            $values[$column] = $raw;"),
    ('line numbers count from zero', SVC,
     "            $line = $index + 2;",
     "            $line = $index;"),
    ('products import without their variant', IMP,
     "        /** @var Product $record */\n        $record->variants()->create([",
     "        if (true) {\n            return;\n        }\n\n        /** @var Product $record */\n        $record->variants()->create(["),
    ('every product in the file shares one uuid', SVC,
     "                    ...Importers::defaultsFor($entity, $companyId),",
     "                    ...['uuid' => 'fixed-uuid-for-every-row'],"),
    ('products validate by their own rules', IMP,
     "            'products' => ProductRules::forValidator($creating),",
     "            'products' => ['name' => ['required', 'string']],"),
    ('the BOM is left on the first column', CTL,
     "        $header = array_map(\n            static fn (?string $column): string => trim(str_replace(\"\\u{FEFF}\", '', (string) $column)),\n            $header,\n        );",
     "        $header = array_map(static fn (?string $column): string => (string) $column, $header);"),
    ('a file with no rows is accepted', CTL,
     "        if ($rows === []) {",
     "        if (false) {"),
    ('a template is offered for anything', CTL,
     "        abort_if($spec === null, 404);",
     "        abort_if(false, 404);"),
]

snapshot = tempfile.mkdtemp()
for f in FILES:
    shutil.copy(f, os.path.join(snapshot, os.path.basename(f)))


def restore():
    for f in FILES:
        shutil.copy(os.path.join(snapshot, os.path.basename(f)), f)


results = []
for name, path, old, new in SABOTAGES:
    s = io.open(path, encoding='utf-8', newline='').read()
    if old not in s:
        results.append((name, 'ANCHOR MISSING'))
        print(f'{"ANCHOR MISSING":16} {name}', flush=True)
        continue

    io.open(path, 'w', encoding='utf-8', newline='').write(s.replace(old, new, 1))

    r = subprocess.run(['php', 'artisan', 'test', '--filter=CatalogImport'], capture_output=True, text=True)
    restore()

    verdict = 'CAUGHT' if r.returncode != 0 else 'MISSED'
    results.append((name, verdict))
    print(f'{verdict:16} {name}', flush=True)

shutil.rmtree(snapshot)
print()
print('NOT CAUGHT:', [n for n, v in results if v != 'CAUGHT'] or 'none')
