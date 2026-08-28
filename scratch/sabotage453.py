"""Sabotage each guard, confirm a test fails, restore from a snapshot (never `git checkout --`)."""
import io
import os
import shutil
import subprocess
import tempfile

REQ = 'app/Http/Requests/Backoffice/CustomerRequest.php'
CTL = 'app/Http/Controllers/Backoffice/CustomerController.php'
MRG = 'app/Services/Identity/CustomerMerger.php'

FILES = {REQ, CTL, MRG}

SABOTAGES = [
    ('ownership check removed', REQ,
     "            if (! $model::query()->whereKey((int) $value)->exists()) {",
     "            if (false) {"),
    ('self-parent allowed', REQ,
     "        if ($customer instanceof Customer && $parent !== null && (int) $parent === (int) $customer->getKey()) {",
     "        if (false) {"),
    ('unreachable marketing consent allowed', REQ,
     "        if (blank($email) && blank($mobile)) {",
     "        if (false) {"),
    ('duplicate card allowed', REQ,
     "            if ($taken) {",
     "            if (false) {"),
    ('card check leaks across venues', REQ,
     "            $taken = Customer::query()\n                ->where('barcode', (string) $value)",
     "            $taken = Customer::query()->withoutGlobalScopes()\n                ->where('barcode', (string) $value)"),
    ('balance writable from the form', REQ,
     "            'active' => ['sometimes', 'boolean'],\n        ];",
     "            'active' => ['sometimes', 'boolean'],\n            'account_balance' => ['sometimes', 'numeric'],\n        ];"),
    ('customer with history hard-deleted', CTL,
     "        if ($orders > 0 || $moves > 0) {",
     "        if (false) {"),
    ('merge accepts another venue record', CTL,
     "        $loser = Customer::query()->whereKey((int) $data['loser_id'])->first();",
     "        $loser = Customer::query()->withoutGlobalScopes()->whereKey((int) $data['loser_id'])->first();"),
    ('merge into self allowed', CTL,
     "        if ((int) $loser->getKey() === (int) $customer->getKey()) {",
     "        if (false) {"),
    ('search ignores everything but the name', CTL,
     "                    $q->where('name', 'like', $like)\n                        ->orWhere('email', 'like', $like)",
     "                    $q->where('name', 'like', $like)\n                        ->orWhere('name', 'like', $like)"),
    ('total never reported', CTL,
     "            'total' => Customer::query()->count(),",
     "            'total' => count([]),"),
    ('duplicates match on a blank field', CTL,
     "                ->whereNotNull($field)\n                ->where($field, '!=', '')",
     "                ->whereRaw('1 = 1')"),
    ('edit ships no order history', CTL,
     "            'orders' => Order::query()\n                ->where('customer_id', $customer->getKey())",
     "            'orders' => Order::query()\n                ->whereRaw('0 = 1')\n                ->where('customer_id', $customer->getKey())"),
    ('merge leaves the orders behind', MRG,
     "                $this->connection->table($table)\n                    ->where('customer_id', $loser->getKey())\n                    ->update(['customer_id' => $survivor->getKey()]);",
     "                if ($table !== 'pos_orders') {\n                    $this->connection->table($table)\n                        ->where('customer_id', $loser->getKey())\n                        ->update(['customer_id' => $survivor->getKey()]);\n                }"),
    ('merge leaves the account moves behind', MRG,
     "        'customer_account_moves',\n        'loyalty_cards',",
     "        'loyalty_cards',"),
    ('balance never recomputed', MRG,
     "            $this->recount($survivor);",
     "            // recount skipped"),
    ('recount adds to the cache instead of restating it', MRG,
     "            'account_balance' => bcadd($balance, '0', 4),",
     "            'account_balance' => bcadd($balance, (string) $customer->account_balance, 4),"),
    ('archived record keeps its balance', MRG,
     "                'account_balance' => '0',",
     "                'account_balance' => (string) $loser->account_balance,"),
    ('loser left active', MRG,
     "                'active' => false,",
     "                'active' => true,"),
    ('child addresses left behind', MRG,
     "            $this->connection->table('customers')\n                ->where('parent_id', $loser->getKey())\n                ->update(['parent_id' => $survivor->getKey()]);",
     "            // child addresses left behind"),
    ('order count not restated', MRG,
     "            'order_count' => (clone $orders)->count(),",
     "            'order_count' => (int) $customer->order_count,"),
    ('last visit not restated', MRG,
     "            'last_order_at' => (clone $orders)->max('ordered_at'),",
     "            'last_order_at' => $customer->last_order_at,"),
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

    r = subprocess.run(['php', 'artisan', 'test', '--filter=CustomerCrud'], capture_output=True, text=True)
    restore()

    verdict = 'CAUGHT' if r.returncode != 0 else 'MISSED'
    results.append((name, verdict))
    print(f'{verdict:16} {name}', flush=True)

shutil.rmtree(snapshot)
print()
print('NOT CAUGHT:', [n for n, v in results if v != 'CAUGHT'] or 'none')
