import io

BS = chr(92)

# ── the column ──────────────────────────────────────────────────────────────
p = 'database/migrations/2025_01_01_000104_create_config_tables.php'
s = io.open(p, encoding='utf-8', newline='').read()

anchor = "            $table->string('access_level', 16)->default(AccessLevel::Basic->value);"
assert anchor in s, 'pivot anchor for locating pos_configs'

# Put it next to the register's own identity fields.
old = "            $table->string('name', 96)->index();"
assert s.count(old) >= 1, 'name column'
i = s.index("Schema::create('pos_configs'")
j = s.index(old, i)
new = """            $table->string('name', 96)->index();
            /*
             * What order and session numbers are prefixed with (BOF-045, BAN-488).
             *
             * `SequenceService::prefixFor()` derived this from the register's *name* — strip the
             * non-alphanumerics, take eight characters — so "Bar à vins" numbered orders `Bavins/00412`
             * and renaming the register silently renumbered everything after it. A venue whose
             * accountant expects one prefix per till had no way to say so.
             *
             * Null keeps the derived behaviour, which is what every existing register does.
             */
            $table->string('sequence_prefix', 8)->nullable();"""
s = s[:j] + new + s[j + len(old):]

io.open(p, 'w', encoding='utf-8', newline='').write(s)

# ── the service reads it ────────────────────────────────────────────────────
p = 'app/Services/Pos/SequenceService.php'
s = io.open(p, encoding='utf-8', newline='').read()

old = """    private function prefixFor(PosConfig $config): string
    {
        $name = preg_replace('/[^A-Za-z0-9]/', '', (string) $config->name) ?? '';

        return $name === '' ? 'POS' : substr($name, 0, 8);
    }"""
new = """    /**
     * The prefix order and session numbers carry.
     *
     * The register's own setting when it has one, and otherwise derived from its name as it always
     * was (BOF-045, BAN-488). Deriving it from the name meant renaming a register renumbered every
     * document after the rename, which is exactly what a sequence must not do — and a venue whose
     * accountant expects `T1/` on till one could not say so.
     *
     * Existing rows are null and keep the derived value, so nothing changes on migration.
     */
    private function prefixFor(PosConfig $config): string
    {
        $chosen = preg_replace('/[^A-Za-z0-9]/', '', (string) $config->sequence_prefix) ?? '';

        if ($chosen !== '') {
            return substr($chosen, 0, 8);
        }

        $name = preg_replace('/[^A-Za-z0-9]/', '', (string) $config->name) ?? '';

        return $name === '' ? 'POS' : substr($name, 0, 8);
    }"""
assert old in s, 'prefixFor'
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)

print('sequence prefix wired')
