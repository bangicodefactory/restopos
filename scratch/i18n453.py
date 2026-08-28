import io

p = 'resources/js/backoffice/i18n/dictionary.ts'
s = io.open(p, encoding='utf-8', newline='').read()

FR = """    // ── customers
    'customer.title': 'Clients',
    'customer.hint': 'La fiche, l’historique et l’ardoise. Deux fiches d’un même habitué se fusionnent ici.',
    'customer.add': 'Nouveau client',
    'customer.addHint': 'Le nom suffit ; le reste se complète sur la fiche.',
    'customer.details': 'Fiche',
    'customer.name': 'Nom',
    'customer.company': 'Société',
    'customer.isCompany': 'C’est une société',
    'customer.none': 'Aucun',
    'customer.contact': 'Contact',
    'customer.email': 'E-mail',
    'customer.phone': 'Téléphone',
    'customer.mobile': 'Mobile',
    'customer.vat': 'N° de TVA',
    'customer.address': 'Adresse',
    'customer.street': 'Rue',
    'customer.street2': 'Complément',
    'customer.zip': 'Code postal',
    'customer.city': 'Ville',
    'customer.country': 'Pays',
    'customer.commercial': 'Conditions commerciales',
    'customer.commercialHint':
        'Appliquées automatiquement dès que ce client est rattaché à une commande en caisse.',
    'customer.pricelist': 'Liste de prix par défaut',
    'customer.fiscalPosition': 'Position fiscale',
    'customer.card': 'Carte de fidélité',
    'customer.marketing': 'Accepte les communications',
    'customer.marketingHint': 'Nécessite un e-mail ou un mobile — sans quoi rien ne peut lui être envoyé.',
    'customer.note': 'Note interne',
    'customer.search': 'Rechercher',
    'customer.searchHint': 'Nom, e-mail, téléphone, n° de TVA ou carte.',
    'customer.showingOf': '{shown} affichés sur {total}',
    'customer.truncated':
        'Seuls les {limit} premiers clients sont affichés. Affinez la recherche pour trouver les autres.',
    'customer.orders': 'Commandes',
    'customer.balance': 'Ardoise',
    'customer.lastVisit': 'Dernière visite',
    'customer.points': 'Points',
    'customer.history': 'Historique des commandes',
    'customer.orderedAt': 'Date',
    'customer.orderRef': 'N° de suivi',
    'customer.orderTotal': 'Total',
    'customer.account': 'Mouvements de compte',
    'customer.accountHint': 'Le registre fait foi : l’ardoise ci-dessus en est la somme, jamais l’inverse.',
    'customer.moveReason': 'Motif',
    'customer.moveAmount': 'Montant',
    'customer.balanceAfter': 'Solde après',
    'customer.duplicates': 'Doublons probables',
    'customer.duplicatesHint':
        'Fiches partageant un e-mail ou un numéro. Ouvrez celle à conserver pour y fusionner l’autre.',
    'customer.merge': 'Fusionner une autre fiche dans celle-ci',
    'customer.mergeHint':
        'La fiche affichée est celle qui reste : elle garde son nom, ses coordonnées et son tarif. L’autre est archivée.',
    'customer.mergeWhich': 'Fiche à absorber',
    'customer.mergeWarning':
        'Les commandes, factures, mouvements de compte et cartes de « {loser} » passeront sur « {survivor} », qui sera ensuite archivée. C’est irréversible.',
    'customer.mergeConfirm': 'Fusionner « {loser} » dans « {survivor} »',

"""

EN = """    // ── customers
    'customer.title': 'Customers',
    'customer.hint': 'The record, the history and the tab. Two records of one regular are merged here.',
    'customer.add': 'New customer',
    'customer.addHint': 'A name is enough; the rest is filled in on the record.',
    'customer.details': 'Record',
    'customer.name': 'Name',
    'customer.company': 'Company',
    'customer.isCompany': 'This is a company',
    'customer.none': 'None',
    'customer.contact': 'Contact',
    'customer.email': 'Email',
    'customer.phone': 'Phone',
    'customer.mobile': 'Mobile',
    'customer.vat': 'VAT number',
    'customer.address': 'Address',
    'customer.street': 'Street',
    'customer.street2': 'Street (line 2)',
    'customer.zip': 'Postcode',
    'customer.city': 'City',
    'customer.country': 'Country',
    'customer.commercial': 'Commercial terms',
    'customer.commercialHint': 'Applied automatically as soon as this customer is attached to an order at the till.',
    'customer.pricelist': 'Default price list',
    'customer.fiscalPosition': 'Fiscal position',
    'customer.card': 'Loyalty card',
    'customer.marketing': 'Accepts marketing',
    'customer.marketingHint': 'Needs an email or a mobile — without one, nothing could be sent to them.',
    'customer.note': 'Internal note',
    'customer.search': 'Search',
    'customer.searchHint': 'Name, email, phone, VAT number or card.',
    'customer.showingOf': 'Showing {shown} of {total}',
    'customer.truncated': 'Only the first {limit} customers are shown. Narrow the search to find the rest.',
    'customer.orders': 'Orders',
    'customer.balance': 'Tab',
    'customer.lastVisit': 'Last visit',
    'customer.points': 'Points',
    'customer.history': 'Order history',
    'customer.orderedAt': 'Date',
    'customer.orderRef': 'Tracking number',
    'customer.orderTotal': 'Total',
    'customer.account': 'Account moves',
    'customer.accountHint': 'The ledger is the record: the tab above is its sum, never the other way round.',
    'customer.moveReason': 'Reason',
    'customer.moveAmount': 'Amount',
    'customer.balanceAfter': 'Balance after',
    'customer.duplicates': 'Likely duplicates',
    'customer.duplicatesHint':
        'Records sharing an email or a number. Open the one you are keeping and merge the other into it.',
    'customer.merge': 'Merge another record into this one',
    'customer.mergeHint':
        'The record on screen is the one that survives: it keeps its name, contact details and price list. The other is archived.',
    'customer.mergeWhich': 'Record to absorb',
    'customer.mergeWarning':
        'The orders, invoices, account moves and cards of “{loser}” will move onto “{survivor}”, and “{loser}” will be archived. This cannot be undone.',
    'customer.mergeConfirm': 'Merge “{loser}” into “{survivor}”',

"""

for anchor, block in (("    // ── service modes (presets)", FR + "    // ── service modes (presets)"),):
    assert anchor in s
    s = s.replace(anchor, block, 1)

# The English block goes before the *second* occurrence, which is the English dictionary.
i = s.index("    // ── service modes (presets)", s.index("    // ── service modes (presets)") + 10)
s = s[:i] + EN + s[i:]

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('strings added')
