import io

p = 'docs/spec/01-schema.md'
s = io.open(p, encoding='utf-8', newline='').read()

# ── the new table, documented just before `employees` ───────────────────────
old = "### `employees`\nCashier identity at the register"
assert old in s, 'employees head'
new = """### `till_roles`
What a till employee may do — permission **axis 2**. Not `roles`, which is back-office *users* and
their policy permissions; the two are never mixed.

These lived in `config/pos.php` until BAN-451 and could only change with a deploy. `TillRoleSeeder`
seeds the three the product ships with from that same config, so a venue's abilities do not change
on migration.

| column | type | notes |
|---|---|---|
| id | PK | |
| company_id | FK→companies.id, cascade | U with slug |
| slug | varchar(32) | what `employees.default_role` and `pos_config_employee.role_slug` store, and what the bootstrap payload carries |
| name | varchar(64) | what staff see |
| abilities | json | list of ability strings, filtered through `EmployeeAbilities` on read and on write |
| is_system | bool default false | the three the product ships with: renameable and re-grantable, never removable, slug frozen |
| sequence | int default 10 | matrix column order |
| active | bool default true, idx | |

The abilities themselves are **not** data: `App\\Support\\Auth\\EmployeeAbilities` is the fixed set,
because it is code that checks them. An operator picks from it and cannot invent one — a role
granting an unknown string would otherwise make that string a real ability as far as
`ApprovalAuthority` is concerned.

### `employees`
Cashier identity at the register"""
s = s.replace(old, new, 1)

# ── the column is no longer an enum ─────────────────────────────────────────
old = "| default_role | enum('minimal','cashier','manager') default 'cashier' | fallback when no per-config override |"
assert old in s, 'default_role row'
new = "| default_role | varchar(16) default 'cashier' | `till_roles.slug`; fallback when no per-config override. Not an enum since BAN-451 — a venue can author its own roles — and not a FK either, because `till_roles` is per-company and this is a slug rather than an id. `TillRoleController` refuses to remove a role staff still hold. |"
s = s.replace(old, new, 1)

# ── the pivot carries a role ────────────────────────────────────────────────
old = "pos_configs >─< employees (pos_config_employee: access_level minimal|basic|advanced)"
assert old in s, 'pivot line'
new = "pos_configs >─< employees (pos_config_employee: access_level minimal|basic|advanced, role_slug→till_roles.slug)"
s = s.replace(old, new, 1)

old = "`employees.default_role` / effective register role: `minimal` | `cashier` | `manager`."
assert old in s, 'effective role line'
new = ("`employees.default_role` / effective register role: any `till_roles.slug` of the venue — the three\n"
       "seeded ones (`minimal` | `cashier` | `manager`) plus whatever it has authored (BAN-451).\n"
       "Resolution order: `pos_config_employee.role_slug`, then `access_level`, then `default_role`.")
s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('schema doc updated')
