import io

# ── strings ────────────────────────────────────────────────────────────────
p = 'resources/js/backoffice/i18n/dictionary.ts'
s = io.open(p, encoding='utf-8', newline='').read()

FR = """    'config.group.numbering': 'Numérotation',
    'config.numberingHint':
        'Le préfixe des numéros de commande et de session de ce point de vente, et les numéros déjà émis.',
    'config.sequencePrefix': 'Préfixe',
    'config.sequencePrefixHint':
        'Lettres et chiffres, 8 au maximum. Laissez vide pour le déduire du nom du point de vente : « {derived} ».',
    'config.sequencesIssued': 'Numéros déjà émis',
    'config.sequencesEmpty': 'Ce point de vente n’a encore émis aucun numéro.',
    'config.sequencePurpose': 'Document',
    'config.sequencePeriod': 'Période',
    'config.sequenceExample': 'Prochain numéro',
    'config.sequenceNext': 'Compteur',
"""

EN = """    'config.group.numbering': 'Numbering',
    'config.numberingHint':
        'What this register prefixes its order and session numbers with, and the numbers it has already issued.',
    'config.sequencePrefix': 'Prefix',
    'config.sequencePrefixHint':
        'Letters and digits, up to 8. Leave it empty to derive it from the register’s name: “{derived}”.',
    'config.sequencesIssued': 'Numbers already issued',
    'config.sequencesEmpty': 'This register has not issued any numbers yet.',
    'config.sequencePurpose': 'Document',
    'config.sequencePeriod': 'Period',
    'config.sequenceExample': 'Next number',
    'config.sequenceNext': 'Counter',
"""

fr_anchor = "    'config.group.accounting': "
en_anchor = "    'config.group.accounting': "

first = s.index(fr_anchor)
s = s[:first] + FR + s[first:]

second = s.index(en_anchor, first + len(FR) + len(fr_anchor) + 10)
s = s[:second] + EN + s[second:]

io.open(p, 'w', encoding='utf-8', newline='').write(s)

# ── the import ─────────────────────────────────────────────────────────────
p = 'resources/js/backoffice/pages/PosConfigs/Edit.tsx'
s = io.open(p, encoding='utf-8', newline='').read()

import re
m = re.search(r"import \{([^}]*)\} from '\.\./\.\./components/ui/primitives';", s)
assert m, 'primitives import'
names = [n.strip() for n in m.group(1).split(',') if n.strip()]
if 'SectionTitle' not in names:
    names.append('SectionTitle')
names = sorted(set(names))
s = s[:m.start()] + "import { " + ', '.join(names) + " } from '../../components/ui/primitives';" + s[m.end():]

io.open(p, 'w', encoding='utf-8', newline='').write(s)

# ── the writable key ───────────────────────────────────────────────────────
p = 'resources/js/backoffice/pages/PosConfigs/types.ts'
s = io.open(p, encoding='utf-8', newline='').read()
old = "export const WRITABLE_CONFIG_KEYS = ["
assert old in s, 'writable keys'
s = s.replace(old, old + "\n    'sequence_prefix',", 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)

print('strings, import and key added')
