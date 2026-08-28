<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\CatalogImport;

use App\Models\Catalog\PosCategory;
use App\Models\Catalog\Product;
use App\Models\Identity\Customer;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * Bringing a catalogue in from a spreadsheet (BOF-093, BAN-491).
 *
 * Every DataTable and report exports to CSV and nothing imported, so onboarding a venue with a
 * 300-item menu meant 300 manual creations.
 */
beforeEach(function (): void {
    $this->other = PosFixtures::make();

    $this->fx = PosFixtures::make();
    $this->actingAs($this->fx->userWith(
        'backoffice.access',
        'catalog.view',
        'catalog.manage_products',
        'backoffice.manage_customers',
    ));
});

/** A real file on disk: `createWithContent` reports its mime from the *name*, which is a trap. */
function csv(string $body): UploadedFile
{
    $path = tempnam(sys_get_temp_dir(), 'import').'.csv';
    file_put_contents($path, $body);

    return new UploadedFile($path, 'catalogue.csv', 'text/csv', null, true);
}

function preview(string $entity, string $body): TestResponse
{
    return test()->post('/catalog-import/preview', ['entity' => $entity, 'file' => csv($body)]);
}

function commit(string $entity, string $body): TestResponse
{
    return test()->post('/catalog-import', ['entity' => $entity, 'file' => csv($body)]);
}

const MENU = "name,default_code,list_price\nCafé,CAF-1,2.50\nThé,THE-1,3.00\n";

it('shows what a file would do without writing anything', function (): void {
    preview('products', MENU)
        ->assertSessionHasNoErrors()
        ->assertSessionHas('import', fn (array $import): bool => $import['creates'] === 2
            && $import['updates'] === 0
            && $import['errors'] === 0
            && $import['committed'] === false);

    expect(Product::query()->where('default_code', 'CAF-1')->exists())->toBeFalse();
});

it('imports the file once it is committed', function (): void {
    commit('products', MENU)->assertSessionHasNoErrors();

    expect(Product::query()->where('default_code', 'CAF-1')->value('name'))->toBe('Café')
        ->and((float) Product::query()->where('default_code', 'THE-1')->value('list_price'))->toBe(3.0);
});

it('updates in place when the corrected file is uploaded again', function (): void {
    // The point of the whole feature: fix two rows of a 300-row file, upload the whole file, and get
    // 300 products rather than 600.
    commit('products', MENU)->assertSessionHasNoErrors();

    commit('products', "name,default_code,list_price\nCafé,CAF-1,2.80\nThé,THE-1,3.00\n")
        ->assertSessionHas('import', fn (array $import): bool => $import['creates'] === 0
            && $import['updates'] === 2);

    // Two rows in, two products — not four. Counting the imported references rather than every
    // product, because the fixture brings its own catalogue and a total is a number that changes
    // whenever the fixture does.
    expect(Product::query()->whereIn('default_code', ['CAF-1', 'THE-1'])->count())->toBe(2)
        ->and((float) Product::query()->where('default_code', 'CAF-1')->value('list_price'))->toBe(2.8);
});

it('names the line of every bad row', function (): void {
    // Counting the header and from 1, because that is the number the operator types into their
    // spreadsheet to find it.
    preview('products', "name,default_code,list_price\n,CAF-1,2.50\nThé,THE-1,3.00\n")
        ->assertSessionHas('import', function (array $import): bool {
            $errors = array_values(array_filter($import['rows'], fn (array $row): bool => $row['action'] === 'error'));

            return count($errors) === 1 && $errors[0]['line'] === 2;
        });
});

it('writes nothing at all when one row is bad', function (): void {
    // A half-imported catalogue is worse than none: the operator cannot tell which half went in, and
    // re-uploading the fixed file leaves the idempotent key as the only thing between them and a
    // duplicate menu.
    commit('products', "name,default_code,list_price\nCafé,CAF-1,2.50\n,THE-1,3.00\n")
        ->assertSessionHasErrors('file');

    expect(Product::query()->where('default_code', 'CAF-1')->exists())->toBeFalse();
});

it('refuses a row the interactive form would refuse, with the same message', function (): void {
    // The rule set is literally the one `ProductController` uses — `ProductRules` was lifted out of
    // it for this. An import that validated more loosely would be a second, quieter way into the
    // catalogue.
    $formError = test()->post('/products', ['name' => 'Café', 'list_price' => '-5'])
        ->assertSessionHasErrors('list_price')
        ->getSession()->get('errors')->get('list_price')[0];

    preview('products', "name,default_code,list_price\nCafé,CAF-1,-5\n")
        ->assertSessionHas('import', fn (array $import): bool => $import['errors'] === 1
            && in_array($formError, $import['rows'][0]['messages'], true));
});

it('refuses two rows of one file claiming the same reference', function (): void {
    // A copy-paste error in a spreadsheet. Without this the second row silently overwrites the
    // first: the file imports cleanly and one product is missing.
    commit('products', "name,default_code,list_price\nCafé,CAF-1,2.50\nThé,CAF-1,3.00\n")
        ->assertSessionHasErrors('file');

    expect(Product::query()->where('default_code', 'CAF-1')->exists())->toBeFalse();
});

