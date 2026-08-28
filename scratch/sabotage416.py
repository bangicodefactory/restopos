"""Sabotage each guard, confirm a test fails, restore from a snapshot (never `git checkout --`)."""
import io
import os
import shutil
import subprocess
import tempfile

REQ = 'app/Http/Requests/Backoffice/ComboRequest.php'
ITM = 'app/Http/Requests/Backoffice/ComboItemRequest.php'
CTL = 'app/Http/Controllers/Backoffice/ComboController.php'

FILES = {REQ, ITM, CTL}

SABOTAGES = [
    ('allowance may exceed the limit', REQ,
     "        if ($free > $max) {",
     "        if (false) {"),
    ('a course may accept no choice', REQ,
     "            'qty_max' => ['sometimes', 'integer', 'min:1', 'max:65535'],",
     "            'qty_max' => ['sometimes', 'integer', 'min:0', 'max:65535'],"),
    ('dish ownership check removed', ITM,
     "            if (! ProductVariant::query()->whereKey((int) $value)->exists()) {",
     "            if (false) {"),
    ('same dish twice allowed', ITM,
     "        if ($taken) {",
     "        if (false) {"),
    ('negative supplement refused', ITM,
     "            'extra_price' => ['sometimes', 'numeric'],",
     "            'extra_price' => ['sometimes', 'numeric', 'min:0'],"),
    ('combo_count never bumped', CTL,
     "            $this->recountCombos($product);\n        });\n\n        return back()->with('success', 'Course added to the menu.');",
     "        });\n\n        return back()->with('success', 'Course added to the menu.');"),
    ('combo_count never lowered', CTL,
     "            $this->recountCombos($product);\n        });\n\n        return back()->with('success', 'Course removed from the menu.');",
     "        });\n\n        return back()->with('success', 'Course removed from the menu.');"),
    ('combo_count incremented instead of counted', CTL,
     "            'combo_count' => DB::table('combo_product')\n                ->where('product_id', $product->getKey())\n                ->count(),",
     "            'combo_count' => (int) $product->combo_count + 1,"),
    ('menu ownership check removed', CTL,
     "        $product = Product::query()->whereKey((int) $data['product_id'])->first();",
     "        $product = Product::query()->withoutGlobalScopes()->whereKey((int) $data['product_id'])->first();"),
    ('same course attached twice', CTL,
     "        if ($combo->products()->whereKey($product->getKey())->exists()) {",
     "        if (false) {"),
    ('delete ignores the menus offering it', CTL,
     "        if ($menus > 0) {",
     "        if (false) {"),
    ('delete ignores what was sold', CTL,
     "        if ($sold > 0) {",
     "        if (false) {"),
    ('foreign dish reachable', CTL,
     "        abort_unless((int) $item->combo_id === (int) $combo->getKey(), 404);",
     "        abort_unless(true, 404);"),
    ('editor ships no dishes to pick from', CTL,
     "            'variants' => ProductVariant::query()\n                ->with('product:id,list_price')",
     "            'variants' => ProductVariant::query()->whereRaw('0 = 1')\n                ->with('product:id,list_price')"),
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

    r = subprocess.run(['php', 'artisan', 'test', '--filter=ComboCrud'], capture_output=True, text=True)
    restore()

    verdict = 'CAUGHT' if r.returncode != 0 else 'MISSED'
    results.append((name, verdict))
    print(f'{verdict:16} {name}', flush=True)

shutil.rmtree(snapshot)
print()
print('NOT CAUGHT:', [n for n, v in results if v != 'CAUGHT'] or 'none')
