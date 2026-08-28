"""Sabotage each guard, confirm a test fails, restore from a snapshot (never `git checkout --`)."""
import io, os, shutil, subprocess, tempfile

MODEL = 'app/Models/Pos/PosPrinter.php'
BIND  = 'resources/js/register/domain/printing.ts'
ROUTE = 'resources/js/shared/printing/router.ts'
EPOS  = 'resources/js/shared/printing/epos-network.ts'
FILES = [MODEL, BIND, ROUTE, EPOS]

PHP = 'php artisan test tests/Feature/BootstrapContractTest.php'
TS  = 'npx vitest run resources/js/register/domain/printing.test.ts resources/js/shared/printing/epos-network.test.ts --reporter=dot'

SABOTAGES = [
    ('the address is never derived', MODEL,
     "        $row['address'] = $this->address;",
     "        $row['address'] = null;", PHP),
    ('a network printer forgets its port', MODEL,
     "                : ($this->printer_port === null ? $this->printer_ip : $this->printer_ip.':'.$this->printer_port),",
     "                : $this->printer_ip,", PHP),
    ('the receipt printer is never named as one', MODEL,
     "            $row['print_receipt'] = (bool) $row['is_receipt_printer'];",
     "            $row['print_receipt'] = false;", PHP),
    ('the raw columns ship alongside the derived ones', MODEL,
     "        unset($row['proxy_ip'], $row['printer_ip'], $row['printer_port']);",
     "        // sabotaged: leak the addressing columns", PHP),
    ('the categories relation is not eager-loaded', MODEL,
     "            ->with('categories:id')",
     "            ->with([])", PHP),
    ('the category pivot is not materialised', MODEL,
     "        return $this->relationLoaded('categories')\n            ? $this->categories->pluck('id')->map(intval(...))->all()\n            : [];",
     "        return [];", PHP),

    ('a missing category list is passed through undefined', BIND,
     "        categoryIds: printer.pos_category_ids ?? [],",
     "        categoryIds: printer.pos_category_ids,", TS),
    ('print-all is dropped on the way into the binding', BIND,
     "        allCategories: printer.print_all_categories === true,",
     "        allCategories: false,", TS),
    ('the binding forgets the ePOS device id', BIND,
     "        eposDeviceId: printer.epos_device_id,",
     "        eposDeviceId: null,", TS),

    ('the router ignores print-all when matching', ROUTE,
     "                (b) => b.allCategories === true || b.categoryIds.some((id) => categories.includes(id)),",
     "                (b) => b.categoryIds.some((id) => categories.includes(id)),", TS),
    ('a print-all printer is demoted to the fallback', ROUTE,
     "            const catchAll = prep.filter((b) => b.allCategories !== true && b.categoryIds.length === 0);",
     "            const catchAll = prep.filter((b) => b.categoryIds.length === 0);", TS),

    ('the devid falls back to local_printer for every port', EPOS,
     "    const deviceId = options.deviceId ?? 'local_printer';",
     "    const deviceId = 'local_printer';", TS),
    ('the transport ignores the binding devid', EPOS,
     "            deviceId: binding.eposDeviceId ?? this.options.deviceId,",
     "            deviceId: this.options.deviceId,", TS),
    ('the devid is spliced in unescaped', EPOS,
     "?devid=${encodeURIComponent(deviceId)}&timeout=",
     "?devid=${deviceId}&timeout=", TS),
]

snapshot = tempfile.mkdtemp()
for f in FILES:
    shutil.copy(f, os.path.join(snapshot, os.path.basename(f)))

def restore():
    for f in FILES:
        shutil.copy(os.path.join(snapshot, os.path.basename(f)), f)

results = []
try:
    for name, path, old, new, cmd in SABOTAGES:
        s = io.open(path, encoding='utf-8', newline='').read()
        if old not in s:
            results.append((name, 'ANCHOR MISSING'))
            print('%-16s %s' % ('ANCHOR MISSING', name), flush=True)
            continue
        io.open(path, 'w', encoding='utf-8', newline='').write(s.replace(old, new, 1))
        r = subprocess.run(cmd, capture_output=True, text=True, errors='replace', shell=True)
        restore()
        verdict = 'CAUGHT' if r.returncode != 0 else 'MISSED'
        results.append((name, verdict))
        print('%-16s %s' % (verdict, name), flush=True)
finally:
    restore()
    shutil.rmtree(snapshot, ignore_errors=True)

print()
print('NOT CAUGHT:', [n for n, v in results if v != 'CAUGHT'] or 'none')
