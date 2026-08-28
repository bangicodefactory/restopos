#!/bin/bash
cd "C:/Users/Chouchou/Desktop/Ahmed/Code Projects/Pos_Restaurant/restopos" || exit 1

F="app/Http/Controllers/Backoffice/SelfOrderSettingsController.php"
SNAP=$(mktemp -d)
mkdir -p "$SNAP/$(dirname "$F")"; cp "$F" "$SNAP/$F"
restore() { cp "$SNAP/$F" "$F"; }
trap 'restore; rm -rf "$SNAP"' EXIT

T="tests/Feature/Backoffice/SelfOrderSettingsTest.php"

run() {
  if php artisan test $T 2>&1 | grep -qE "FAILED|failed"; then
    echo "CAUGHT       $1"
  else
    echo "*** MISSED   $1"
  fi
  restore
}

py() { python -c "$1"; }

# 1. The language rule leaves again — the original defect.
py "
import io
p='$F'; s=io.open(p,encoding='utf-8',newline='').read()
i=s.index(\"'self_ordering_default_language_id' => ['sometimes'\"); j=s.index('],', i)+2
s=s[:i]+s[j:]
io.open(p,'w',encoding='utf-8',newline='').write(s)
"
run "default language dropped from the rule set"

# 2. The payment-method ownership check removed.
py "
import io
p='$F'; s=io.open(p,encoding='utf-8',newline='').read()
s=s.replace(\"\$this->ownedPaymentMethod(\$config)\",\"'nullable'\",1)
io.open(p,'w',encoding='utf-8',newline='').write(s)
"
run "kiosk points at another venue payment method"

# 3. The custom-link ownership check removed.
py "
import io
p='$F'; s=io.open(p,encoding='utf-8',newline='').read()
s=s.replace('if (count(\$owned) !== count(\$wanted)) {','if (false) {',1)
s=s.replace('\$config->selfOrderLinks()->sync(\$owned);','\$config->selfOrderLinks()->sync(\$wanted);',1)
io.open(p,'w',encoding='utf-8',newline='').write(s)
"
run "another venue link attached to this kiosk"

# 4. The link check filters instead of refusing.
py "
import io
p='$F'; s=io.open(p,encoding='utf-8',newline='').read()
s=s.replace('if (count(\$owned) !== count(\$wanted)) {','if (false) {',1)
io.open(p,'w',encoding='utf-8',newline='').write(s)
"
run "foreign link silently dropped rather than refused"

# 5. The tables stop being scoped to this register's floors.
py "
import io
p='$F'; s=io.open(p,encoding='utf-8',newline='').read()
s=s.replace(\"->whereIn('restaurant_floor_id', \$config->floors()->select('restaurant_floors.id'))\",'',1)
io.open(p,'w',encoding='utf-8',newline='').write(s)
"
run "tables from floors this register does not serve"

# 6. The brand media ownership check removed.
py "
import io
p='$F'; s=io.open(p,encoding='utf-8',newline='').read()
s=s.replace('\$this->ownedMedia()',\"'nullable'\",1)
io.open(p,'w',encoding='utf-8',newline='').write(s)
"
run "brand image ownership unchecked"

# 7. The revision stops being bumped — the kiosk keeps the old settings.
py "
import io
p='$F'; s=io.open(p,encoding='utf-8',newline='').read()
i=s.index('\$config->forceFill(\$data)->save();')
s=s[:i]+s[i:].replace('\$config->bumpRevision();','',1)
io.open(p,'w',encoding='utf-8',newline='').write(s)
"
run "revision not bumped after a settings save"