it('does not let rows with no reference claim each other', function (): void {
    // A blank key must never match, or a 300-line menu with no references imports as one product.
    commit('products', "name,list_price\nCafé,2.50\nThé,3.00\n")
        ->assertSessionHasNoErrors();

    expect(Product::query()->whereIn('name', ['Café', 'Thé'])->count())->toBe(2);
});

it('does not match a reference another venue uses', function (): void {
    // Matching unscoped would hand us their row to overwrite.
    Product::query()->create([
        'company_id' => $this->other->company->getKey(),
        'name' => 'Leur café',
        'default_code' => 'CAF-1',
        'uom_id' => $this->fx->product->uom_id,
        'list_price' => '9.00',
    ]);

    commit('products', MENU)->assertSessionHasNoErrors();

    expect(Product::query()->where('default_code', 'CAF-1')->value('name'))->toBe('Café')
        ->and((float) Product::query()->withoutGlobalScopes()
            ->where('company_id', $this->other->company->getKey())
            ->where('default_code', 'CAF-1')->value('list_price'))->toBe(9.0);
});

it('reads the spreadsheet spellings of yes', function (): void {
    // A CSV has no types, and a boolean arrives as whatever the spreadsheet felt like.
    commit('products', "name,default_code,available_in_pos\nCafé,CAF-1,oui\nThé,THE-1,FALSE\n")
        ->assertSessionHasNoErrors();

    expect((bool) Product::query()->where('default_code', 'CAF-1')->value('available_in_pos'))->toBeTrue()
        ->and((bool) Product::query()->where('default_code', 'THE-1')->value('available_in_pos'))->toBeFalse();
});

it('survives the byte Excel puts in front of the first column', function (): void {
    // A UTF-8 BOM turns `name` into a column the importer does not recognise, on the one field every
    // entity requires — so every row fails for a missing name that is plainly there.
    commit('products', "\u{FEFF}name,default_code,list_price\nCafé,CAF-1,2.50\n")
        ->assertSessionHasNoErrors();

    expect(Product::query()->where('default_code', 'CAF-1')->exists())->toBeTrue();
});

it('treats an emptied cell as no value rather than a value of nothing', function (): void {
    commit('products', "name,default_code,description_sale\nCafé,CAF-1,\n")
        ->assertSessionHasNoErrors();

    expect(Product::query()->where('default_code', 'CAF-1')->value('description_sale'))->toBeNull();
});

it('refuses a file with a header and no rows', function (): void {
    commit('products', "name,default_code,list_price\n")->assertSessionHasErrors('file');
});

it('imports customers with the rules the customer form uses', function (): void {
    // `CustomerRequest` is reused directly here, which is why its marketing rule applies: consent
    // with no email and no mobile can never be acted on.
    commit('customers', "name,email,marketing_opt_in\nMarie,marie@example.test,oui\n")
        ->assertSessionHasNoErrors();

    expect(Customer::query()->where('name', 'Marie')->exists())->toBeTrue();

    commit('customers', "name,marketing_opt_in\nPaul,oui\n")->assertSessionHasErrors('file');

    expect(Customer::query()->where('name', 'Paul')->exists())->toBeFalse();
});

it('imports POS categories', function (): void {
    commit('pos_categories', "name,sequence\nBoissons,10\nDesserts,20\n")
        ->assertSessionHasNoErrors();

    expect(PosCategory::query()->whereIn('name', ['Boissons', 'Desserts'])->count())->toBe(2);
});

it('hands the operator the header rather than asking them to transcribe it', function (): void {
    $body = test()->get('/catalog-import/products/template')->assertOk()->streamedContent();

    expect($body)->toContain('name')->toContain('default_code');
});

it('refuses a template for an entity that does not import', function (): void {
    test()->get('/catalog-import/floors/template')->assertNotFound();
});

it('refuses the whole thing to someone who may not create products', function (): void {
    $this->actingAs($this->fx->userWith('backoffice.access', 'catalog.view'));

    commit('products', MENU)->assertForbidden();
});

it('lists what can be imported and what each file needs', function (): void {
    test()->withoutVite();

    test()->get('/catalog-import')
        ->assertOk()
        ->assertInertia(fn ($page) => $page
            ->where('entities', fn ($rows) => collect($rows)->pluck('key')->contains('products'))
            ->has('maxRows')
            ->etc());
});

it('leaves an imported product sellable', function (): void {
    // The register sells *variants*, not products. A product imported without one is in the
    // catalogue, visible in the back office, and cannot be rung up at all — a 300-item menu where
    // nothing is sellable, and every screen saying it worked. `ProductController::store` creates the
    // default variant, so the importer has to as well.
    commit('products', MENU)->assertSessionHasNoErrors();

    $product = Product::query()->where('default_code', 'CAF-1')->firstOrFail();

    expect($product->variants()->count())->toBe(1)
        ->and((string) $product->variants()->value('display_name'))->toBe('Café')
        ->and((float) $product->variants()->first()->effectivePrice())->toBe(2.5);
});
