import io

# ── the client no longer derives groups ────────────────────────────────────
p = 'resources/js/backoffice/pages/Employees/types.ts'
s = io.open(p, encoding='utf-8', newline='').read()

start = s.index('export function abilityGroups(')
# Walk back to the start of its docblock.
doc = s.rindex('/**', 0, start)
end = s.index('\n}\n', start) + 3
s = s[:doc] + s[end:]

s = s.replace("import type { EnumOption } from '../../types/inertia';\n\n", '', 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)

# ── the page ───────────────────────────────────────────────────────────────
p = 'resources/js/backoffice/pages/Employees/Index.tsx'
s = io.open(p, encoding='utf-8', newline='').read()

s = s.replace("import { Button, cn, useToast } from '@shared/ui';",
              "import { Button, FOCUS_RING, cn, useToast } from '@shared/ui';", 1)

s = s.replace("    ROLE_ORDER,\n    abilityGroups,\n", "    ROLE_ORDER,\n", 1)

# `t()` takes a key from a closed union, so the group name has to resolve through a map.
s = s.replace("""                                                {t(`employee.abilityGroup.${group}` as never)}""",
              """                                                {t(GROUP_LABEL[group] ?? 'employee.ability')}""", 1)

s = s.replace("""// ───────────────────────────────────────────────────────────── matrix

function PermissionMatrix({""",
"""// ───────────────────────────────────────────────────────────── matrix

/**
 * The registry's groups, in the order it declares them.
 *
 * A `t()` key is a closed union, which is what stops a missing translation reaching a screen — so a
 * group name from the server resolves through this rather than being interpolated.
 */
const GROUP_LABEL: Record<string, 'employee.abilityGroup.order' | 'employee.abilityGroup.money' | 'employee.abilityGroup.cash' | 'employee.abilityGroup.receipt' | 'employee.abilityGroup.room' | 'employee.abilityGroup.kitchen' | 'employee.abilityGroup.admin'> = {
    order: 'employee.abilityGroup.order',
    money: 'employee.abilityGroup.money',
    cash: 'employee.abilityGroup.cash',
    receipt: 'employee.abilityGroup.receipt',
    room: 'employee.abilityGroup.room',
    kitchen: 'employee.abilityGroup.kitchen',
    admin: 'employee.abilityGroup.admin',
};

function PermissionMatrix({""", 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('matrix fixed')
