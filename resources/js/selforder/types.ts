import type { SelfOrderMode, SelfOrderPayAfter, SelfOrderServiceMode, TaxDisplay } from '@domain/enums';

/**
 * The public self-order wire contract — `docs/spec/05-api-contract.md` §10, transcribed.
 *
 * Everything here is what an *anonymous* client is allowed to see. The absences are as load-bearing
 * as the fields: no employees, no devices, no printers, no costs, no margins, no internal notes and
 * no other table's QR identifier (spec §10). If a shape here grows a field that is not in the
 * contract, that is a leak, not a feature.
 */

export type SelfOrderConfig = {
    mode: SelfOrderMode;
    service_mode: SelfOrderServiceMode;
    pay_after: SelfOrderPayAfter;
    ordering_open: boolean;
    brand_name: string | null;
    primary_color: string | null;
    text_color: string | null;
    kiosk_idle_seconds: number;
    kiosk_confirmation_seconds: number;
    online_payment_method_id: number | null;
    custom_links: Array<{
        id: number;
        name: string;
        url: string;
        style: string;
        open_in_new_tab: boolean;
    }>;
};

export type SelfOrderTable = {
    id: number;
    name: string;
    table_number: number | string;
    seats: number;
};

/** Raw rows the menu payload carries. Only the columns this app actually reads are typed. */
export type MenuData = {
    currencies?: Array<{
        id: number;
        symbol: string;
        iso_code: string;
        decimal_places: number;
        rounding: string;
        symbol_position: 'before' | 'after';
        thousands_separator: string;
        decimal_separator: string;
    }>;
    taxes?: Array<{
        id: number;
        name: string;
        amount_type: 'percent' | 'fixed' | 'division' | 'group';
        amount: string;
        tax_group_id: number;
        price_include: boolean;
        include_base_amount: boolean;
        is_base_affected: boolean;
        sequence: number;
        children_tax_ids?: number[];
    }>;
    pos_categories?: Array<{
        id: number;
        name: string;
        parent_id: number | null;
        sequence: number;
        self_order_visible: boolean;
        hour_after: number | null;
        hour_until: number | null;
        has_image?: boolean;
    }>;
    products?: Array<{
        id: number;
        name: string;
        list_price: string;
        tax_ids: number[];
        pos_category_ids: number[];
        tag_ids?: number[];
        combo_ids?: number[];
        available_in_pos: boolean;
        self_order_available: boolean;
        public_description: string | null;
        description_sale?: string | null;
        has_image?: boolean;
        image_media_id?: number | null;
        pos_sequence?: number;
        attribute_count?: number;
        active?: boolean;
    }>;
    product_variants?: Array<{
        id: number;
        product_id: number;
        display_name: string;
        price_extra: string;
        list_price: string | null;
        tax_ids: number[] | null;
        self_order_available: boolean;
        is_active_combination: boolean;
        attribute_line_value_ids: number[];
        active?: boolean;
    }>;
    product_attributes?: Array<{
        id: number;
        name: string;
        display_type: string;
        create_variant: 'always' | 'dynamic' | 'no_variant';
        sequence: number;
    }>;
    product_attribute_values?: Array<{
        id: number;
        product_attribute_id: number;
        name: string;
        html_color: string | null;
        is_custom: boolean;
        sequence: number;
    }>;
    product_attribute_lines?: Array<{
        id: number;
        product_id: number;
        product_attribute_id: number;
        is_required: boolean;
        sequence: number;
    }>;
    product_attribute_line_values?: Array<{
        id: number;
        product_attribute_line_id: number;
        product_attribute_value_id: number;
        product_id: number;
        price_extra: string;
        sequence: number;
        active?: boolean;
    }>;
    product_tags?: Array<{ id: number; name: string; visible_to_customers: boolean; pos_description: string | null }>;
    /**
     * Public image URLs. Menu images are downloadable without auth by design (SLF-024) — a
     * deliberate policy decision, not an accident — and the URL is data, never a path this client
     * constructs for itself.
     */
    media_files?: Array<{
        id: number;
        model: string;
        model_id: number;
        collection: string;
        url: string;
        variants?: Record<string, string>;
    }>;
    combos?: Array<{
        id: number;
        name: string;
        base_price: string;
        qty_free: number;
        qty_max: number;
        sequence: number;
    }>;
    combo_items?: Array<{
        id: number;
        combo_id: number;
        product_variant_id: number;
        extra_price: string;
        sequence: number;
    }>;
    pos_presets?: Array<{
        id: number;
        name: string;
        service_at: 'counter' | 'table' | 'delivery';
        identification: 'none' | 'name' | 'address';
        available_in_self: boolean;
        sequence: number;
    }>;
    pos_config?:
        | {
              id: number;
              name: string;
              currency_id: number;
              iface_tax_included: TaxDisplay;
              tax_rounding_method?: 'round_per_line' | 'round_globally';
              access_token?: string;
          }
        | Array<{
              id: number;
              name: string;
              currency_id: number;
              iface_tax_included: TaxDisplay;
              tax_rounding_method?: 'round_per_line' | 'round_globally';
              access_token?: string;
          }>;
    pos_session?: { id: number; state: string } | Array<{ id: number; state: string }> | null;
};

/** `GET /api/self-order/{configToken}/menu` */
export type MenuResponse = {
    server_time: string;
    config_revision: number;
    profile: string;
    data: MenuData;
    self_order: SelfOrderConfig;
    table: SelfOrderTable | null;
};

/** `SelfOrderStatus` (spec §10). The only order shape a customer ever sees. */
export type SelfOrderStatus = {
    uuid: string;
    access_token: string;
    state: 'draft' | 'paid' | 'done' | 'cancelled';
    prep_state: string | null;
    tracking_number: string | null;
    table_stand_number: string | null;
    amount_untaxed: string;
    amount_tax: string;
    amount_total: string;
    amount_paid: string;
    amount_due: string;
    lines: Array<{
        uuid: string;
        full_product_name: string;
        quantity: string;
        price_unit: string;
        price_subtotal_incl: string;
        customer_note: string | null;
    }>;
    server_time: string;
};

export type SubmitOrderResponse = {
    order: SelfOrderStatus;
    appended: boolean;
    access_token: string;
    warnings: Array<{ code: string; message?: string }>;
};

export type PaymentIntent = {
    reference: string;
    provider_reference: string;
    state: string;
    redirect_url: string | null;
    amount: string;
};

export type PaymentConfirmation = {
    state: string;
    order: SelfOrderStatus;
};

/**
 * Customer-facing preparation status (SLF-083).
 *
 * Derived, never sent as-is: the server exposes `state` and `prep_state`, and this is the three-step
 * ladder a customer understands. Odoo has no equivalent — it is the main reason customers scan the
 * QR a second time.
 */
export type TrackingStep = 'received' | 'preparing' | 'ready' | 'done' | 'cancelled';

/** An order this browser knows about, kept for the history screen (SLF-081). */
export type KnownOrder = {
    uuid: string;
    accessToken: string;
    trackingNumber: string | null;
    total: string;
    state: SelfOrderStatus['state'];
    step: TrackingStep;
    placedAt: number;
    updatedAt: number;
};
