import io

# ── the label key follows the per-namespace convention ──────────────────────
p = 'resources/js/backoffice/pages/Pricelists/Index.tsx'
s = io.open(p, encoding='utf-8', newline='').read()
assert "t('field.name')" in s
s = s.replace("t('field.name')", "t('pricelist.name')", 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)

# ── the strings ─────────────────────────────────────────────────────────────
p = 'resources/js/backoffice/i18n/dictionary.ts'
s = io.open(p, encoding='utf-8', newline='').read()
FR = """    'pricelist.add': 'Nouvelle liste de prix',
    'pricelist.addHint': 'Un nom et la devise dans laquelle elle chiffre. Ses r\u00e8gles s\u2019ajoutent ensuite.',
    'pricelist.name': 'Nom',
    'pricelist.currency': 'Devise',
    'pricelist.addRule': 'Ajouter une r\u00e8gle',"""
EN = """    'pricelist.add': 'New price list',
    'pricelist.addHint': 'A name and the currency it prices in. Its rules are added next.',
    'pricelist.name': 'Name',
    'pricelist.currency': 'Currency',
    'pricelist.addRule': 'Add a rule',"""
for old, new in (("    'pricelist.addRule': 'Ajouter une r\u00e8gle',", FR),
                 ("    'pricelist.addRule': 'Add a rule',", EN)):
    assert old in s, 'MISSING: ' + old
    s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)

# ── the controller sends what the form needs ────────────────────────────────
p = 'app/Http/Controllers/Backoffice/PricelistController.php'
s = io.open(p, encoding='utf-8', newline='').read()
old = """                    'item_count' => (int) $p->items_count,
                ])->values()->all(),
        ]);"""
assert old in s
s = s.replace(old, """                    'item_count' => (int) $p->items_count,
                ])->values()->all(),
            // A price list could be edited but never created, so nothing here had to offer a
            // currency to price in (BAN-401). Currencies are global ISO reference data.
            'currencies' => Currency::query()->orderBy('code')->get(['id', 'name', 'code'])->all(),
        ]);""", 1)
imp = 'use App' + chr(92) + 'Models' + chr(92) + 'Pricing' + chr(92) + 'Currency;'
if imp not in s:
    i = s.index('use App' + chr(92) + 'Models' + chr(92) + 'Pricing' + chr(92) + 'Pricelist;')
    s = s[:i] + imp + chr(10) + s[i:]
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok')
