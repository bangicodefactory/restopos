import io

p = 'resources/js/backoffice/i18n/dictionary.ts'
s = io.open(p, encoding='utf-8', newline='').read()

FR = """    // ── set menus (combos)
    'combo.title': 'Formules',
    'combo.hint':
        'Une ligne est un service — « Entrées », « Plats ». La formule elle-même est un produit, et les services s’y rattachent.',
    'combo.add': 'Nouveau service',
    'combo.addHint': 'Le nom vu en caisse, et le poids qu’il pèse dans la répartition du prix.',
    'combo.settings': 'Le service',
    'combo.settingsHint': 'Combien de choix il offre, combien il en accepte, et sa part du prix de la formule.',
    'combo.name': 'Nom',
    'combo.weight': 'Poids dans la formule',
    'combo.weightHint':
        'Ce n’est pas ce que paie le client : c’est la part du prix de la formule que ce service porte sur le ticket.',
    'combo.included': 'Choix inclus',
    'combo.includedHint': 'Au-delà, chaque choix supplémentaire est facturé au poids ci-dessus.',
    'combo.maximum': 'Choix maximum',
    'combo.choices': 'Choix',
    'combo.choicesOf': '{free} inclus / {max} max',
    'combo.dishes': 'Plats proposés',
    'combo.dish': 'Plat',
    'combo.addDish': 'Ajouter un plat',
    'combo.addDishHint': 'Ce que le client peut choisir dans ce service.',
    'combo.ownPrice': 'Prix seul',
    'combo.supplement': 'Supplément',
    'combo.supplementHint': 'Ajouté au prix de la formule. Un montant négatif est une remise pour ce choix.',
    'combo.menus': 'Formules',
    'combo.menusHint':
        'Rattacher ce service à une formule est ce qui fait demander le choix en caisse. Sans cela, la formule se vend comme un produit ordinaire.',
    'combo.noMenus': 'Ce service n’est proposé dans aucune formule.',
    'combo.orphan': 'Aucune formule',
    'combo.orphanHint':
        'Ce service n’appartient à aucune formule : il n’est proposé à personne. Rattachez-le ci-dessous.',
    'combo.addToMenu': 'Rattacher à une formule',
    'combo.pickMenu': 'Choisir une formule',

"""

EN = """    // ── set menus (combos)
    'combo.title': 'Set menus',
    'combo.hint':
        'A row is one course — “Starters”, “Mains”. The menu itself is a product, and the courses attach to it.',
    'combo.add': 'New course',
    'combo.addHint': 'The name staff see at the till, and the weight it carries in the price split.',
    'combo.settings': 'The course',
    'combo.settingsHint': 'How many choices it includes, how many it accepts, and its share of the menu price.',
    'combo.name': 'Name',
    'combo.weight': 'Weight in the menu',
    'combo.weightHint':
        'Not what the customer pays: it is the share of the menu price this course carries on the receipt.',
    'combo.included': 'Choices included',
    'combo.includedHint': 'Beyond this, each further choice is charged at the weight above.',
    'combo.maximum': 'Maximum choices',
    'combo.choices': 'Choices',
    'combo.choicesOf': '{free} included / {max} max',
    'combo.dishes': 'Dishes offered',
    'combo.dish': 'Dish',
    'combo.addDish': 'Add a dish',
    'combo.addDishHint': 'What the customer may choose from this course.',
    'combo.ownPrice': 'Price alone',
    'combo.supplement': 'Supplement',
    'combo.supplementHint': 'Added on top of the menu price. A negative amount is a discount for choosing this.',
    'combo.menus': 'Menus',
    'combo.menusHint':
        'Attaching this course to a menu is what makes the till ask for the choice. Without it the menu sells as an ordinary product.',
    'combo.noMenus': 'This course is not offered on any menu.',
    'combo.orphan': 'No menu',
    'combo.orphanHint':
        'This course belongs to no menu, so it is offered to nobody. Attach it below.',
    'combo.addToMenu': 'Add to a menu',
    'combo.pickMenu': 'Choose a menu',

"""

first = s.index("    // ── customers")
s = s[:first] + FR + s[first:]

second = s.index("    // ── customers", first + len(FR) + 10)
s = s[:second] + EN + s[second:]

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('strings added')
