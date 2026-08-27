#!/bin/bash
cd "C:/Users/Chouchou/Desktop/Ahmed/Code Projects/Pos_Restaurant/restopos" || exit 1

FILES="app/Services/Device/DevicePairingService.php app/Http/Controllers/Api/Devices/DevicePairingController.php app/Services/Pos/BootstrapService.php app/Jobs/TouchDeviceSeen.php app/Http/Controllers/Backoffice/DeviceController.php"
SNAP=$(mktemp -d)
for f in $FILES; do mkdir -p "$SNAP/$(dirname "$f")"; cp "$f" "$SNAP/$f"; done
restore() { for f in $FILES; do cp "$SNAP/$f" "$f"; done; }
trap 'restore; rm -rf "$SNAP"' EXIT

T="tests/Feature/Backoffice/DeviceManagementTest.php tests/Feature/Backoffice/EscalationTest.php"

run() {
  if php artisan test $T 2>&1 | grep -qE "FAILED|failed"; then
    echo "CAUGHT       $1"
  else
    echo "*** MISSED   $1"
  fi
  restore
}

# 1. The original defect: the controller drops the metadata again.
sed -i "s|'hardware_fingerprint' => \$request->validated('hardware_fingerprint'),||; s|'app_version' => \$request->validated('app_version'),||" app/Http/Controllers/Api/Devices/DevicePairingController.php
run "pairing metadata dropped by the controller"

# 2. Re-pair recognition removed — every re-pair mints a ghost.
sed -i "s|\$existing = \$fingerprint === null|\$existing = true \|\| \$fingerprint === null|" app/Services/Device/DevicePairingService.php
run "re-pair creates a duplicate device"

# 3. An empty fingerprint treated as a value — the dangerous case.
sed -i "s|return \$fingerprint === '' ? null : \$fingerprint;|return \$fingerprint;|" app/Services/Device/DevicePairingService.php
run "blank fingerprint matches every unidentified machine"

# 4. Matching spans configs — one venue's pairing reaches another's list.
sed -i "s|->where('pos_config_id', \$config->getKey())\n                    ->where('hardware_fingerprint', \$fingerprint)|X|" app/Services/Device/DevicePairingService.php
sed -i "/->where('pos_config_id', \$config->getKey())$/{N;s|->where('pos_config_id', \$config->getKey())\n                    ->where('hardware_fingerprint', \$fingerprint)|->where('hardware_fingerprint', \$fingerprint)|}" app/Services/Device/DevicePairingService.php
run "fingerprint matching spans venues"

# 5. A re-pair loses the operator's name.
sed -i "s|'name' => \$attributes\['name'\] ?? \$existing->name,|'name' => \$attributes['name'] ?? null,|" app/Services/Device/DevicePairingService.php
run "re-pair wipes the name an operator gave"

# 6. The per-register minimum ignored.
sed -i "s|return \$perRegister !== ''|return false|" app/Services/Pos/BootstrapService.php
run "per-register minimum ignored"

# 7. A request reporting no version blanks the recorded one.
sed -i "s|\$touch = array_filter(\[|\$touch = ([|" app/Jobs/TouchDeviceSeen.php
run "recorded version blanked by a versionless request"

# 8. last_synced_at stamped on every request.
sed -i "s|if (\$this->synced) {|if (true) {|" app/Jobs/TouchDeviceSeen.php
run "last_synced_at stamped without a push"

# 9. The rename authorization removed.
sed -i "0,/        Gate::authorize('update', \$device);/{s|        Gate::authorize('update', \$device);||}" app/Http/Controllers/Backoffice/DeviceController.php
run "rename unguarded"
