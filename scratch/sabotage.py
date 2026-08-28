"""Sabotage each guard, confirm a test fails, restore from a snapshot (never `git checkout --`)."""
import io, os, shutil, subprocess, sys, tempfile

REQ = 'app/Http/Requests/Backoffice/PricelistItemRequest.php'
CTL = 'app/Http/Controllers/Backoffice/PricelistController.php'

SABOTAGES = [
    ('scope target dropped', REQ,
     "        if ($this->input($field) === null) {",
     "        if (false) {"),
    ('zero fixed price allowed', REQ,
     "if ($compute === PricelistComputePrice::Fixed->value && (float) $this->input('fixed_price', 0) <= 0) {",
     "if (false) {"),
    ('zero per cent allowed', REQ,
     "if ($compute === PricelistComputePrice::Percentage->value && (float) $this->input('percent_price', 0) <= 0) {",
     "if (false) {"),
    ('formula base unnamed', REQ,
     "            && $this->input('base_pricelist_id') === null) {",
     "            && false) {"),
    ('window order unchecked', REQ,
     "        if ($start !== null && $end !== null && strtotime((string) $end) < strtotime((string) $start)) {",
     "        if (false) {"),
    ('self-reference allowed', REQ,
     "        if ($pricelist instanceof Pricelist && $base !== null && (int) $base === (int) $pricelist->getKey()) {",
     "        if (false) {"),
    ('ownership check removed', REQ,
     "            if (! $model::query()->whereKey((int) $value)->exists()) {",
     "            if (false) {"),
    ('foreign rule reachable', CTL,
     "        abort_unless((int) $item->pricelist_id === (int) $pricelist->getKey(), 404);",
     "        abort_unless(true, 404);"),
    ('delete ignores orders', CTL,
     "        if ($orders > 0) {",
     "        if (false) {"),
    ('delete ignores registers defaulting to it', CTL,
     "        if ($registers > 0) {",
     "        if (false) {"),
    ('delete ignores derived lists', CTL,
     "        if ($derived > 0) {",
     "        if (false) {"),
    ('currency clash allowed', CTL,
     "        if ($clashing > 0) {",
     "        if (false) {"),
    ('index ships no currencies', CTL,
     "            'currencies' => Currency::query()->orderBy('code')->get(['id', 'name', 'code'])->all(),",
     "            'currencies' => [],"),
    ('edit ships no products', CTL,
     "            'products' => Product::query()
                ->where('available_in_pos', true)",
     "            'products' => Product::query()
                ->whereRaw('0 = 1')"),
]

snapshot = tempfile.mkdtemp()
for f in {REQ, CTL}:
    shutil.copy(f, os.path.join(snapshot, os.path.basename(f)))


def restore():
    for f in {REQ, CTL}:
        shutil.copy(os.path.join(snapshot, os.path.basename(f)), f)


results = []
for name, path, old, new in SABOTAGES:
    s = io.open(path, encoding='utf-8', newline='').read()
    if old not in s:
        results.append((name, 'ANCHOR MISSING'))
        continue
    io.open(path, 'w', encoding='utf-8', newline='').write(s.replace(old, new, 1))

    r = subprocess.run(['php', 'artisan', 'test', '--filter=PricelistCrud'],
                       capture_output=True, text=True)
    restore()
    results.append((name, 'CAUGHT' if r.returncode != 0 else 'MISSED'))
    print(f'{results[-1][1]:16} {name}', flush=True)

shutil.rmtree(snapshot)
print()
print('MISSED:', [n for n, v in results if v != 'CAUGHT'] or 'none')
