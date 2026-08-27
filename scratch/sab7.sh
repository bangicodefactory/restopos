#!/bin/bash
cd "C:/Users/Chouchou/Desktop/Ahmed/Code Projects/Pos_Restaurant/restopos" || exit 1

FILES="app/Services/Media/MediaUploadService.php app/Http/Controllers/Backoffice/MediaController.php app/Policies/MediaPolicy.php app/Http/Controllers/Backoffice/ProductController.php"
SNAP=$(mktemp -d)
for f in $FILES; do mkdir -p "$SNAP/$(dirname "$f")"; cp "$f" "$SNAP/$f"; done
restore() { for f in $FILES; do cp "$SNAP/$f" "$f"; done; }
trap 'restore; rm -rf "$SNAP"' EXIT

T="tests/Feature/Backoffice/MediaUploadTest.php"

run() {
  if php artisan test $T 2>&1 | grep -qE "FAILED|failed"; then
    echo "CAUGHT       $1"
  else
    echo "*** MISSED   $1"
  fi
  restore
}

# 1. SVG allowed again — stored XSS.
sed -i "s|        'image/gif',\n    \];|X|" app/Services/Media/MediaUploadService.php
python - <<'PY'
import io
p='app/Services/Media/MediaUploadService.php'
s=io.open(p,encoding='utf-8',newline='').read()
s=s.replace("        'image/gif',\n    ];","        'image/gif',\n        'image/svg+xml',\n    ];",1)
io.open(p,'w',encoding='utf-8',newline='').write(s)
PY
run "SVG accepted again"

# 2. The mime rule trusts the extension.
sed -i "s|'mimetypes:'.implode(',', MediaUploadService::ALLOWED_MIME)|'mimes:png,jpg,jpeg,webp,gif'|" app/Http/Controllers/Backoffice/MediaController.php
run "mime taken from the extension"

# 3. The stored path uses the uploaded filename.
sed -i "s|\$path = \$collection->value.'/'.\$companyId.'/'.\$checksum.\$extension;|\$path = \$collection->value.'/'.\$companyId.'/'.\$file->getClientOriginalName();|" app/Services/Media/MediaUploadService.php
run "stored path built from the uploaded filename"

# 4. Deduplication removed.
sed -i "s|        if (\$existing !== null) {|        if (false) {|" app/Services/Media/MediaUploadService.php
run "same file stored twice"

# 5. Deduplication spans venues.
sed -i "s|            ->where('company_id', \$companyId)\n||" app/Services/Media/MediaUploadService.php
python - <<'PY'
import io
p='app/Services/Media/MediaUploadService.php'
s=io.open(p,encoding='utf-8',newline='').read()
s=s.replace("        $existing = MediaFile::query()\n            ->where('company_id', $companyId)\n","        $existing = MediaFile::query()\n",1)
io.open(p,'w',encoding='utf-8',newline='').write(s)
PY
run "deduplication spans venues"

# 6. Upload authorization removed.
sed -i "s|        Gate::authorize('create', MediaFile::class);||" app/Http/Controllers/Backoffice/MediaController.php
run "anyone may upload"

# 7. Serve authorization removed — cross-tenant read.
sed -i "s|        Gate::authorize('view', \$media);||" app/Http/Controllers/Backoffice/MediaController.php
run "any venue image served to anyone"

# 8. Product ownership check made permissive.
python - <<'PY'
import io
p='app/Http/Controllers/Backoffice/ProductController.php'
s=io.open(p,encoding='utf-8',newline='').read()
s=s.replace("                if (! $ours) {","                if (false) {",1)
io.open(p,'w',encoding='utf-8',newline='').write(s)
PY
run "foreign image attaches to a product"

# 9. Everything lands on the public disk.
sed -i "s|\$disk = \$public ? 'public' : 'local';|\$disk = 'public';|" app/Services/Media/MediaUploadService.php
run "receipt logo written to the public disk"
