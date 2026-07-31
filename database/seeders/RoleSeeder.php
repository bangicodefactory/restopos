<?php

declare(strict_types=1);

namespace Database\Seeders;

use Database\Seeders\Support\Demo;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;

/**
 * The five roles a restaurant actually uses, and the permission rows they hold.
 *
 * `owner` gets every permission by construction, so adding a permission below is
 * enough — the owner never has to be edited.
 */
class RoleSeeder extends Seeder
{
    /** @var array<string, array<string, string>> group => slug => description */
    private const PERMISSIONS = [
        'register' => [
            'pos.open_session' => 'Ouvrir une session de caisse',
            'pos.close_session' => 'Clôturer une session de caisse',
            'pos.sell' => 'Encaisser une commande',
            'pos.refund' => 'Rembourser une commande',
            'pos.manual_discount' => 'Appliquer une remise manuelle',
            'pos.price_override' => 'Modifier le prix d’une ligne',
            'pos.void_line' => 'Supprimer une ligne déjà envoyée',
            'pos.cash_in_out' => 'Enregistrer une entrée / sortie d’espèces',
            'pos.open_drawer' => 'Ouvrir le tiroir-caisse',
            'pos.reprint_receipt' => 'Réimprimer un ticket',
            'pos.view_margins' => 'Voir les marges au comptoir',
        ],
        'restaurant' => [
            'restaurant.manage_floors' => 'Modifier les salles et le plan de tables',
            'restaurant.transfer_table' => 'Transférer une commande de table',
            'restaurant.split_bill' => 'Partager l’addition',
            'restaurant.merge_orders' => 'Fusionner deux commandes',
            'restaurant.print_bill' => 'Imprimer l’addition',
        ],
        'kitchen' => [
            'kitchen.view' => 'Consulter l’écran de préparation',
            'kitchen.advance_stage' => 'Faire avancer une commande de colonne',
            'kitchen.recall_order' => 'Rappeler une commande servie',
            'kitchen.manage_displays' => 'Configurer les écrans de préparation',
        ],
        'catalog' => [
            'catalog.view' => 'Consulter le catalogue',
            'catalog.manage_products' => 'Créer et modifier des produits',
            'catalog.manage_categories' => 'Gérer les catégories point de vente',
            'catalog.manage_pricelists' => 'Gérer les listes de prix',
            'catalog.manage_taxes' => 'Gérer les taxes et positions fiscales',
        ],
        'loyalty' => [
            'loyalty.view' => 'Consulter les cartes de fidélité',
            'loyalty.manage_programs' => 'Gérer les programmes de fidélité',
            'loyalty.issue_gift_card' => 'Émettre une carte cadeau',
        ],
        'backoffice' => [
            'backoffice.access' => 'Accéder au back-office',
            'backoffice.view_reports' => 'Consulter les rapports de vente',
            'backoffice.manage_employees' => 'Gérer les employés et les rôles',
            'backoffice.manage_configs' => 'Gérer les points de vente',
            'backoffice.manage_company' => 'Modifier les informations de la société',
            'backoffice.export_accounting' => 'Exporter vers la comptabilité',
        ],
    ];

    /** @var array<string, array{name: string, description: string, permissions: list<string>}> */
    private const ROLES = [
        'owner' => [
            'name' => 'Propriétaire',
            'description' => 'Accès complet, y compris la comptabilité et la configuration.',
            'permissions' => ['*'],
        ],
        'manager' => [
            'name' => 'Responsable de salle',
            'description' => 'Pilote le service, la caisse et le catalogue au quotidien.',
            'permissions' => [
                'pos.open_session', 'pos.close_session', 'pos.sell', 'pos.refund',
                'pos.manual_discount', 'pos.price_override', 'pos.void_line',
                'pos.cash_in_out', 'pos.open_drawer', 'pos.reprint_receipt', 'pos.view_margins',
                'restaurant.manage_floors', 'restaurant.transfer_table', 'restaurant.split_bill',
                'restaurant.merge_orders', 'restaurant.print_bill',
                'kitchen.view', 'kitchen.advance_stage', 'kitchen.recall_order',
                'catalog.view', 'catalog.manage_products', 'catalog.manage_categories',
                'catalog.manage_pricelists',
                'loyalty.view', 'loyalty.manage_programs', 'loyalty.issue_gift_card',
                'backoffice.access', 'backoffice.view_reports', 'backoffice.manage_employees',
            ],
        ],
        'cashier' => [
            'name' => 'Caissier',
            'description' => 'Encaisse, rembourse sous contrôle et clôture sa caisse.',
            'permissions' => [
                'pos.open_session', 'pos.close_session', 'pos.sell', 'pos.refund',
                'pos.open_drawer', 'pos.reprint_receipt',
                'restaurant.split_bill', 'restaurant.print_bill',
                'catalog.view', 'loyalty.view',
            ],
        ],
        'waiter' => [
            'name' => 'Serveur',
            'description' => 'Prend les commandes en salle et envoie en cuisine.',
            'permissions' => [
                'pos.sell', 'pos.reprint_receipt',
                'restaurant.transfer_table', 'restaurant.split_bill', 'restaurant.print_bill',
                'kitchen.view',
                'catalog.view', 'loyalty.view',
            ],
        ],
        'kitchen' => [
            'name' => 'Cuisine',
            'description' => 'Écran de préparation uniquement.',
            'permissions' => [
                'kitchen.view', 'kitchen.advance_stage', 'kitchen.recall_order',
                'catalog.view',
            ],
        ],
    ];

    public function run(): void
    {
        Demo::reseed('roles');
        $now = Demo::ts(Demo::clock());

        $permissionIds = $this->seedPermissions($now);

        foreach (self::ROLES as $slug => $definition) {
            $roleId = DB::table('roles')->where('slug', $slug)->value('id');
            if ($roleId === null) {
                $roleId = DB::table('roles')->insertGetId([
                    'name' => $definition['name'],
                    'slug' => $slug,
                    'description' => $definition['description'],
                    'is_system' => true,
                    'created_at' => $now,
                    'updated_at' => $now,
                ]);
            }

            $slugs = $definition['permissions'] === ['*']
                ? array_keys($permissionIds)
                : $definition['permissions'];

            $existing = DB::table('permission_role')->where('role_id', $roleId)->pluck('permission_id')->all();

            $payload = [];
            foreach ($slugs as $permissionSlug) {
                $permissionId = $permissionIds[$permissionSlug];
                if (! in_array($permissionId, $existing, true)) {
                    $payload[] = ['role_id' => (int) $roleId, 'permission_id' => $permissionId];
                }
            }
            if ($payload !== []) {
                DB::table('permission_role')->insert($payload);
            }
        }
    }

    /** @return array<string, int> slug => id */
    private function seedPermissions(string $now): array
    {
        $known = DB::table('permissions')->pluck('id', 'slug')->all();

        $payload = [];
        foreach (self::PERMISSIONS as $group => $entries) {
            foreach ($entries as $slug => $description) {
                if (isset($known[$slug])) {
                    continue;
                }
                $payload[] = [
                    'slug' => $slug,
                    'group' => $group,
                    'description' => $description,
                    'created_at' => $now,
                    'updated_at' => $now,
                ];
            }
        }
        if ($payload !== []) {
            DB::table('permissions')->insert($payload);
        }

        /** @var array<string, int> $map */
        $map = DB::table('permissions')->pluck('id', 'slug')->map(static fn ($value): int => (int) $value)->all();

        return $map;
    }
}
