#!/bin/bash
cd "C:/Users/Chouchou/Desktop/Ahmed/Code Projects/Pos_Restaurant/restopos" || exit 1

FILES="app/Http/Controllers/Backoffice/EmployeeController.php app/Http/Controllers/Backoffice/DeviceController.php app/Http/Controllers/Backoffice/PricelistController.php app/Http/Controllers/Backoffice/SelfOrderSettingsController.php app/Services/Device/DevicePairingService.php app/Policies/EmployeePolicy.php"
SNAP=$(mktemp -d)
for f in $FILES; do mkdir -p "$SNAP/$(dirname "$f")"; cp "$f" "$SNAP/$f"; done
restore() { for f in $FILES; do cp "$SNAP/$f" "$f"; done; }
trap 'restore; rm -rf "$SNAP"' EXIT

T="tests/Feature/Backoffice/EscalationTest.php tests/Feature/Backoffice/AuthorizationCoverageTest.php"

run() {
  if php artisan test $T 2>&1 | grep -qE "FAILED|failed"; then
    echo "CAUGHT       $1"
  else
    echo "*** MISSED   $1"
  fi
  restore
}

# 1. The original defect, put back.
sed -i "s|        Gate::authorize('update', \$employee);||" app/Http/Controllers/Backoffice/EmployeeController.php
run "employee update unguarded again"

# 2. Guarded, but with the wrong (read-level) ability — the subtler version.
sed -i "s|'backoffice.manage_employees'|'backoffice.access'|g" app/Policies/EmployeePolicy.php
run "employee guard downgraded to read-level ability"

# 3. Device revoke unguarded.
sed -i "s|        Gate::authorize('delete', \$device);||" app/Http/Controllers/Backoffice/DeviceController.php
run "device revoke unguarded"

# 4. Device list unscoped again.
sed -i "s|->whereIn('pos_config_id', PosConfig::query()->select('id'))||" app/Http/Controllers/Backoffice/DeviceController.php
run "device list leaks other tenants"

# 5. Pricelist update unguarded.
sed -i "s|        Gate::authorize('update', \$pricelist);||" app/Http/Controllers/Backoffice/PricelistController.php
run "pricelist update unguarded"

# 6. Self-order token rotation unguarded.
sed -i "s|        Gate::authorize('update', \$config);||" app/Http/Controllers/Backoffice/SelfOrderSettingsController.php
run "self-order rotate unguarded"

# 7. The pairing type override, restored.
sed -i "s|\$kind = DeviceType::from(\$payload\['device_type'\]);|\$kind = DeviceType::tryFrom((string) (\$attributes['device_type'] ?? \$payload['device_type'])) ?? DeviceType::from(\$payload['device_type']);|" app/Services/Device/DevicePairingService.php
sed -i "/This pairing code was issued for a /,+3d" app/Services/Device/DevicePairingService.php
run "pairing type override restored"

# 8. Pairing made absolute — refuses even the matching type.
sed -i "s|if (isset(\$attributes\['device_type'\]) \&\& (string) \$attributes\['device_type'\] !== \$kind->value) {|if (isset(\$attributes['device_type'])) {|" app/Services/Device/DevicePairingService.php
run "pairing refuses its own device type"
