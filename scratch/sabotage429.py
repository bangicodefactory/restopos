"""Sabotage each guard, confirm a test fails, restore from a snapshot (never `git checkout --`)."""
import io
import os
import shutil
import subprocess
import tempfile

REQ = 'app/Http/Requests/Backoffice/PresetRequest.php'
WIN = 'app/Http/Requests/Backoffice/ServiceWindowRequest.php'
CTL = 'app/Http/Controllers/Backoffice/PresetController.php'
SLOT = 'app/Services/Pos/PresetSlotService.php'

FILES = {REQ, WIN, CTL, SLOT}

SABOTAGES = [
    ('ownership check removed', REQ,
     "            if (! $model::query()->whereKey((int) $value)->exists()) {",
     "            if (false) {"),
    ('zero slots allowed', REQ,
     "        if ($this->has('slots_per_interval') && (int) $this->input('slots_per_interval') < 1) {",
     "        if (false) {"),
    ('zero-minute interval allowed', REQ,
     "        if ($this->has('interval_minutes') && (int) $this->input('interval_minutes') < 1) {",
     "        if (false) {"),
    ('hours may close before they open', WIN,
     "        if ((float) $to <= (float) $from) {",
     "        if (false) {"),
    ('overlapping hours allowed', WIN,
     "            if ((float) $from < (float) $window->hour_to && (float) $window->hour_from < (float) $to) {",
     "            if (false) {"),
    ('overlap check ignores the day', WIN,
     "            ->where('day_of_week', (int) $day)",
     "            ->where('day_of_week', '>=', 0)"),
    ('system mode deletable', CTL,
     "        if ($preset->is_system) {",
     "        if (false) {"),
    ('delete ignores orders', CTL,
     "        if ($orders > 0) {",
     "        if (false) {"),
    ('delete ignores registers opening on it', CTL,
     "        if ($defaults > 0) {\n            throw ValidationException::withMessages([\n                'preset' => 'This mode is the default on '",
     "        if (false) {\n            throw ValidationException::withMessages([\n                'preset' => 'This mode is the default on '"),
    ('deactivation guard removed', CTL,
     "        if (! array_key_exists('active', $data) || (bool) $data['active'] === true) {\n            return;\n        }",
     "        if (true) {\n            return;\n        }"),
    ('foreign window reachable', CTL,
     "        abort_unless((int) $window->pos_preset_id === (int) $preset->getKey(), 404);",
     "        abort_unless(true, 404);"),
    ('is_system settable through the form', CTL,
     "            'is_system' => false,",
     "            'is_system' => (bool) request()->boolean('is_system'),"),
    ('index ships no price lists', CTL,
     "            'pricelists' => Pricelist::query()->where('active', true)->orderBy('name')\n                ->get(['id', 'name'])->all(),\n            'fiscalPositions' => FiscalPosition::query()->orderBy('name')->get(['id', 'name'])->all(),\n        ]);\n    }\n\n    public function edit",
     "            'pricelists' => [],\n            'fiscalPositions' => FiscalPosition::query()->orderBy('name')->get(['id', 'name'])->all(),\n        ]);\n    }\n\n    public function edit"),
    ('edit ships no hours', CTL,
     "            'windows' => $preset->serviceWindows()",
     "            'windows' => $preset->serviceWindows()->whereRaw('0 = 1')"),
    ('hours never gate a booking', SLOT,
     "        if (! $this->isOpenAt($preset, $moment)) {",
     "        if (false) {"),
    ('capacity never gates a booking', SLOT,
     "        if ($this->isFullAt($preset, $moment)) {",
     "        if (false) {"),
    ('a day with no hours reads as open', SLOT,
     "        if ($preset->serviceWindows()->doesntExist()) {",
     "        if ($preset->serviceWindows()->where('day_of_week', ($moment->dayOfWeek + 6) % 7)->doesntExist()) {"),
    ('cancelled orders hold a slot', SLOT,
     "            ->where('state', '!=', OrderState::Cancelled->value)",
     "            ->whereNotNull('state')"),
    ('buckets anchored to the hour, not the interval', SLOT,
     "        $bucketStart = intdiv($minutesIntoDay, $intervalMinutes) * $intervalMinutes;",
     "        $bucketStart = intdiv($minutesIntoDay, 60) * 60;"),
    ('bucket end overlaps the next one', SLOT,
     "        return [$start, $start->copy()->addMinutes($intervalMinutes)->subSecond()];",
     "        return [$start, $start->copy()->addMinutes($intervalMinutes)];"),
    ('day-of-week offset dropped', SLOT,
     "            ->where('day_of_week', ($moment->dayOfWeek + 6) % 7)\n            ->get();",
     "            ->where('day_of_week', $moment->dayOfWeek)\n            ->get();"),
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

    r = subprocess.run(['php', 'artisan', 'test', '--filter=PresetCrud'], capture_output=True, text=True)
    restore()

    verdict = 'CAUGHT' if r.returncode != 0 else 'MISSED'
    results.append((name, verdict))
    print(f'{verdict:16} {name}', flush=True)

shutil.rmtree(snapshot)
print()
print('NOT CAUGHT:', [n for n, v in results if v != 'CAUGHT'] or 'none')
