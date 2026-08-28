import io

BS = chr(92)

# ── employee_roles, and default_role stops being an enum ────────────────────
p = 'database/migrations/2025_01_01_000101_create_identity_tables.php'
s = io.open(p, encoding='utf-8', newline='').read()

old = """        // Cashier identity at the register: badge + PIN, never plaintext on the wire.
        Schema::create('employees', function (Blueprint $table): void {"""
new = """        /*
         * Till roles and what each may do — axis 2 (BOF-118, BAN-451).
         *
         * Not `roles`, which is taken and is a different axis entirely: that one is back-office
         * *users* and their policy permissions. This one is till *employees* — whether a cashier may
         * void a paid order, discount past the limit, or close over a variance.
         *
         * These lived in `config/pos.php` and could only change with a deploy. `EmployeeRoleSeeder`
         * seeds the three the product ships with, from that same config, so nothing changes on
         * migration.
         *
         * `abilities` is a JSON list rather than a pivot, matching `pos_configs.role_abilities` —
         * the per-register override that already existed — so both sides of the resolution read the
         * same shape, and the bootstrap ships a resolved list either way.
         */
        Schema::create('employee_roles', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->string('slug', 32);
            $table->string('name', 64);
            $table->json('abilities');
            // The three the product ships with. Renameable and re-grantable like any other, but not
            // removable: `employees.default_role` defaults to `cashier` and `AccessLevel::toRole()`
            // maps onto all three, so a venue that deleted one would have employees pointing at a
            // role that no longer exists.
            $table->boolean('is_system')->default(false);
            $table->integer('sequence')->default(10);
            $table->boolean('active')->default(true)->index();
            $table->timestamps();

            $table->unique(['company_id', 'slug']);
        });

        // Cashier identity at the register: badge + PIN, never plaintext on the wire.
        Schema::create('employees', function (Blueprint $table): void {"""
assert old in s, 'employees anchor'
s = s.replace(old, new, 1)

old = """        $this->applyChecks('employees', ['default_role' => EmployeeRole::values()]);"""
new = """        // No CHECK on `default_role` any more: a role is a row in `employee_roles`, not one of three
        // enum cases, and the whole point of BAN-451 is that a venue can add "Shift lead". The
        // constraint that replaces it is referential — `EmployeeController` resolves the slug
        // through the scoped `EmployeeRole` model — and it is a constraint the database cannot
        // express here, because the roles table is per-company and this column is a slug rather
        // than an id (kept a slug so every existing reader, the bootstrap payload included, is
        // unchanged)."""
assert old in s, 'checks anchor'
s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)

# ── the pivot can name a custom role ────────────────────────────────────────
p = 'database/migrations/2025_01_01_000104_create_config_tables.php'
s = io.open(p, encoding='utf-8', newline='').read()

old = """            $table->string('access_level', 16)->default(AccessLevel::Basic->value);
            $table->timestamps();

            $table->unique(['pos_config_id', 'employee_id']);"""
new = """            $table->string('access_level', 16)->default(AccessLevel::Basic->value);
            /*
             * A custom role for this employee on this register (BAN-451).
             *
             * `access_level` has three values and maps onto the three system roles, so it cannot
             * name "Shift lead". It also always has a value once an employee is attached, which
             * means `roleFor()` never reached `employees.default_role` for an attached employee —
             * so without this column a custom role would have applied to exactly the employees no
             * register had been given.
             *
             * Null means "use `access_level`", which is every row that exists today.
             */
            $table->string('role_slug', 32)->nullable();
            $table->timestamps();

            $table->unique(['pos_config_id', 'employee_id']);"""
assert old in s, 'pivot anchor'
s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('migrations edited')
