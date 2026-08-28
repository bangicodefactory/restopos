import io

BS = chr(92)

p = 'app/Models/Identity/Employee.php'
s = io.open(p, encoding='utf-8', newline='').read()
old = "            ->withPivot('access_level')"
if old in s:
    s = s.replace(old, "            ->withPivot('access_level', 'role_slug')", 1)
    io.open(p, 'w', encoding='utf-8', newline='').write(s)

p = 'app/Services/Pos/ApprovalAuthority.php'
s = io.open(p, encoding='utf-8', newline='').read()

old = """    /**
     * Every ability this system defines, across all roles.
     *
     * The union rather than any one role's list: an approval is a *manager* granting something to a
     * cashier, so the ability being claimed is by definition not one the pusher holds. What matters
     * is only that it is a real permission, and the per-employee check below decides the rest.
     *
     * @return list<string>
     */
    private function catalogue(PosConfig $config): array
    {
        // Both sources, not one or the other. `abilitiesFor()` falls back per *role*, so a config
        // that overrides only the cashier still grants managers the defaults — reading the override
        // alone would make every manager-only ability look invented.
        $sources = [(array) $this->config->get('pos.role_abilities', [])];

        if (is_array($config->getAttribute('role_abilities'))) {
            $sources[] = $config->getAttribute('role_abilities');
        }

        $all = [];

        foreach ($sources as $roles) {
            foreach ($roles as $abilities) {
                foreach ((array) $abilities as $ability) {
                    $all[] = (string) $ability;
                }
            }
        }

        return array_values(array_unique($all));
    }"""

new = """    /**
     * Every ability this system defines.
     *
     * The registry, not the union of what the roles happen to grant (BAN-451). While only a deploy
     * could change a role, taking the union was sound — the config *was* the definition. Once an
     * operator can author a role it stops being sound: a role granting `order.void_evrything` would
     * make that string a real ability by the union's own definition, and this method would then
     * accept an approval claiming it. The approval is recorded and the manager's PIN spent, on a
     * permission nothing checks.
     *
     * The union is also no longer *complete*. An ability granted to no role at this venue is still a
     * real ability, and an approval claiming it should be refused for want of an approver rather
     * than dismissed as unknown — two different messages to the cashier holding the queue up, and
     * only one of them is true.
     *
     * @return list<string>
     */
    private function catalogue(PosConfig $config): array
    {
        return EmployeeAbilities::all();
    }"""

assert old in s, 'catalogue anchor'
s = s.replace(old, new, 1)

imp = 'use App' + BS + 'Support' + BS + 'Auth' + BS + 'EmployeeAbilities;'
if imp not in s:
    i = s.index('use App' + BS)
    s = s[:i] + imp + chr(10) + s[i:]

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('catalogue wired')
