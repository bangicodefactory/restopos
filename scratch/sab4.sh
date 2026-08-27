#!/bin/bash
cd "C:/Users/Chouchou/Desktop/Ahmed/Code Projects/Pos_Restaurant/restopos" || exit 1

FILES="app/Rules/StaffPin.php app/Http/Controllers/Backoffice/EmployeeController.php app/Http/Controllers/Backoffice/PosConfigController.php app/Services/Audit/AuditRecorder.php app/Http/Requests/Backoffice/PosConfigRequest.php"
SNAP=$(mktemp -d)
for f in $FILES; do mkdir -p "$SNAP/$(dirname "$f")"; cp "$f" "$SNAP/$f"; done
restore() { for f in $FILES; do cp "$SNAP/$f" "$f"; done; }
trap 'restore; rm -rf "$SNAP"' EXIT

T="tests/Feature/Backoffice/EmployeeCrudTest.php"

run() {
  if php artisan test $T 2>&1 | grep -qE "FAILED|failed"; then
    echo "CAUGHT       $1"
  else
    echo "*** MISSED   $1"
  fi
  restore
}

# 1. The repeated-digit guard removed.
sed -i "s|if (count(array_unique(str_split(\$pin))) === 1) {|if (false) {|" app/Rules/StaffPin.php
run "repeated-digit PIN accepted"

# 2. The run guard removed.
sed -i "s|if (\$this->isRun(\$pin)) {|if (false) {|" app/Rules/StaffPin.php
run "sequential PIN accepted"

# 3. Uniqueness dropped.
sed -i "s|if (\$this->isTaken(\$pin)) {|if (false) {|" app/Rules/StaffPin.php
run "duplicate PIN accepted"

# 4. Uniqueness made absolute — ignores the record being edited.
sed -i "s|if (\$this->ignoreEmployeeId !== null) {|if (false) {|" app/Rules/StaffPin.php
run "employee cannot keep its own PIN"

# 5. Uniqueness leaks across companies.
sed -i "s|->where('company_id', \$this->companyId)||" app/Rules/StaffPin.php
run "PIN uniqueness spans tenants"

# 6. The delete guard removed.
sed -i "s|if (\$orders > 0) {|if (false) {|" app/Http/Controllers/Backoffice/EmployeeController.php
run "employee with orders can be deleted"

# 7. access_level never written.
sed -i "s|? array_combine(\$owned, array_map(|? \$owned ?: array_combine(\$owned, array_map(|" app/Http/Controllers/Backoffice/PosConfigController.php
run "access_level dropped from the pivot sync"

# 8. Levels applied to submitted ids rather than owned ones.
sed -i "s|\$levels\[\$id\] ?? \[\]|\$levels[\$id] ?? []|" app/Http/Controllers/Backoffice/PosConfigController.php
sed -i "s|'employee_access_levels.\*' => \[Rule::enum(AccessLevel::class)\],|'employee_access_levels.*' => ['string'],|" app/Http/Requests/Backoffice/PosConfigRequest.php
run "any string accepted as an access level"

# 9. The array branch removed from the audit diff — the fatal returns.
sed -i "s|if (is_array(\$old) \|\| is_array(\$new)) {|if (false) {|" app/Services/Audit/AuditRecorder.php
run "audit diff fatals on an array column"

# 10. null and {} collapsed — revoking everything silently restores the defaults.
sed -i "s|'role_abilities' => \['sometimes', 'nullable', 'array'\],|'role_abilities' => ['sometimes', 'nullable', 'array', 'filled'],|" app/Http/Requests/Backoffice/PosConfigRequest.php
run "empty override treated as absent"
