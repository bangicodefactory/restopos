import { buildCatalog, type Catalog } from '../catalog';
import type { MenuData, MenuResponse, SelfOrderConfig } from '../types';

/**
 * One small, complete venue, shared by every unit test in this folder.
 *
 * Built by running a realistic payload through the real `buildCatalog`, rather than hand-assembling
 * a `Catalog` literal: that way the indexing code is exercised by every test too, and a payload
 * shape change cannot pass the suite while breaking the app.
 *
 * The numbers are chosen to be awkward on purpose — a 21 % price-included VAT and a `9.99` combo
 * split across two components — because those are the cases where a naive implementation is a cent
 * out.
 */

export const MENU_DATA: MenuData = {
    currencies: [
        {
            id: 1,
            symbol: '€',
            iso_code: 'EUR',
            decimal_places: 2,
            rounding: '0.01',
            symbol_position: 'after',
            thousands_separator: ' ',
            decimal_separator: ',',
        },
    ],
    taxes: [
        {
            id: 1,
            name: 'TVA 21%',
            amount_type: 'percent',
            amount: '21',
            tax_group_id: 1,
            price_include: true,
            include_base_amount: false,
            is_base_affected: true,
            sequence: 1,
        },
        {
            id: 2,
            name: 'TVA 6%',
            amount_type: 'percent',
            amount: '6',
            tax_group_id: 2,
            price_include: true,
            include_base_amount: false,
            is_base_affected: true,
            sequence: 2,
        },
    ],
    pos_categories: [
        {
            id: 10,
            name: 'Pizzas',
            parent_id: null,
            sequence: 1,
            self_order_visible: true,
            hour_after: null,
            hour_until: null,
        },
        {
            id: 20,
            name: 'Boissons',
            parent_id: null,
            sequence: 2,
            self_order_visible: true,
            hour_after: null,
            hour_until: null,
        },
        {
            id: 30,
            name: 'Petit-déjeuner',
            parent_id: null,
            sequence: 3,
            self_order_visible: true,
            hour_after: 6,
            hour_until: 11,
        },
        {
            id: 40,
            name: 'Menus',
            parent_id: null,
            sequence: 4,
            self_order_visible: true,
            hour_after: null,
            hour_until: null,
        },
    ],
    products: [
        {
            id: 100,
            name: 'Margherita',
            list_price: '12.00',
            tax_ids: [1],
            pos_category_ids: [10],
            available_in_pos: true,
            self_order_available: true,
            public_description: 'Tomate, mozzarella, basilic',
            pos_sequence: 1,
        },
        {
            id: 101,
            name: 'Quattro Formaggi',
            list_price: '14.00',
            tax_ids: [1],
            pos_category_ids: [10],
            available_in_pos: true,
            self_order_available: true,
            public_description: null,
            pos_sequence: 2,
        },
        {
            id: 102,
            name: 'Calzone',
            list_price: '13.00',
            tax_ids: [1],
            pos_category_ids: [10],
            available_in_pos: true,
            // 86'd
            self_order_available: false,
            public_description: null,
            pos_sequence: 3,
        },
        {
            id: 200,
            name: 'Coca',
            list_price: '3.00',
            tax_ids: [2],
            pos_category_ids: [20],
            available_in_pos: true,
            self_order_available: true,
            public_description: null,
            pos_sequence: 1,
        },
        {
            id: 201,
            name: 'Eau',
            list_price: '2.00',
            tax_ids: [2],
            pos_category_ids: [20],
            available_in_pos: true,
            self_order_available: true,
            public_description: null,
            pos_sequence: 2,
        },
        {
            id: 300,
            name: 'Croissant',
            list_price: '2.50',
            tax_ids: [2],
            pos_category_ids: [30],
            available_in_pos: true,
            self_order_available: true,
            public_description: null,
            pos_sequence: 1,
        },
        {
            id: 400,
            name: 'Menu Midi',
            list_price: '9.99',
            tax_ids: [1],
            pos_category_ids: [40],
            combo_ids: [1, 2],
            available_in_pos: true,
            self_order_available: true,
            public_description: null,
            pos_sequence: 1,
        },
    ],
    product_variants: [
        {
            id: 9100,
            product_id: 100,
            display_name: 'Margherita',
            price_extra: '0',
            list_price: null,
            tax_ids: null,
            self_order_available: true,
            is_active_combination: true,
            attribute_line_value_ids: [],
        },
        {
            id: 9101,
            product_id: 101,
            display_name: 'Quattro Formaggi',
            price_extra: '0',
            list_price: null,
            tax_ids: null,
            self_order_available: true,
            is_active_combination: true,
            attribute_line_value_ids: [],
        },
        {
            id: 9102,
            product_id: 102,
            display_name: 'Calzone',
            price_extra: '0',
            list_price: null,
            tax_ids: null,
            self_order_available: true,
            is_active_combination: true,
            attribute_line_value_ids: [],
        },
        // Coca has a real variant axis: 33 cl / 50 cl (`always` → two product variants).
        {
            id: 9200,
            product_id: 200,
            display_name: 'Coca 33cl',
            price_extra: '0',
            list_price: null,
            tax_ids: null,
            self_order_available: true,
            is_active_combination: true,
            attribute_line_value_ids: [5001],
        },
        {
            id: 9201,
            product_id: 200,
            display_name: 'Coca 50cl',
            price_extra: '1.00',
            list_price: null,
            tax_ids: null,
            self_order_available: true,
            is_active_combination: true,
            attribute_line_value_ids: [5002],
        },
        {
            id: 9202,
            product_id: 201,
            display_name: 'Eau',
            price_extra: '0',
            list_price: null,
            tax_ids: null,
            self_order_available: true,
            is_active_combination: true,
            attribute_line_value_ids: [],
        },
        {
            id: 9300,
            product_id: 300,
            display_name: 'Croissant',
            price_extra: '0',
            list_price: null,
            tax_ids: null,
            self_order_available: true,
            is_active_combination: true,
            attribute_line_value_ids: [],
        },
        {
            id: 9400,
            product_id: 400,
            display_name: 'Menu Midi',
            price_extra: '0',
            list_price: null,
            tax_ids: null,
            self_order_available: true,
            is_active_combination: true,
            attribute_line_value_ids: [],
        },
    ],
    product_attributes: [
        { id: 50, name: 'Taille', display_type: 'pills', create_variant: 'always', sequence: 1 },
        { id: 60, name: 'Supplément', display_type: 'multi', create_variant: 'no_variant', sequence: 2 },
    ],
    product_attribute_values: [
        { id: 500, product_attribute_id: 50, name: '33cl', html_color: null, is_custom: false, sequence: 1 },
        { id: 501, product_attribute_id: 50, name: '50cl', html_color: null, is_custom: false, sequence: 2 },
        { id: 600, product_attribute_id: 60, name: 'Extra fromage', html_color: null, is_custom: false, sequence: 1 },
        { id: 601, product_attribute_id: 60, name: 'Piment', html_color: null, is_custom: false, sequence: 2 },
    ],
    product_attribute_lines: [
        { id: 700, product_id: 200, product_attribute_id: 50, is_required: true, sequence: 1 },
        { id: 701, product_id: 100, product_attribute_id: 60, is_required: false, sequence: 1 },
    ],
    product_attribute_line_values: [
        { id: 5001, product_attribute_line_id: 700, product_attribute_value_id: 500, product_id: 200, price_extra: '0', sequence: 1 },
        { id: 5002, product_attribute_line_id: 700, product_attribute_value_id: 501, product_id: 200, price_extra: '1.00', sequence: 2 },
        { id: 6001, product_attribute_line_id: 701, product_attribute_value_id: 600, product_id: 100, price_extra: '2.00', sequence: 1 },
        { id: 6002, product_attribute_line_id: 701, product_attribute_value_id: 601, product_id: 100, price_extra: '0', sequence: 2 },
    ],
    combos: [
        // Choice 1: a pizza. Two options, one free pick.
        { id: 1, name: 'Plat', base_price: '10.00', qty_free: 1, qty_max: 1, sequence: 1 },
        // Choice 2: a drink. Two options, one free, up to two picks.
        { id: 2, name: 'Boisson', base_price: '2.00', qty_free: 1, qty_max: 2, sequence: 2 },
    ],
    combo_items: [
        { id: 11, combo_id: 1, product_variant_id: 9100, extra_price: '0', sequence: 1 },
        { id: 12, combo_id: 1, product_variant_id: 9101, extra_price: '1.50', sequence: 2 },
        { id: 21, combo_id: 2, product_variant_id: 9202, extra_price: '0', sequence: 1 },
        { id: 22, combo_id: 2, product_variant_id: 9200, extra_price: '0.50', sequence: 2 },
        { id: 23, combo_id: 2, product_variant_id: 9201, extra_price: '1.00', sequence: 3 },
    ],
    pos_presets: [
        { id: 1, name: 'Sur place', service_at: 'table', identification: 'none', available_in_self: true, sequence: 1 },
        { id: 2, name: 'À emporter', service_at: 'counter', identification: 'none', available_in_self: true, sequence: 2 },
    ],
    pos_config: {
        id: 1,
        name: 'Trattoria',
        currency_id: 1,
        iface_tax_included: 'total',
        tax_rounding_method: 'round_per_line',
    },
    pos_session: { id: 881, state: 'opened' },
};

export const SELF_ORDER_CONFIG: SelfOrderConfig = {
    mode: 'mobile',
    service_mode: 'table',
    pay_after: 'meal',
    ordering_open: true,
    brand_name: 'Trattoria',
    primary_color: '#8B1E1E',
    text_color: '#FFFFFF',
    kiosk_idle_seconds: 90,
    kiosk_confirmation_seconds: 30,
    online_payment_method_id: null,
    custom_links: [],
};

export function menuResponse(overrides: Partial<MenuData> = {}): MenuResponse {
    return {
        server_time: '2026-07-28T12:00:00.000Z',
        config_revision: 1,
        profile: 'self_order',
        data: { ...MENU_DATA, ...overrides },
        self_order: SELF_ORDER_CONFIG,
        table: { id: 4, name: 'T1', table_number: 1, seats: 4 },
    };
}

export function testCatalog(overrides: Partial<MenuData> = {}): Catalog {
    return buildCatalog(menuResponse(overrides));
}

/** Deterministic uuids so a cart assertion can name a line. */
export function sequentialUuids(prefix = 'u'): () => string {
    let counter = 0;
    return () => {
        counter += 1;
        return `${prefix}${counter}`;
    };
}
