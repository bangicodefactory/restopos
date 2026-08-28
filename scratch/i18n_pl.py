import io

p = 'resources/js/backoffice/i18n/dictionary.ts'
s = io.open(p, encoding='utf-8', newline='').read()

FR_OLD = """    'pricelist.itemsReadOnly':
        'Le contrat n\u2019expose pas d\u2019\u00e9criture sur les r\u00e8gles : cet \u00e9diteur est en lecture seule.',
"""
FR_NEW = """    'pricelist.addRule': 'Ajouter une r\u00e8gle',
    'pricelist.addRuleHint':
        'Deux questions ind\u00e9pendantes : ce que la r\u00e8gle couvre, et comment le prix est calcul\u00e9.',
    'pricelist.appliesTo': 'S\u2019applique \u00e0',
    'pricelist.scopeGlobal': 'Tous les produits',
    'pricelist.scopeCategory': 'Une cat\u00e9gorie',
    'pricelist.scopeProduct': 'Un produit',
    'pricelist.product': 'Produit',
    'pricelist.category': 'Cat\u00e9gorie',
    'pricelist.howPriced': 'Calcul du prix',
    'pricelist.computePercentage': 'Remise en pourcentage',
    'pricelist.computeFixed': 'Prix fixe',
    'pricelist.percent': 'Remise (%)',
    'pricelist.fixedPrice': 'Prix fix\u00e9',
"""

EN_OLD = "    'pricelist.itemsReadOnly': 'The contract exposes no rule writes: this editor is read-only.',\n"
EN_NEW = """    'pricelist.addRule': 'Add a rule',
    'pricelist.addRuleHint': 'Two independent questions: what the rule covers, and how the price is worked out.',
    'pricelist.appliesTo': 'Applies to',
    'pricelist.scopeGlobal': 'Every product',
    'pricelist.scopeCategory': 'A category',
    'pricelist.scopeProduct': 'A product',
    'pricelist.product': 'Product',
    'pricelist.category': 'Category',
    'pricelist.howPriced': 'How the price is worked out',
    'pricelist.computePercentage': 'Percentage off',
    'pricelist.computeFixed': 'Fixed price',
    'pricelist.percent': 'Discount (%)',
    'pricelist.fixedPrice': 'Price charged',
"""

for old, new in ((FR_OLD, FR_NEW), (EN_OLD, EN_NEW)):
    assert old in s, 'MISSING: ' + old[:60]
    s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('strings replaced')
