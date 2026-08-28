"""Sabotage each guard, confirm a test fails, restore from a snapshot (never `git checkout --`)."""
import io
import os
import shutil
import subprocess
import tempfile

REQ = 'app/Http/Requests/Backoffice/TillRoleRequest.php'
CTL = 'app/Http/Controllers/Backoffice/TillRoleController.php'
SVC = 'app/Services/Identity/EmployeeAuthService.php'
REG = 'app/Support/Auth/EmployeeAbilities.php'
EMP = 'app/Models/Identity/Employee.php'
ECT = 'app/Http/Controllers/Backoffice/EmployeeController.php'

FILES = {REQ, CTL, SVC, REG, EMP, ECT}

SABOTAGES = [
    ('an invented ability is grantable', REQ,
     "            if (! EmployeeAbilities::exists((string) $value)) {",
     "            if (false) {"),
    ('escalation guard removed', REQ,
     "            if ($needs !== null && $user?->hasPermission($needs) !== true) {",
     "            if (false) {"),
    ('escalation guard ignores what is already held', REQ,
     "            if (in_array($ability, $held, true)) {\n                continue;\n            }",
     "            if (false) {\n                continue;\n            }"),
    ('a system role may be re-slugged', REQ,
     "        if ($this->has('slug') && (string) $this->input('slug') !== (string) $role->slug) {",
     "        if (false) {"),
    ('slug uniqueness dropped', REQ,
     "            if ($taken) {",
     "            if (false) {"),
    ('slug check leaks across venues', REQ,
     "            $taken = TillRole::query()\n                ->where('slug', (string) $value)",
     "            $taken = TillRole::query()->withoutGlobalScopes()\n                ->where('slug', (string) $value)"),
    ('is_system settable through the form', CTL,
     "            'is_system' => false,",
     "            'is_system' => (bool) request()->boolean('is_system'),"),
    ('a system role is deletable', CTL,
     "        if ($role->is_system) {",
     "        if (false) {"),
    ('a role staff hold is deletable', CTL,
     "        if ($held > 0) {",
     "        if (false) {"),
    ('a role a register assigns is deletable', CTL,
     "        if ($assigned > 0) {",
     "        if (false) {"),
    ('stored abilities are not filtered on write', CTL,
     "            $data['abilities'] = EmployeeAbilities::only((array) $data['abilities']);",
     "            $data['abilities'] = (array) $data['abilities'];"),
    ('the venue role is ignored for the config default', SVC,
     "        if ($stored !== null) {\n            return $stored->grantedAbilities();\n        }",
     "        if (false) {\n            return $stored->grantedAbilities();\n        }"),
    ('an empty role falls back to the defaults', SVC,
     "        if ($stored !== null) {",
     "        if ($stored !== null && $stored->grantedAbilities() !== []) {"),
    ('the register override no longer wins', SVC,
     "        if (isset($override[$slug])) {",
     "        if (false) {"),
    ('abilities are not filtered on the way out', SVC,
     "            return $stored->grantedAbilities();",
     "            return array_values(array_map(strval(...), (array) $stored->abilities));"),
    ('the role slug is flattened onto the enum', SVC,
     "        $slug = $this->roleSlugFor($employee, $config);",
     "        $slug = $this->roleFor($employee, $config)->value;"),
    ('the per-register role assignment is ignored', EMP,
     "        if (is_string($custom) && $custom !== '') {\n            return $custom;\n        }",
     "        if (false) {\n            return $custom;\n        }"),
    ('a custom default role is flattened when no register lists the employee', EMP,
     "        if ($pivot === null && is_string($this->default_role) && $this->default_role !== '') {",
     "        if (false) {"),
    ('the employee form accepts any role name', ECT,
     "                if (! TillRole::query()->where('slug', (string) $value)->where('active', true)->exists()) {",
     "                if (false) {"),
    ('the employee form accepts another venue role', ECT,
     "                if (! TillRole::query()->where('slug', (string) $value)->where('active', true)->exists()) {",
     "                if (! TillRole::query()->withoutGlobalScopes()->where('slug', (string) $value)->where('active', true)->exists()) {"),
    ('the matrix is sent the enum cases again', ECT,
     "            'roles' => TillRole::query()",
     "            'roles' => TillRole::query()->whereRaw('0 = 1')"),
    ('every ability is offered as grantable', ECT,
     "                fn (string $ability): bool => ($needs = EmployeeAbilities::grantRequires($ability)) === null\n                    || $request->user()?->hasPermission($needs) === true,",
     "                fn (string $ability): bool => true,"),
    ('the registry filter passes anything through', REG,
     "        return array_values(array_filter(\n            self::all(),\n            static fn (string $ability): bool => isset($wanted[$ability]),\n        ));",
     "        return array_values(array_map(strval(...), array_keys($wanted)));"),
]

snapshot = tempfile.mkdtemp()
for f in FILES:
    shutil.copy(f, os.path.join(snapshot, os.path.basename(f)))


def restore():
    for f in FILES:
        shutil.copy(os.path.join(snapshot, os.path.basename(f)), f)


results = []
for name, path, old, new in SABOTAGES:
    s = io.open(path, encoding='utf-8', newline='').read()
    if old not in s:
        results.append((name, 'ANCHOR MISSING'))
        print(f'{"ANCHOR MISSING":16} {name}', flush=True)
        continue

    io.open(path, 'w', encoding='utf-8', newline='').write(s.replace(old, new, 1))

    r = subprocess.run(
        ['php', 'artisan', 'test', '--filter=RoleAbility|EmployeeAbilityRegistry'],
        capture_output=True, text=True,
    )
    restore()

    verdict = 'CAUGHT' if r.returncode != 0 else 'MISSED'
    results.append((name, verdict))
    print(f'{verdict:16} {name}', flush=True)

shutil.rmtree(snapshot)
print()
print('NOT CAUGHT:', [n for n, v in results if v != 'CAUGHT'] or 'none')
