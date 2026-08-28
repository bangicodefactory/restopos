import io

p = 'resources/js/backoffice/i18n/dictionary.ts'
s = io.open(p, encoding='utf-8', newline='').read()

FR = """    // ── catalogue import
    'import.title': 'Importer un catalogue',
    'import.hint':
        'Deux étapes, et la première n’écrit rien : téléversez, lisez ligne par ligne ce qui se passerait, puis validez.',
    'import.file': 'Le fichier',
    'import.fileHint': 'Un CSV avec une ligne d’en-tête, {max} lignes au maximum.',
    'import.what': 'Que contient-il ?',
    'import.required': 'Colonnes obligatoires :',
    'import.matchedOn': 'Une ligne est rapprochée d’une fiche existante par :',
    'import.columns': 'Colonnes reconnues :',
    'import.template': 'Télécharger un modèle vide',
    'import.preview': 'Prévisualiser',
    'import.commit': 'Importer',
    'import.wouldDo': 'Ce que ferait ce fichier',
    'import.done': 'Import terminé',
    'import.summary': '{creates} création(s), {updates} mise(s) à jour, {errors} erreur(s).',
    'import.nothingWritten':
        'Rien n’a été écrit. Un catalogue à moitié importé est pire qu’aucun : corrigez le fichier et téléversez-le à nouveau.',
    'import.written': 'Le fichier a été importé.',
    'import.line': 'Ligne',
    'import.outcome': 'Résultat',
    'import.row': 'Fiche',
    'import.why': 'Motif',
    'import.rowCreate': 'Création',
    'import.rowUpdate': 'Mise à jour',
    'import.rowError': 'Erreur',

"""

EN = """    // ── catalogue import
    'import.title': 'Import a catalogue',
    'import.hint':
        'Two steps, and the first writes nothing: upload, read line by line what would happen, then commit.',
    'import.file': 'The file',
    'import.fileHint': 'A CSV with a header row, {max} rows at most.',
    'import.what': 'What is in it?',
    'import.required': 'Required columns:',
    'import.matchedOn': 'A row is matched to an existing record by:',
    'import.columns': 'Recognised columns:',
    'import.template': 'Download an empty template',
    'import.preview': 'Preview',
    'import.commit': 'Import',
    'import.wouldDo': 'What this file would do',
    'import.done': 'Import finished',
    'import.summary': '{creates} to create, {updates} to update, {errors} error(s).',
    'import.nothingWritten':
        'Nothing was written. A half-imported catalogue is worse than none: fix the file and upload it again.',
    'import.written': 'The file was imported.',
    'import.line': 'Line',
    'import.outcome': 'Outcome',
    'import.row': 'Record',
    'import.why': 'Reason',
    'import.rowCreate': 'Create',
    'import.rowUpdate': 'Update',
    'import.rowError': 'Error',

"""

first = s.index("    // ── set menus (combos)")
s = s[:first] + FR + s[first:]

second = s.index("    // ── set menus (combos)", first + len(FR) + 10)
s = s[:second] + EN + s[second:]

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('strings added')
