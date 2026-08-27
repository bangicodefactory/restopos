#!/bin/bash
cd "C:/Users/Chouchou/Desktop/Ahmed/Code Projects/Pos_Restaurant/restopos" || exit 1

FILES="app/Http/Requests/Backoffice/PosConfigRequest.php app/Http/Controllers/Backoffice/PaymentMethodController.php"
SNAP=$(mktemp -d)
for f in $FILES; do mkdir -p "$SNAP/$(dirname "$f")"; cp "$f" "$SNAP/$f"; done
restore() { for f in $FILES; do cp "$SNAP/$f" "$f"; done; }
trap 'restore; rm -rf "$SNAP"' EXIT

run() {
  if php artisan test tests/Feature/Backoffice/PosConfigUpdateTest.php tests/Feature/Backoffice/PaymentMethodCrudTest.php tests/Feature/Backoffice/ScopedExistsTest.php 2>&1 | grep -qE "FAILED|failed"; then
    echo "CAUGHT       $1"
  else
    echo "*** MISSED   $1"
  fi
  restore
}

# 1. The review defect itself, put back.
sed -i "s|\$this->owned(\$config, 'cashRounding')|Rule::exists('cash_roundings', 'id')|" app/Http/Requests/Backoffice/PosConfigRequest.php
run "cash_rounding_id back on an unscoped Rule::exists"

# 2. The super-admin half of owned() removed.
sed -i "s|->where('company_id', \$config->company_id)\n                ->whereKey|->whereKey|" app/Http/Requests/Backoffice/PosConfigRequest.php
sed -i "/->where('company_id', \$config->company_id)$/d" app/Http/Requests/Backoffice/PosConfigRequest.php
run "owned() relies on the global scope alone"

# 3. The media guard made permissive.
sed -i "s|if (! \$ours) {|if (false) {|" app/Http/Controllers/Backoffice/PaymentMethodController.php
run "media ownership check made permissive"

# 4. The media guard made absolute — the shared-asset branch dropped.
sed -i "s|\$ours = MediaFile::query()->whereKey((int) \$value)->exists()|\$ours = false \&\& MediaFile::query()->whereKey((int) \$value)->exists()|" app/Http/Controllers/Backoffice/PaymentMethodController.php
run "own-venue image wrongly refused"
