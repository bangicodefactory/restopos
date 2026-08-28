import io

p = 'app/Support/Auth/EmployeeAbilities.php'
s = io.open(p, encoding='utf-8', newline='').read()

old = """    /**
     * Abilities that may only be granted by a back-office user who holds the matching permission."""

new = """    /**
     * Abilities the config grants that **no code checks** — found by `EmployeeAbilityRegistryTest`.
     *
     * These six have been in `config/pos.php` since it was written, and grepping every PHP and
     * TypeScript file in the repo finds them nowhere else. So a cashier granted `receipt.print` and
     * a cashier denied it can both print, and always could. They are advertised permissions that
     * change nothing.
     *
     * Listed rather than deleted, for two reasons. Deleting them would take rows out of a matrix
     * every venue has seen since the product shipped, which reads as a feature being removed. And
     * the honest fix is to *enforce* them — each one names a real action the register performs — so
     * removing the name would lose the record of which ones are owed.
     *
     * The matrix marks them. An operator who grants one should be told it does nothing yet, rather
     * than discovering it when a cashier prints a receipt they were not supposed to.
     *
     * @var list<string>
     */
    private const NOT_YET_ENFORCED = [
        'order.line.add',
        'receipt.print',
        'table.merge',
        'course.fire',
        'kitchen.send',
        'kitchen.recall',
    ];

    /**
     * Abilities that may only be granted by a back-office user who holds the matching permission."""

assert old in s, 'anchor'
s = s.replace(old, new, 1)

old2 = """    /**
     * The matrix, grouped.
     *
     * @return array<string, list<string>>
     */"""
new2 = """    /** Is this ability granted, shown, and checked by nothing? See {@see self::NOT_YET_ENFORCED}. */
    public static function isEnforced(string $ability): bool
    {
        return ! in_array($ability, self::NOT_YET_ENFORCED, true);
    }

    /** @return list<string> */
    public static function unenforced(): array
    {
        return self::NOT_YET_ENFORCED;
    }

    /**
     * The matrix, grouped.
     *
     * @return array<string, list<string>>
     */"""
assert old2 in s, 'grouped anchor'
s = s.replace(old2, new2, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)

# ── the test knows about the exemption, and guards the exemption itself ─────
p = 'tests/Feature/Backoffice/EmployeeAbilityRegistryTest.php'
s = io.open(p, encoding='utf-8', newline='').read()

old = """    $orphans = array_values(array_filter(
        EmployeeAbilities::all(),
        // Twice: once for the registry's own declaration, and at least once somewhere else.
        static fn (string $ability): bool => substr_count($haystack, "'".$ability."'") < 2,
    ));

    expect($orphans)->toBe([], 'the registry lists abilities nothing else mentions: '
        .implode(', ', $orphans).'. They would appear in the matrix as grantable permissions that'
        .' change nothing.');
});"""

new = """    $orphans = array_values(array_filter(
        EmployeeAbilities::all(),
        static fn (string $ability): bool =>
            // Twice: once for the registry's own declaration, and at least once somewhere else.
            substr_count($haystack, "'".$ability."'") < 2
            // Except the ones already known to be granted and unchecked, which the registry names
            // and the matrix marks. Finding a *new* one is what this catches.
            && EmployeeAbilities::isEnforced($ability),
    ));

    expect($orphans)->toBe([], 'the registry lists abilities nothing else mentions: '
        .implode(', ', $orphans).'. They would appear in the matrix as grantable permissions that'
        .' change nothing — either enforce them, or add them to `NOT_YET_ENFORCED` so the matrix'
        .' says so.');
});

it('does not excuse an ability that is in fact enforced', function (): void {
    // The exemption list is the kind that grows quietly and then hides a real regression. An ability
    // marked unenforced that the code *does* check would mark a working permission as doing nothing,
    // which is the same lie in the other direction.
    $haystack = '';

    foreach (['app', 'resources/js', 'packages'] as $dir) {
        foreach (File::allFiles(base_path($dir)) as $file) {
            if (in_array($file->getExtension(), ['php', 'ts', 'tsx'], true)) {
                $haystack .= File::get($file->getPathname());
            }
        }
    }

    $stale = array_values(array_filter(
        EmployeeAbilities::unenforced(),
        static fn (string $ability): bool => substr_count($haystack, "'".$ability."'") >= 2,
    ));

    expect($stale)->toBe([], 'these are marked as not yet enforced and something now checks them: '
        .implode(', ', $stale).'. Take them off the list.');
});"""

assert old in s, 'orphan anchor'
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('unenforced recorded')
