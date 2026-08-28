import io

p = 'resources/js/backoffice/i18n/dictionary.ts'
s = io.open(p, encoding='utf-8', newline='').read()

FR = """    'employee.matrixHint':
        'Ce que chaque rôle peut faire en caisse. Un point de vente peut redéfinir ces droits pour lui seul dans ses réglages.',
    'employee.abilityLocked': 'droit réservé',
    'employee.abilityUnenforced': 'pas encore appliqué',
    'employee.abilityGroup.order': 'Prise de commande',
    'employee.abilityGroup.money': 'Remises et remboursements',
    'employee.abilityGroup.cash': 'Caisse et session',
    'employee.abilityGroup.receipt': 'Tickets',
    'employee.abilityGroup.room': 'Salle',
    'employee.abilityGroup.kitchen': 'Cuisine',
    'employee.abilityGroup.admin': 'Réglages et marges',
    'employee.roles': 'Rôles en caisse',
    'employee.rolesHint':
        'Les rôles que propose l’établissement. Les trois fournis sont modifiables mais pas supprimables.',
    'employee.addRole': 'Nouveau rôle',
    'employee.roleSlug': 'Identifiant',
    'employee.roleSlugHint': 'Minuscules, chiffres et tirets bas. Il ne change plus une fois créé.',
    'employee.roleName': 'Nom affiché',
    'employee.roleSystem': 'Fourni',
"""

EN = """    'employee.matrixHint':
        'What each role may do at the till. A register can redefine these for itself in its own settings.',
    'employee.abilityLocked': 'needs another permission',
    'employee.abilityUnenforced': 'not enforced yet',
    'employee.abilityGroup.order': 'Taking an order',
    'employee.abilityGroup.money': 'Discounts and refunds',
    'employee.abilityGroup.cash': 'Drawer and session',
    'employee.abilityGroup.receipt': 'Receipts',
    'employee.abilityGroup.room': 'The room',
    'employee.abilityGroup.kitchen': 'The pass',
    'employee.abilityGroup.admin': 'Settings and margins',
    'employee.roles': 'Till roles',
    'employee.rolesHint':
        'The roles this venue offers. The three that ship with the product can be changed but not removed.',
    'employee.addRole': 'New role',
    'employee.roleSlug': 'Identifier',
    'employee.roleSlugHint': 'Lower case, digits and underscores. It does not change once created.',
    'employee.roleName': 'Display name',
    'employee.roleSystem': 'Built in',
"""

fr_anchor = "    'employee.matrix': 'Matrice des permissions',"
en_anchor = "    'employee.matrix': 'Permission matrix',"

for anchor, block in ((fr_anchor, FR), (en_anchor, EN)):
    assert anchor in s, anchor
    s = s.replace(anchor, anchor + '\n' + block.rstrip('\n'), 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('strings added')
