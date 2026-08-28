import io

p = 'resources/js/backoffice/i18n/dictionary.ts'
s = io.open(p, encoding='utf-8', newline='').read()

FR = """    // ── service modes (presets)
    'preset.title': 'Modes de service',
    'preset.hint':
        'Sur place, à emporter, livraison — chaque mode porte son tarif, sa position fiscale et ses horaires.',
    'preset.add': 'Nouveau mode de service',
    'preset.addHint':
        'Le tarif et la position fiscale sont la raison d’être d’un mode : à emporter existe pour une TVA différente.',
    'preset.settings': 'Paramètres du mode',
    'preset.name': 'Nom',
    'preset.system': 'Fourni',
    'preset.systemHint':
        'Ce mode est fourni avec le produit : renommable et modifiable, mais pas supprimable — les caisses s’y replient.',
    'preset.none': 'Aucun',
    'preset.serviceAt': 'Service',
    'preset.serviceAt.counter': 'Au comptoir',
    'preset.serviceAt.table': 'À table',
    'preset.serviceAt.delivery': 'En livraison',
    'preset.identification': 'Identification du client',
    'preset.identificationHint': 'Ce que le client doit donner avant que la commande soit prise.',
    'preset.identification.none': 'Rien',
    'preset.identification.name': 'Son nom',
    'preset.identification.address': 'Son adresse',
    'preset.pricelist': 'Liste de prix',
    'preset.fiscalPosition': 'Position fiscale',
    'preset.fiscalPositionHint': 'Elle l’emporte sur celle de la caisse — c’est ainsi que « à emporter » change la TVA.',
    'preset.useGuest': 'Demander le nombre de couverts',
    'preset.inSelfOrder': 'Proposé en commande autonome',
    'preset.timing': 'Réservation',
    'preset.timingHint': 'Un mode qui prend des commandes pour plus tard, par créneaux.',
    'preset.useTiming': 'Prendre des réservations',
    'preset.slots': 'Commandes par créneau',
    'preset.interval': 'Durée d’un créneau (min)',
    'preset.booked': 'Sur créneau',
    'preset.asTheyCome': 'Au fil de l’eau',
    'preset.capacity': '{slots} par {minutes} min',
    'preset.hours': 'Horaires',
    'preset.openHours': 'Heures d’ouverture',
    'preset.addHours': 'Ajouter des horaires',
    'preset.addHoursHint': 'Une plage par jour. Deux plages qui se chevauchent proposent deux fois le même créneau.',
    'preset.noHoursYet':
        'Aucune plage horaire : ce mode accepte les réservations à toute heure. Ajoutez ses horaires ci-dessous.',
    'preset.day': 'Jour',
    'preset.period': 'Moment',
    'preset.from': 'De',
    'preset.until': 'À',
    'day.0': 'Lundi',
    'day.1': 'Mardi',
    'day.2': 'Mercredi',
    'day.3': 'Jeudi',
    'day.4': 'Vendredi',
    'day.5': 'Samedi',
    'day.6': 'Dimanche',
    'period.morning': 'Matin',
    'period.afternoon': 'Après-midi',
    'period.evening': 'Soir',

"""

EN = """    // ── service modes (presets)
    'preset.title': 'Service modes',
    'preset.hint':
        'Eat in, takeaway, delivery — each mode carries its own price list, fiscal position and hours.',
    'preset.add': 'New service mode',
    'preset.addHint':
        'The price list and fiscal position are why a mode exists: takeaway exists to charge a different VAT rate.',
    'preset.settings': 'Mode settings',
    'preset.name': 'Name',
    'preset.system': 'Built in',
    'preset.systemHint':
        'This mode ships with the product: rename and re-price it freely, but it cannot be removed — registers fall back to it.',
    'preset.none': 'None',
    'preset.serviceAt': 'Served',
    'preset.serviceAt.counter': 'At the counter',
    'preset.serviceAt.table': 'At the table',
    'preset.serviceAt.delivery': 'By delivery',
    'preset.identification': 'Customer identification',
    'preset.identificationHint': 'What the customer must give before the order can be taken.',
    'preset.identification.none': 'Nothing',
    'preset.identification.name': 'Their name',
    'preset.identification.address': 'Their address',
    'preset.pricelist': 'Price list',
    'preset.fiscalPosition': 'Fiscal position',
    'preset.fiscalPositionHint': 'It wins over the register’s own — this is how takeaway changes the VAT.',
    'preset.useGuest': 'Ask how many are dining',
    'preset.inSelfOrder': 'Offered in self-order',
    'preset.timing': 'Booking',
    'preset.timingHint': 'A mode that takes orders for later, in slots.',
    'preset.useTiming': 'Take bookings',
    'preset.slots': 'Orders per slot',
    'preset.interval': 'Slot length (min)',
    'preset.booked': 'Booked',
    'preset.asTheyCome': 'As they come',
    'preset.capacity': '{slots} per {minutes} min',
    'preset.hours': 'Hours',
    'preset.openHours': 'Opening hours',
    'preset.addHours': 'Add hours',
    'preset.addHoursHint': 'One window per day. Two overlapping windows offer the same slot twice.',
    'preset.noHoursYet':
        'No hours set: this mode takes bookings at any time of day. Add its opening hours below.',
    'preset.day': 'Day',
    'preset.period': 'Part of day',
    'preset.from': 'From',
    'preset.until': 'Until',
    'day.0': 'Monday',
    'day.1': 'Tuesday',
    'day.2': 'Wednesday',
    'day.3': 'Thursday',
    'day.4': 'Friday',
    'day.5': 'Saturday',
    'day.6': 'Sunday',
    'period.morning': 'Morning',
    'period.afternoon': 'Afternoon',
    'period.evening': 'Evening',

"""

for anchor, block in (("    'pricelist.title': 'Listes de prix',", FR),
                      ("    'pricelist.title': 'Pricelists',", EN)):
    assert anchor in s, 'MISSING: ' + anchor
    s = s.replace(anchor, block + anchor, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('strings added')
